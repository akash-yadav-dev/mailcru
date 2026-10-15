#!/usr/bin/env node
// Applies the MailCru branding to MailCheap's code. Run it after every merge from upstream (UPSTREAM.md):
//   node scripts/rebrand.mjs          rewrites files and renames paths
//   node scripts/rebrand.mjs --check  lists what's left to rebrand, exits 1 if anything is
// The attribution the AGPL and the original author are owed stays: LICENSE, NOTICE.md and the protected strings.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const isCheck = process.argv.includes("--check");

const SKIPPED_FILES = new Set(["LICENSE", "NOTICE.md", "UPSTREAM.md", "scripts/rebrand.mjs"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|pdf|zip|mp4|webm)$/i;

// Credit to the original project and its author, kept verbatim wherever it appears.
const PROTECTED = [
	"https://github.com/marclou/mailcheap/tree/67d13b028a6ecae9ec56d49c4b2db58019217eba",
	"github.com/marclou/mailcheap's history",
	"Copyright (C) 2026 Marc Lou",
	"[MailCheap](https://github.com/marclou/mailcheap)",
	"[Marc Lou](https://x.com/marclou)",
	"MailCheap was made by",
	"## A fork of MailCheap",
];

// Key-derivation labels of signed links (unsubscribe, tracking...): never shown, and renaming them would change
// every signature, which tests/link-signatures.test.mjs pins. They stay as upstream has them.
const PROTECTED_PATTERN = /mailcheap-[a-z-]+-v\d+/g;

// Order matters: the URLs and domains before the bare name they contain.
const REPLACEMENTS = [
	["https://github.com/marclou/mailcheap.git", "https://github.com/akash-yadav-dev/mailcru.git"],
	["https://github.com/marclou/mailcheap", "https://github.com/akash-yadav-dev/mailcru"],
	["marclou%2Fmailcheap", "akash-yadav-dev%2Fmailcru"],
	["marc-lou.vercel.app", "akash-yadav-dev.vercel.app"],
	["mailcheap\\.ai", "mailcru\\.com"],
	["MailCheap.ai", "MailCru.com"],
	["mailcheap.ai", "mailcru.com"],
	["MAILCHEAP", "MAILCRU"],
	["MailCheap", "MailCru"],
	["Mailcheap", "Mailcru"],
	["mailcheap", "mailcru"],
];

const LEFTOVER = /mailcheap|marclou|marc lou|mailcru\\?\.ai\b/i;

function trackedFiles() {
	return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
}

function rebrand(text) {
	const kept = [];
	let out = text;
	const keep = (value) => `\u0000KEEP${kept.push(value) - 1}\u0000`;
	for (const value of PROTECTED) out = out.split(value).join(keep(value));
	out = out.replace(PROTECTED_PATTERN, keep);
	for (const [from, to] of REPLACEMENTS) out = out.split(from).join(to);
	return out.replace(/\u0000KEEP(\d+)\u0000/g, (_, index) => kept[Number(index)]);
}

function withoutProtected(text) {
	return PROTECTED.reduce((out, value) => out.split(value).join(""), text).replace(PROTECTED_PATTERN, "");
}

const leftovers = [];
let changed = 0;

for (const file of trackedFiles()) {
	if (SKIPPED_FILES.has(file) || BINARY.test(file)) continue;
	const fullPath = path.join(ROOT, file);
	const text = readFileSync(fullPath, "utf8");
	if (isCheck) {
		withoutProtected(text)
			.split("\n")
			.forEach((line, index) => LEFTOVER.test(line) && leftovers.push(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`));
		continue;
	}
	const next = rebrand(text);
	if (next !== text) {
		writeFileSync(fullPath, next);
		changed++;
	}
}

for (const file of trackedFiles()) {
	if (SKIPPED_FILES.has(file)) continue;
	const renamed = rebrand(file);
	if (renamed === file) continue;
	if (isCheck) leftovers.push(`${file}: path still carries the old name`);
	else execFileSync("git", ["mv", file, renamed], { cwd: ROOT });
}

if (isCheck) {
	if (leftovers.length > 0) {
		console.log(leftovers.join("\n"));
		console.log(`\n${leftovers.length} place(s) left to rebrand.`);
		process.exit(1);
	}
	console.log("Rebrand check: nothing left.");
} else {
	console.log(`Rebranded ${changed} file(s).`);
}
