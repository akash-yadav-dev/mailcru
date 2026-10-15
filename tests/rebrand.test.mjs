import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// MailCru is a fork of MailCheap: after a merge from upstream, every new mention has to be rebranded (UPSTREAM.md).
test("nothing still carries MailCheap's name outside the credits", () => {
	assert.doesNotThrow(() => execFileSync(process.execPath, ["scripts/rebrand.mjs", "--check"], { encoding: "utf8" }));
});
