// Invariants of pi/sandbox.json, judged with pi-sandbox's own path rules
// (lib/sandbox/match.mjs). For bash, allowRead beats denyRead and every
// allowWrite path is also readable, so a secret is safe only if no allow
// entry covers it or sits inside it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { matchesPattern } from "../match.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const policy = JSON.parse(readFileSync(join(repo, "pi", "sandbox.json"), "utf8"));
const { filesystem: fs, network } = policy;
const opts = { home: "/home/george", cwd: "/home/george/dev/project" };
const covered = (patterns, path) => matchesPattern(path, patterns, opts);
const allows = [...fs.allowRead, ...fs.allowWrite];

const SECRETS = [
	"~/.ssh", "~/.aws", "~/.config/gh", "~/.gnupg", "~/.netrc", "~/.npmrc",
	"~/.docker", "~/.kube", "~/.git-credentials", "~/.config/git/credentials",
	"~/.password-store", "~/.config/op", "~/Library/Keychains",
	"~/Library/Application Support/Google/Chrome", "~/Library/Application Support/Firefox",
	"~/Library/Group Containers", "~/.config/google-chrome", "~/.mozilla",
	"~/.pi/agent/auth.json", "~/.pi/samwise/agent/auth.json",
];

test("settings: the fence is on and George's own ! commands run unfenced", () => {
	assert.equal(policy.enabled, true);
	assert.equal(policy.sandboxUserShell, false);
});

test("reads: home is denied and allow entries are plain paths", () => {
	assert.deepEqual(fs.denyRead, ["~"]);
	for (const entry of allows) assert.ok(!entry.includes("*"), `${entry}: allow entries must not be globs`);
});

test("reads: every secret is denied and no allow entry covers it or sits inside it", () => {
	for (const secret of SECRETS) {
		assert.ok(covered(fs.denyRead, secret), `${secret} is not under denyRead`);
		for (const entry of allows) {
			assert.ok(!covered([entry], secret), `${entry} exposes ${secret}`);
			assert.ok(!covered([secret], entry), `${entry} sits inside ${secret}`);
		}
	}
});

test("reads: what Samwise needs is readable", () => {
	for (const path of ["/home/george/dev/project/src/index.js", "/home/george/dev/samwise/bin/samwise-reflect", "/home/george/.pi/samwise/memory/daily/2026-09-29.md", "/home/george/.gitconfig", "/usr/bin/git"]) {
		assert.ok(covered(allows, path), `${path} is not readable`);
	}
});

test("writes: only the project, temp dirs, reflect proposals and the npm cache", () => {
	for (const path of ["/home/george/dev/project/src/new.js", "/tmp/x", "/private/var/folders/ab/cd/T/x", "/home/george/.pi/samwise/reflect/pending.json", "/home/george/.npm/_cacache/x"]) {
		assert.ok(covered(fs.allowWrite, path), `${path} should be writable`);
	}
	for (const path of ["/home/george", "/home/george/foo", "/home/george/.bashrc", "/home/george/.zshrc", "/home/george/.ssh/authorized_keys", "/home/george/.pi/agent/settings.json", "/home/george/.pi/samwise/agent/settings.json", "/home/george/.pi/samwise/memory/MEMORY.md", "/home/george/dev/samwise/pi/sandbox.json"]) {
		assert.ok(!covered(fs.allowWrite, path), `${path} must not be writable`);
	}
});

test("writes: fence-bypass paths are hard-denied", () => {
	for (const path of ["/home/george/dev/project/.pi/sandbox.json", "/home/george/dev/project/.pi/extensions/x.ts", "/home/george/dev/project/.git/hooks/pre-commit", "/home/george/dev/project/.git/config", "/home/george/dev/project/vendor/x/.git/hooks/post-checkout", "/home/george/dev/project/vendor/x/.git/config", "/home/george/.pi/samwise/agent/sandbox.json", "/home/george/.pi/agent/extensions/x.ts", "/home/george/.cache/qmd/models/x.gguf", "/home/george/dev/project/.env"]) {
		assert.ok(covered(fs.denyWrite, path), `${path} is not in denyWrite`);
	}
	assert.ok(!covered(fs.denyWrite, "/home/george/dev/project/src/app.js"), "ordinary project files stay writable");
});

test("network: exact hosts only, the D6 set, no model providers", () => {
	const hosts = network.allowedDomains;
	for (const host of hosts) assert.ok(!host.includes("*"), `${host}: no wildcards`);
	for (const host of ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "rubygems.org", "github.com", "api.github.com", "raw.githubusercontent.com"]) assert.ok(hosts.includes(host), `${host} missing`);
	for (const host of ["chatgpt.com", "api.openai.com", "api.anthropic.com"]) assert.ok(!hosts.includes(host), `${host}: model calls come from the host process, not bash`);
	assert.deepEqual(network.deniedDomains, []);
});

test("every entry has a reason in _why", () => {
	const entries = [...fs.denyRead, ...fs.allowRead, ...fs.allowWrite, ...fs.denyWrite, ...network.allowedDomains];
	for (const entry of entries) {
		assert.equal(typeof policy._why?.[entry], "string", `${entry} has no _why`);
		assert.ok(policy._why[entry].trim().length > 0, `${entry} has an empty _why`);
	}
});
