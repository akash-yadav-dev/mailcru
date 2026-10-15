import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { activate, anonymous, as, callApi, catchRedirect, form, platformEmails, signIn, startTestApp } from "./helpers/app.mjs";
import { sent, state } from "./stubs/ses.mjs";
import { dnsRecords } from "./stubs/dns-broker.mjs";

// MailCru Cloud shares its own domain: the dashboard on mailcru.com, MailCru's subdomains next to it (www, r,
// cdn...), and each newsletter's archive and shared address on <slug>.mailcru.com, the same site.
const APP_URL = "https://mailcru.com";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
let app;
let m;
let nextId = 0;

function visit(url) {
	return m.proxy(new m.NextRequest(url, { headers: { host: new URL(url).host } }));
}

// What the proxy decided: render the page asked for, render another one in its place, or answer itself.
function outcome(response) {
	const rewrite = response.headers.get("x-middleware-rewrite");
	if (rewrite) return { rewrite: new URL(rewrite).pathname };
	if (response.headers.get("x-middleware-next")) return { next: true };
	return { status: response.status };
}

async function callTool(key, name, args) {
	const request = new Request(`${APP_URL}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
			authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args }, id: ++nextId }),
	});
	const text = await (await anonymous(() => m.mcpRoute.POST(request))).text();
	return JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6)).result;
}

async function customer(email, slug) {
	const user = await signIn(email);
	await activate(user);
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St, Paris", archiveEnabled: "on" })))
	);
	user.newsletterId = url.split("/").at(-1);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	return user;
}

async function draft(user) {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "This week", body: '<p>Hello <a href="https://example.org">link</a></p>' }));
	return id;
}

function hasRecordsFor(host) {
	return [...dnsRecords.values()].some(({ name }) => name === host || name.endsWith(`.${host}`));
}

function slugsOf(user) {
	return m.Newsletter.find({ accountId: user.accountId }).sort({ createdAt: 1 }).lean().then((newsletters) => newsletters.map(({ slug }) => slug));
}

before(async () => {
	app = await startTestApp({ APP_URL, SHARED_DOMAIN: "mailcru.com" });
	m = {
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		archiveHosts: await import("../lib/archive-hosts.js"),
		siteExtensions: (await import("@/lib/site-extensions")).siteExtensions,
		hostRouting: await import("../lib/host-routing.js"),
		sharedSender: await import("../lib/shared-sender.js"),
		auth: await import("../lib/auth.js"),
		authRoute: await import("../app/api/auth/[...all]/route.js"),
		uploadsRoute: await import("../app/api/uploads/route.js"),
		mcpRoute: await import("../app/mcp/route.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		welcome: await import("../app/welcome/actions.js"),
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

describe("hosts", () => {
	test("mailcru.com, www and MailCru's other subdomains are the app; <slug>.mailcru.com is the newsletter's archive", async () => {
		const resolve = m.hostRouting.resolveArchiveHost;
		const appHosts = [
			"mailcru.com",
			"MailCru.com:443",
			"www.mailcru.com",
			"r.mailcru.com",
			"send.r.mailcru.com",
			"cdn.mailcru.com",
			"api.mailcru.com",
			"mcp.mailcru.com",
			"admin.mailcru.com",
			"localhost:3000",
			"mailcru-git-main-akash-yadav-dev.vercel.app",
		];
		for (const host of appHosts) assert.deepEqual(await resolve(host), { isArchiveHost: false, slug: null }, host);
		assert.deepEqual(await resolve("weekly.mailcru.com"), { isArchiveHost: true, slug: "weekly" });
		assert.deepEqual(await resolve("Field-Notes.MailCru.com:443"), { isArchiveHost: true, slug: "field-notes" });
		assert.deepEqual(await resolve("a.weekly.mailcru.com"), { isArchiveHost: true, slug: null }, "one label deep");
	});

	test("the app answers on its own hosts, and an archive host only opens the archive and its links", async () => {
		// Signed out, / is the marketing site's landing page where MailCru Cloud has one, else sign-in.
		const { landingPath } = m.siteExtensions;
		for (const url of [`${APP_URL}/`, "https://www.mailcru.com/", "https://api.mailcru.com/"]) {
			assert.deepEqual(outcome(await visit(url)), landingPath ? { rewrite: landingPath } : { status: 307 }, url);
		}
		assert.deepEqual(outcome(await visit(`${APP_URL}/signin`)), { next: true });

		assert.deepEqual(outcome(await visit("https://weekly.mailcru.com/")), { rewrite: "/archive/weekly" });
		assert.deepEqual(outcome(await visit("https://weekly.mailcru.com/p/first-issue")), { rewrite: "/archive/weekly/p/first-issue" });
		assert.deepEqual(outcome(await visit("https://weekly.mailcru.com/unsubscribe?token=t")), { next: true });
		for (const path of ["/signin", "/api/auth/get-session", "/api/uploads", "/campaigns", "/mcp", "/api/v1/newsletters"]) {
			assert.deepEqual(outcome(await visit(`https://weekly.mailcru.com${path}`)), { status: 404 }, path);
		}
		assert.equal(m.archiveHosts.getArchiveHostUrl("/archive/weekly/p/first-issue", ""), "https://weekly.mailcru.com/p/first-issue");
	});
});

describe("reserved slugs", () => {
	test("the dashboard, the REST API and MCP refuse a slug MailCru keeps, on create and on update", async () => {
		const user = await customer("reserved@example.com", "reserved-news");
		const refused = (slug) => ({ code: "validation_failed", message: `${slug} is reserved for MailCru, pick another slug` });
		const save = (fields) => as(user, () => m.newsletters.saveNewsletter(null, form({ name: "Notes", postalAddress: "1 Main St, Paris", ...fields })));

		assert.deepEqual(await save({ slug: "www" }), { error: refused("www").message });
		assert.deepEqual(await save({ id: user.newsletterId, slug: "cdn" }), { error: refused("cdn").message });

		const created = await callApi("POST", "/api/v1/newsletters", { key: user.key, body: { name: "R", slug: "r" } });
		assert.deepEqual([created.status, created.body.error], [400, refused("r")]);
		const updated = await callApi("PATCH", `/api/v1/newsletters/${user.newsletterId}`, { key: user.key, body: { slug: "api" } });
		assert.deepEqual([updated.status, updated.body.error], [400, refused("api")]);

		const viaMcp = await callTool(user.key, "update_newsletter", { id: user.newsletterId, slug: "mail" });
		assert.equal(viaMcp.isError, true);
		assert.deepEqual(JSON.parse(viaMcp.content[0].text).error, refused("mail"));

		assert.deepEqual(await slugsOf(user), ["reserved-news"]);
		for (const slug of ["www", "cdn", "r", "api", "mail"]) assert.equal(hasRecordsFor(`${slug}.mailcru.com`), false, slug);
	});

	test("a slug made from the name skips the ones MailCru keeps", async () => {
		const user = await signIn("blog@example.com");
		assert.equal(await as(user, () => catchRedirect(m.welcome.completeOnboarding(null, form({ name: "Blog" })))), "/");
		await activate(user);
		assert.equal(await as(user, () => catchRedirect(m.newsletters.createNewsletter(null, form({ name: "Support" })))), "/newsletters");
		user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
		assert.equal((await callApi("POST", "/api/v1/newsletters", { key: user.key, body: { name: "Status" } })).status, 201);
		assert.deepEqual(await slugsOf(user), ["blog-2", "support-2", "status-2"]);
	});
});

describe("shared addresses", () => {
	test("hello@<slug>.mailcru.com, with its records from the DNS helper and its links on the newsletter's host", async () => {
		const user = await customer("weekly@example.com", "weekly");
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		assert.equal(newsletter.fromEmail, "hello@weekly.mailcru.com");
		const records = newsletter.sharedSender.dnsRecordIds.map((id) => dnsRecords.get(id));
		assert.deepEqual(
			records.map(({ slug, type, name }) => [slug, type, name]),
			[
				["weekly", "CNAME", "tok1._domainkey.weekly.mailcru.com"],
				["weekly", "CNAME", "tok2._domainkey.weekly.mailcru.com"],
				["weekly", "CNAME", "tok3._domainkey.weekly.mailcru.com"],
				["weekly", "MX", "bounce.weekly.mailcru.com"],
				["weekly", "TXT", "bounce.weekly.mailcru.com"],
				["weekly", "CNAME", "weekly.mailcru.com"],
			]
		);

		const id = await draft(user);
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		const email = sent.at(-1);
		assert.equal(email.from, "hello@weekly.mailcru.com");
		assert.match(email.html, /https:\/\/weekly\.mailcru\.com\/c\//);
		assert.match(email.headers["List-Unsubscribe"], /^<https:\/\/weekly\.mailcru\.com\/api\/unsubscribe\?token=/);
	});

	test("a slug saved before MailCru kept it gets no sending subdomain, and the one of its old slug goes", async () => {
		const user = await customer("legacy@example.com", "legacy-news");
		const { sharedSender: old } = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { slug: "r", fromEmail: "hello@r.mailcru.com" } });
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();

		assert.equal(await m.sharedSender.syncSharedSender({ account: user.account, newsletter }), null);
		assert.equal(state.identities.has("r.mailcru.com"), false);
		assert.equal(hasRecordsFor("r.mailcru.com"), false);
		assert.equal(state.identities.has(old.domain), false);
		assert.equal(hasRecordsFor(old.domain), false);
	});

	test("a new slug whose records the DNS helper refuses leaves nothing at the provider, and a later save sets it up", async () => {
		const user = await customer("refused@example.com", "refused-old");
		const { sharedSender: old } = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		dnsRecords.set("rec_by_hand", { id: "rec_by_hand", slug: "by-hand", type: "CNAME", name: "refused-new.mailcru.com", value: "cname.vercel-dns.com" });
		const save = () =>
			as(user, () =>
				m.newsletters.saveNewsletter(null, form({ id: user.newsletterId, name: "Refused", slug: "refused-new", postalAddress: "1 Main St, Paris", archiveEnabled: "on" }))
			);

		assert.equal((await save()).ok, true, "the newsletter is saved either way");
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		assert.deepEqual([newsletter.slug, newsletter.fromEmail, newsletter.sharedSender], ["refused-new", "hello@refused-new.mailcru.com", undefined]);
		assert.equal(state.identities.has("refused-new.mailcru.com"), false, "the domain is taken back at the provider");
		assert.deepEqual([...dnsRecords.values()].filter(({ name }) => name.endsWith("refused-new.mailcru.com")).map(({ id }) => id), ["rec_by_hand"]);
		assert.equal(state.identities.has(old.domain), false);
		assert.equal(hasRecordsFor(old.domain), false);
		assert.ok(
			platformEmails.some(({ subject, text }) => subject === "[MailCru] Shared address not set up" && text.includes("refused-new.mailcru.com")),
			"the admins hear of it"
		);

		dnsRecords.delete("rec_by_hand");
		assert.equal((await save()).ok, true);
		const { sharedSender } = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		assert.equal(sharedSender.domain, "refused-new.mailcru.com");
		assert.ok(state.identities.has("refused-new.mailcru.com"));
		assert.ok(sharedSender.dnsRecordIds.every((id) => dnsRecords.get(id)?.slug === "refused-new"));
	});
});

describe("sessions", () => {
	test("the session cookie is host-only, and Better Auth trusts mailcru.com's origin alone", async () => {
		const context = await (await m.auth.getAuth()).$context;
		const { name, attributes } = context.authCookies.sessionToken;
		assert.equal(name, "__Secure-better-auth.session_token");
		assert.deepEqual([attributes.domain, attributes.httpOnly, attributes.secure, attributes.sameSite], [undefined, true, true, "lax"]);
		assert.deepEqual(context.trustedOrigins, [APP_URL]);
		for (const origin of ["https://weekly.mailcru.com", "https://www.mailcru.com", "http://mailcru.com"]) assert.equal(context.isTrustedOrigin(origin), false, origin);
	});

	test("an archive page's requests to the app carry the cookie, and the app refuses them", async () => {
		const user = await signIn("session@example.com");
		const cookie = [...user.jar].map(([key, value]) => `${key}=${value}`).join("; ");
		const signOut = (origin) =>
			m.authRoute.POST(new Request(`${APP_URL}/api/auth/sign-out`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: "{}" }));
		const upload = (site) =>
			as(user, () =>
				m.uploadsRoute.POST(new Request(`${APP_URL}/api/uploads`, { method: "POST", headers: { "content-type": "image/png", "sec-fetch-site": site }, body: PNG }))
			);

		assert.equal((await upload("same-site")).status, 403);
		assert.equal((await upload("same-origin")).status, 200);

		// Better Auth leaves its origin check off when NODE_ENV is test; production runs it.
		const context = await (await m.auth.getAuth()).$context;
		const { error } = console;
		context.skipOriginCheck = false;
		try {
			console.error = () => {};
			assert.equal((await signOut("https://weekly.mailcru.com")).status, 403);
			console.error = error;
			const signedOut = await signOut(APP_URL);
			assert.equal(signedOut.status, 200);
			const setCookies = signedOut.headers.getSetCookie();
			assert.ok(setCookies.some((header) => header.startsWith("__Secure-better-auth.session_token=")));
			for (const header of setCookies) assert.doesNotMatch(header, /domain=/i, header);
		} finally {
			console.error = error;
			context.skipOriginCheck = true;
		}
	});
});
