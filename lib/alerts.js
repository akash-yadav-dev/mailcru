import "server-only";
import { headers } from "next/headers";
import { findOwnerEmail } from "@/lib/accounts";
import { formatActivity } from "@/lib/activity";
import { getAdminEmails, getAppUrl } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { canSendPlatformEmail, sendPlatformEmail } from "@/lib/platform-email";
import { getClientIp } from "@/lib/rate-limit";
import Alert from "@/models/Alert";

const DEFAULT_COOLDOWN_MINUTES = 60;

// An account's alerts go to its owner, platform alerts to ADMIN_EMAILS, as MailCru's own emails (lib/platform-email.js).
async function emailAlert({ accountId, title, text }) {
	if (!canSendPlatformEmail()) return;
	const recipients = accountId ? [await findOwnerEmail(accountId)].filter(Boolean) : getAdminEmails();
	await Promise.all(recipients.map((to) => sendPlatformEmail({ to, subject: `[MailCru] ${title}`, text })));
}

// The upsert only matches once the cooldown is over; inside it, the insert hits the unique key.
async function claimAlert({ accountId, key, title, cooldownMinutes }) {
	const now = new Date();
	const cutoff = new Date(now.getTime() - cooldownMinutes * 60_000);
	try {
		await Alert.updateOne(
			{ accountId: accountId ?? null, key, $or: [{ lastSentAt: { $lt: cutoff } }, { lastSentAt: null }] },
			{ $set: { title, lastSentAt: now } },
			{ upsert: true }
		);
		return true;
	} catch (error) {
		if (error?.code === 11000) return false;
		throw error;
	}
}

// Never throws: a failing alert must not break a send or a webhook. Always logged; emailed at most once
// per cooldown.
export async function sendAlert({
	accountId,
	key,
	title,
	detail,
	path = "",
	cooldownMinutes = DEFAULT_COOLDOWN_MINUTES,
}) {
	console.warn(`[alert]${accountId ? ` account ${accountId}:` : ""} ${title}: ${detail}`);
	try {
		await connectDb();
		if (!(await claimAlert({ accountId, key, title, cooldownMinutes }))) return;
		await emailAlert({ accountId, title, text: `${title}\n${detail}\n${getAppUrl()}${path}` });
	} catch (error) {
		console.error("[alert] Could not send:", error?.message);
	}
}

// Sign-ins, new API keys and sends, every time, in the logs with where they came from.
export async function notifyActivity(lines, { accountId, withUserAgent = false } = {}) {
	try {
		const list = await headers();
		const text = formatActivity(lines, {
			ip: getClientIp(list),
			country: list.get("x-vercel-ip-country"),
			userAgent: withUserAgent ? (list.get("user-agent") ?? "") : undefined,
		});
		console.info(`[activity]${accountId ? ` account ${accountId}:` : ""} ${text.replaceAll("\n", " | ")}`);
	} catch (error) {
		console.error("[alert] Activity notice failed:", error?.message);
	}
}
