import "server-only";
import { revalidateArchive } from "@/lib/archive-data";
import { getArchiveCnameTarget } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { readCnames } from "@/lib/dns-check";
import { getEmailProvider, getProvider } from "@/lib/email-provider";
import { getArchiveHostProblem, getDomainProblem, getEmailDomain, normalizeDomainInput, normalizeHostInput } from "@/lib/sender-rules";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import Domain from "@/models/Domain";
import Newsletter from "@/models/Newsletter";

// Campaigns that would break halfway if their from domain went away.
const ACTIVE_CAMPAIGN_STATUSES = ["sending", "scheduled", "paused"];

// The code is one of lib/actions/errors.js, for the API and MCP.
function domainError(message, code = "validation_failed") {
	return Object.assign(new Error(message), { isUserError: true, code });
}

async function findDomain(account, domainId) {
	const domain = isObjectIdString(String(domainId)) ? await Domain.findOne({ accountId: account._id, _id: domainId }).lean() : null;
	if (!domain) throw domainError("Domain not found", "not_found");
	return domain;
}

// A newsletter uses its from domain's archive subdomain once that subdomain points at MailCru.
export async function syncArchiveHosts(accountId) {
	const [domains, newsletters] = await Promise.all([
		Domain.find({ accountId, archiveHostVerified: true }).select({ domain: 1, archiveHost: 1 }).lean(),
		Newsletter.find({ accountId }).sort({ createdAt: 1 }).select({ fromEmail: 1, archiveHost: 1 }).lean(),
	]);
	const taken = new Set();
	let isChanged = false;
	for (const newsletter of newsletters) {
		const host = domains.find(({ domain }) => domain === getEmailDomain(newsletter.fromEmail))?.archiveHost;
		const next = host && !taken.has(host) ? host : undefined;
		if (next) taken.add(next);
		if (next === newsletter.archiveHost) continue;
		isChanged = true;
		await Newsletter.updateOne(
			{ accountId, _id: newsletter._id },
			next ? { $set: { archiveHost: next } } : { $unset: { archiveHost: 1 } }
		);
	}
	if (isChanged) revalidateArchive();
}

// A domain added at another provider, before EMAIL_PROVIDER changed, is added again at this one: it gets new
// DNS records, and sends once they're in.
async function moveToProvider({ account, domain, provider }) {
	if ((domain.provider ?? "ses") === provider.id) return domain;
	const { providerDomainId } = await provider.addDomain({ account, domain: domain.domain });
	const set = {
		provider: provider.id,
		mailFromDomain: provider.getMailFromDomain(domain.domain),
		verified: false,
		dkimStatus: "PENDING",
		mailFromStatus: "PENDING",
		records: [],
		...(providerDomainId && { providerDomainId }),
	};
	await Domain.updateOne(
		{ accountId: account._id, _id: domain._id },
		{ $set: set, ...(!providerDomainId && { $unset: { providerDomainId: 1 } }) }
	);
	return { ...domain, ...set, providerDomainId: providerDomainId ?? undefined };
}

function toProviderFields(status) {
	if (status.missing) return { verified: false, dkimStatus: "NOT_STARTED", mailFromStatus: "NOT_STARTED" };
	return {
		verified: status.verified,
		dkimStatus: status.dkimStatus,
		mailFromStatus: status.mailFromStatus ?? "PENDING",
		records: status.records,
	};
}

// The domain at the email provider and the archive subdomain's CNAME. verify asks the provider to look at DNS
// now; a provider with a verification budget may answer with what it found a moment ago (unchanged).
export async function checkDomain({ account, domainId, verify = true }) {
	await connectDb();
	const provider = getEmailProvider();
	const domain = await moveToProvider({ account, domain: await findDomain(account, domainId), provider });
	const [status, cnames] = await Promise.all([provider.readDomain({ account, domain, verify }), readCnames(domain.archiveHost)]);
	if (status.error) throw Object.assign(new Error(`${provider.name} didn't answer: ${status.error}`), { code: "unavailable" });

	const target = getArchiveCnameTarget();
	const set = {
		archiveHostVerified: Boolean(target) && cnames.includes(target),
		...(!status.unchanged && { checkedAt: new Date(), ...toProviderFields(status) }),
	};
	if (set.verified && !domain.verifiedAt) set.verifiedAt = new Date();
	await Domain.updateOne({ accountId: account._id, _id: domain._id }, { $set: set });
	if (set.archiveHostVerified !== domain.archiveHostVerified) await syncArchiveHosts(account._id);
	return { ...domain, ...set };
}

// The unique index makes the first account to add a domain its only owner, even with two at once.
export async function addDomain({ account, domain: domainInput, archiveHost: archiveInput }) {
	await connectDb();
	const domain = normalizeDomainInput(domainInput);
	const domainProblem = getDomainProblem(domain);
	if (domainProblem) throw domainError(domainProblem);
	const archiveHost = normalizeHostInput(archiveInput) || `news.${domain}`;
	const archiveProblem = getArchiveHostProblem(archiveHost, domain);
	if (archiveProblem) throw domainError(archiveProblem);

	const provider = getEmailProvider();
	let created;
	try {
		created = await Domain.create({
			accountId: account._id,
			domain,
			archiveHost,
			mailFromDomain: provider.getMailFromDomain(domain),
			provider: provider.id,
		});
	} catch (error) {
		if (error?.code !== 11000) throw error;
		const isOwn = await Domain.exists({ accountId: account._id, domain });
		throw domainError(isOwn ? `${domain} is already added` : `${domain} is used by another MailCru account`, "conflict");
	}

	try {
		const { providerDomainId } = await provider.addDomain({ account, domain });
		if (providerDomainId) await Domain.updateOne({ accountId: account._id, _id: created._id }, { $set: { providerDomainId } });
	} catch (error) {
		// Nothing was sent from it yet: the claim goes, so the account can try again.
		await Domain.deleteOne({ accountId: account._id, _id: created._id });
		throw error;
	}
	// The provider starts checking a new domain on its own: reading it is enough.
	return checkDomain({ account, domainId: created._id, verify: false });
}

// At the provider it was added at. One that isn't the active provider anymore may not be set up any longer.
export async function removeAtProvider({ account, domain }) {
	const active = getEmailProvider();
	const owner = getProvider(domain.provider ?? "ses") ?? active;
	try {
		await owner.removeDomain({ account, domain });
	} catch (error) {
		if (owner === active) throw error;
		console.error(`[domains] ${owner.name} didn't remove ${domain.domain}: ${error.message}`);
	}
}

export async function removeDomain({ account, domainId }) {
	await connectDb();
	const domain = await findDomain(account, domainId);
	const newsletterIds = (await Newsletter.find({ accountId: account._id }).select({ fromEmail: 1 }).lean())
		.filter(({ fromEmail }) => getEmailDomain(fromEmail) === domain.domain)
		.map(({ _id }) => _id);
	const isInUse =
		newsletterIds.length > 0 &&
		(await Campaign.exists({ accountId: account._id, newsletterId: { $in: newsletterIds }, status: { $in: ACTIVE_CAMPAIGN_STATUSES } }));
	if (isInUse) {
		throw domainError(`A campaign is sending or scheduled from ${domain.domain}. Wait until it's sent or cancel it first.`, "conflict");
	}

	await removeAtProvider({ account, domain });
	await Domain.deleteOne({ accountId: account._id, _id: domain._id });
	await syncArchiveHosts(account._id);
	return { removed: domain.domain };
}

// An account's purge: every domain at its provider. Its campaigns are gone already.
export async function releaseDomains(account) {
	await connectDb();
	for (const domain of await Domain.find({ accountId: account._id }).lean()) {
		await removeAtProvider({ account, domain });
		await Domain.deleteOne({ accountId: account._id, _id: domain._id });
	}
}
