import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const stub = (name) => new URL(`../stubs/${name}`, import.meta.url).href;

const STUBS = {
	"server-only": stub("empty.mjs"),
	"next/headers": stub("next-headers.mjs"),
	"next/headers.js": stub("next-headers.mjs"),
	"next/cache": stub("next-cache.mjs"),
	"next/navigation": stub("next-navigation.mjs"),
	"next/server": stub("next-server.mjs"),
	"@vercel/blob": stub("vercel-blob.mjs"),
	"@aws-sdk/client-s3": stub("s3.mjs"),
	"@aws-sdk/client-cloudfront": stub("cloudfront.mjs"),
	"@upstash/qstash": stub("qstash.mjs"),
	"@upstash/qstash/nextjs": stub("qstash-nextjs.mjs"),
	"@better-auth/cimd/node": stub("cimd-node.mjs"),
	"@/lib/ses": stub("ses.mjs"),
	"@/lib/dns-check": stub("dns-check.mjs"),
	"@/lib/mail-domains": stub("mail-domains.mjs"),
	"@/lib/dns-broker": stub("dns-broker.mjs"),
	"@/lib/remote-image": stub("remote-image.mjs"),
};

// MailCru Cloud's marketing site extends the shared pages through this module where its file exists, as in
// next.config.mjs. The open source has none, so the default stays.
const SITE_EXTENSIONS = { "@/lib/site-extensions": "lib/marketing/site-extensions.js" };

const EXTENSIONS = ["", ".js", ".jsx", ".mjs", "/index.js"];

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function resolveAlias(specifier) {
	const base = `${ROOT}${specifier.slice(2)}`;
	const path = EXTENSIONS.map((extension) => `${base}${extension}`).find(isFile);
	return path ? pathToFileURL(path).href : null;
}

export async function resolve(specifier, context, nextResolve) {
	if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
	const extension = SITE_EXTENSIONS[specifier] && `${ROOT}${SITE_EXTENSIONS[specifier]}`;
	if (extension && isFile(extension)) return { url: pathToFileURL(extension).href, shortCircuit: true };
	if (specifier.startsWith("@/")) {
		const url = resolveAlias(specifier);
		if (url) return { url, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
