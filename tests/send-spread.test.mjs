import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SEND_SPREAD, describeSpreadHours, getBatchStarts, getSpreadEnd, getSpreadHours, getSpreadMs, getWarmup } from "../lib/send-spread.js";
import { activate, as, catchRedirect, form, jsonRequest, signIn, startTestApp } from "./helpers/app.mjs";
import { published } from "./stubs/qstash.mjs";

const HOUR_MS = 3_600_000;
const SPREAD_MS = SEND_SPREAD.hours * HOUR_MS;
const CLOUD = { MAILCRU_CLOUD: "true" };

test("spread sends: MailCru Cloud only, from the first campaign until 30 days later or an admin ends them", () => {
	const now = new Date("2026-10-13T12:00:00Z");
	assert.equal(getSpreadMs({}, now, CLOUD), SPREAD_MS, "a new account, before its first campaign");
	assert.equal(getSpreadMs({ spreadUntil: new Date("2026-11-01T00:00:00Z") }, now, CLOUD), SPREAD_MS);
	assert.equal(getSpreadMs({ spreadUntil: "2026-11-01T00:00:00.000Z" }, now, CLOUD), SPREAD_MS, "serialized dates too");
	assert.equal(getSpreadMs({ spreadUntil: now }, now, CLOUD), 0, "over");
	assert.equal(getSpreadMs({}, now, { MAILCRU_CLOUD: "" }), 0, "self-hosted servers send at full speed");
	assert.equal(getSpreadEnd(now).toISOString(), "2026-11-12T12:00:00.000Z");
});

test("the first campaign goes out over 24 hours, the next two over 16 and 12, the others over 8", () => {
	assert.deepEqual([0, 1, 2, 3, 12].map(getSpreadHours), [24, 16, 12, 8, 8]);
	assert.equal(describeSpreadHours(), "the first over 24 hours, the next two over 16 and 12, then each over 8");
});

test("the warm-up shows the day and progress of the first 30 days, its next campaign's hours, and nothing once it's over", () => {
	const now = new Date("2026-10-13T12:00:00Z");
	assert.deepEqual(
		getWarmup({}, { now, env: CLOUD }),
		{ days: 30, hours: 8, firstHours: [24, 16, 12], nextHours: 24, hasStarted: false, day: 0, progress: 0, endsAt: null },
		"before the first campaign"
	);
	const started = getWarmup({ spreadUntil: getSpreadEnd(new Date("2026-10-11T00:00:00Z")) }, { place: 1, now, env: CLOUD });
	assert.equal(started.hasStarted, true);
	assert.equal(started.nextHours, 16, "one campaign out so far");
	assert.equal(started.day, 3, "two and a half days in");
	assert.equal(started.endsAt, "2026-11-10T00:00:00.000Z");
	assert.ok(Math.abs(started.progress - 2.5 / 30) < 1e-9);
	assert.equal(getWarmup({ spreadUntil: getSpreadEnd(now) }, { now, env: CLOUD }).day, 1, "the first campaign was just now");
	assert.equal(getWarmup({ spreadUntil: now }, { now, env: CLOUD }), null, "over, or ended by an admin");
	assert.equal(getWarmup({}, { now, env: { MAILCRU_CLOUD: "" } }), null, "no warm-up on a self-hosted server");
});

test("batches start evenly over the spread, the first right away", () => {
	const now = Date.parse("2026-10-13T12:00:00Z");
	const seconds = (hours) => (now + hours * HOUR_MS) / 1000;
	assert.deepEqual(getBatchStarts(4, SPREAD_MS, now), [null, seconds(2), seconds(4), seconds(6)]);
	assert.deepEqual(getBatchStarts(1, SPREAD_MS, now), [null], "one batch goes at once");
	assert.deepEqual(getBatchStarts(3, 0, now), [null, null, null], "no spread, back to back");
	assert.deepEqual(getBatchStarts(0, SPREAD_MS, now), []);
});

describe("a new account's campaigns go out over hours", () => {
	let app;
	let m;

	async function setup(email, contacts, { isMailed = false } = {}) {
		const user = await signIn(email);
		await activate(user, { limitOverrides: { emailsPerMonth: 100_000, subscribers: 100_000 } });
		await m.Account.updateOne({ _id: user.accountId }, { $unset: { spreadUntil: 1 } });
		const slug = email.split("@")[0];
		const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St" }))));
		user.newsletterId = url.split("/").at(-1);
		await m.Contact.insertMany(
			Array.from({ length: contacts }, (_, index) => ({
				accountId: user.accountId,
				newsletterId: user.newsletterId,
				email: `reader${index}@${slug}.example.org`,
				status: "active",
				...(isMailed && { lastSentAt: new Date(Date.now() - 86_400_000) }),
			}))
		);
		return user;
	}

	async function draft(user) {
		const draftUrl = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
		const campaignId = draftUrl.split("/").at(-1);
		await as(user, () => m.campaigns.saveCampaign(campaignId, { subject: "Issue", previewText: "Hi", body: "<p>Hello</p>" }));
		return campaignId;
	}

	const sortJobs = (jobs) => ({
		batches: jobs.filter(({ url }) => url.endsWith("/api/jobs/send-batch")),
		checks: jobs.filter(({ url }) => url.endsWith("/api/jobs/check-first-send")),
	});

	// What one send published, in order.
	async function send(user, campaignId) {
		const from = published.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(campaignId, {})), { ok: true });
		return sortJobs(published.slice(from));
	}

	function runBatches(batches) {
		return Promise.all(batches.map((batch) => m.sendBatchRoute.POST(jsonRequest(batch.url, { method: "POST", body: batch.body }))));
	}

	// Each batch's start, in hours from the send.
	function startHours(batches, start) {
		return batches.map(({ notBefore }) => (notBefore === undefined ? 0 : Math.round(((notBefore * 1000 - start) / HOUR_MS) * 100) / 100));
	}

	const campaignOf = (user, campaignId) => m.Campaign.findOne({ accountId: user.accountId, _id: campaignId }).lean();
	const countHeld = (user, campaignId) => m.Message.countDocuments({ accountId: user.accountId, campaignId, status: "held" });

	before(async () => {
		app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next", SEND_RATE_PER_SECOND: "1000" });
		m = {
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			campaigns: await import("../app/(app)/campaigns/actions.js"),
			sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
			checkRoute: await import("../app/api/jobs/check-first-send/route.js"),
			accounts: await import("../lib/accounts.js"),
			Account: (await import("../models/Account.js")).default,
			Campaign: (await import("../models/Campaign.js")).default,
			Contact: (await import("../models/Contact.js")).default,
			Message: (await import("../models/Message.js")).default,
		};
	});

	after(() => app?.stop());

	test("the first one goes over 24 hours: a slice of the new contacts, a check 3 hours after it, then the rest", async () => {
		const user = await setup("first-month@example.com", 450);
		const campaignId = await draft(user);
		const start = Date.now();
		const { batches, checks } = await send(user, campaignId);

		// 200 of 450 go first, over their share of the 24 hours: 24 × 200 / 450 ≈ 10.67 hours, 4 batches of 50.
		assert.deepEqual(startHours(batches, start), [0, 2.67, 5.33, 8]);
		assert.equal(await countHeld(user, campaignId), 250);
		assert.equal(checks.length, 1);
		assert.ok(Math.abs(checks[0].notBefore * 1000 - (start + (10.67 + 3) * HOUR_MS)) < 120_000, "3 hours after the slice's share");

		const account = await m.Account.findById(user.accountId).lean();
		assert.ok(Math.abs(account.spreadUntil.getTime() - getSpreadEnd(new Date(start)).getTime()) < 60_000, "30 days from the first campaign");
		const sending = await campaignOf(user, campaignId);
		assert.equal(sending.spreadHours, 24);
		assert.deepEqual({ slice: sending.firstSend.slice, held: sending.firstSend.held }, { slice: 200, held: 250 });
		assert.ok(Math.abs(sending.sendingUntil.getTime() - (start + 27 * HOUR_MS)) < 60_000, "24 hours, and the 3-hour check");

		await runBatches(batches);
		assert.equal((await campaignOf(user, campaignId)).status, "sending", "not sent while contacts are held");

		const from = published.length;
		const checkedAt = Date.now();
		const check = await (await m.checkRoute.POST(jsonRequest(checks[0].url, { method: "POST", body: checks[0].body }))).json();
		assert.equal(check.released, 250);
		// The rest over its own share: 24 × 250 / 450 ≈ 13.33 hours, 5 batches of 50.
		const rest = sortJobs(published.slice(from)).batches;
		assert.deepEqual(startHours(rest, checkedAt), [0, 2.67, 5.33, 8, 10.67]);
		assert.equal(rest.reduce((sum, { body }) => sum + body.messageIds.length, 0), 250, "only the held contacts");
		assert.ok(Math.abs((await campaignOf(user, campaignId)).sendingUntil.getTime() - (checkedAt + 13.33 * HOUR_MS)) < 120_000);

		await runBatches(rest);
		const sent = await campaignOf(user, campaignId);
		assert.equal(sent.status, "sent");
		assert.equal(sent.stats.sent, 450);
		assert.equal(sent.sendingUntil, undefined, "cleared once sent");
	});

	test("the next ones go over 16, 12, then 8 hours, without a check when nobody is new", async () => {
		const user = await setup("next-sends@example.com", 300, { isMailed: true });
		for (const hours of [24, 16, 12, 8, 8]) {
			const campaignId = await draft(user);
			const start = Date.now();
			const { batches, checks } = await send(user, campaignId);
			assert.equal(checks.length, 0);
			const sending = await campaignOf(user, campaignId);
			assert.equal(sending.spreadHours, hours);
			assert.deepEqual(startHours(batches, start), [0, 1, 2, 3, 4, 5].map((step) => Math.round(((step * hours) / 6) * 100) / 100));
			assert.ok(Math.abs(sending.sendingUntil.getTime() - (start + hours * HOUR_MS)) < 60_000);
		}
	});

	test("ended early by an admin, sends go at full speed with the first-send slice; started again, they spread", async () => {
		const user = await setup("trusted@example.com", 450);
		assert.equal(await m.accounts.setSendSpread(user.accountId, false), true);
		const fullSpeed = await send(user, await draft(user));
		assert.ok(fullSpeed.batches.every(({ notBefore }) => notBefore === undefined), "back to back");
		assert.equal(fullSpeed.checks.length, 1, "new contacts go in steps");
		assert.equal((await m.Account.findById(user.accountId).lean()).spreadUntil <= new Date(), true);

		assert.equal(await m.accounts.setSendSpread(user.accountId, true), true);
		const spread = await send(user, await draft(user));
		assert.ok(spread.batches.slice(1).every(({ notBefore }) => notBefore > Date.now() / 1000), "spread again");
		const { spreadUntil } = await m.Account.findById(user.accountId).lean();
		assert.ok(spreadUntil.getTime() > Date.now() + 29 * 24 * HOUR_MS, "for another 30 days");
	});
});
