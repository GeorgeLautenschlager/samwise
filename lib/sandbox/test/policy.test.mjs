// Invariants of pi/sandbox.json, judged with the fence's own path rules
// (lib/sandbox/match.mjs): reads with Pi's tool matcher, hard write-denies with
// both the tool and the bash (runtime) matcher. Every allowWrite path is also
// readable, and an allow entry can override denyRead (on macOS a literal deny
// nested in a literal allow wins back for bash, which the policy does not rely
// on), so a secret is safe only if no allow entry covers it or sits inside it.
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
	"~/.cargo/credentials.toml", "~/.cargo/credentials", "~/.npm-global/etc/npmrc",
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
	const paths = [
		"/home/george/dev/project/src/index.js",
		"/home/george/dev/samwise/bin/samwise-reflect",
		"/home/george/.pi/samwise/memory/daily/2026-09-29.md",
		"/home/george/.gitconfig",
		"/usr/bin/git",
		"/home/george/.cargo/bin/cargo",
		"/home/george/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/README.md",
	];
	for (const path of paths) {
		assert.ok(covered(allows, path), `${path} is not readable`);
	}
});

test("writes: only the project, temp dirs, reflect proposals and the npm cache", () => {
	const writable = [
		"/home/george/dev/project/src/new.js",
		"/tmp/x",
		"/private/var/folders/ab/cd/T/x",
		"/home/george/.pi/samwise/reflect/pending.json",
		"/home/george/.npm/_cacache/x",
	];
	for (const path of writable) {
		assert.ok(covered(fs.allowWrite, path), `${path} should be writable`);
	}
	const notWritable = [
		"/home/george",
		"/home/george/foo",
		"/home/george/.bashrc",
		"/home/george/.zshrc",
		"/home/george/.ssh/authorized_keys",
		"/home/george/.pi/agent/settings.json",
		"/home/george/.pi/samwise/agent/settings.json",
		"/home/george/.pi/samwise/memory/MEMORY.md",
		"/home/george/dev/samwise/pi/sandbox.json",
	];
	for (const path of notWritable) {
		assert.ok(!covered(fs.allowWrite, path), `${path} must not be writable`);
	}
});

test("writes: fence-bypass paths are hard-denied, for bash and for Pi's write/edit tools", () => {
	const paths = [
		"/home/george/dev/project/.pi/sandbox.json",
		"/home/george/dev/project/.pi/extensions/x.ts",
		"/home/george/dev/project/.git/hooks/pre-commit",
		"/home/george/dev/project/.git/config",
		"/home/george/dev/project/vendor/x/.git/hooks/post-checkout",
		"/home/george/dev/project/vendor/x/.git/config",
		"/home/george/dev/project/a/b/c/.git/hooks/pre-push",
		"/home/george/dev/project/.git/modules/lib/hooks/post-checkout",
		"/home/george/dev/project/.git/modules/lib/config",
		"/home/george/dev/project/.git/commondir",
		"/home/george/dev/project/vendor/x/.git",
		"/home/george/dev/project/vendor/x/.git/commondir",
		"/home/george/dev/project/.git/modules/lib/commondir",
		"/home/george/dev/project/.git/worktrees/w/commondir",
		"/home/george/.pi/samwise/agent/sandbox.json",
		"/home/george/.pi/samwise/tools/bin/qmd",
		"/home/george/.pi/samwise/qmd/index.sqlite",
		"/home/george/.pi/agent/extensions/x.ts",
		"/home/george/.cache/qmd/models/x.gguf",
		"/home/george/dev/project/.env",
	];
	for (const globs of ["tool", "runtime"]) {
		for (const path of paths) {
			assert.ok(matchesPattern(path, fs.denyWrite, { ...opts, globs }), `${path} is not in denyWrite (${globs} matching)`);
		}
		assert.ok(
			!matchesPattern("/home/george/dev/project/src/app.js", fs.denyWrite, { ...opts, globs }),
			`ordinary project files stay writable (${globs} matching)`,
		);
		assert.ok(
			!matchesPattern("/home/george/dev/project/.git/objects/ab/cdef", fs.denyWrite, { ...opts, globs }),
			`commits still work: .git/objects stays writable (${globs} matching)`,
		);
	}
});

test("network: exact hosts only, the D6 set, no model providers", () => {
	const hosts = network.allowedDomains;
	for (const host of hosts) assert.ok(!host.includes("*"), `${host}: no wildcards`);
	const requiredHosts = [
		"registry.npmjs.org",
		"pypi.org",
		"files.pythonhosted.org",
		"rubygems.org",
		"github.com",
		"api.github.com",
		"raw.githubusercontent.com",
		"release-assets.githubusercontent.com",
	];
	for (const host of requiredHosts) assert.ok(hosts.includes(host), `${host} missing`);
	const forbiddenHosts = ["chatgpt.com", "api.openai.com", "api.anthropic.com"];
	for (const host of forbiddenHosts) assert.ok(!hosts.includes(host), `${host}: model calls come from the host process, not bash`);
	assert.deepEqual(network.deniedDomains, []);
});

test("every entry has a reason in _why", () => {
	const entries = [...fs.denyRead, ...fs.allowRead, ...fs.allowWrite, ...fs.denyWrite, ...network.allowedDomains];
	for (const entry of entries) {
		assert.equal(typeof policy._why?.[entry], "string", `${entry} has no _why`);
		assert.ok(policy._why[entry].trim().length > 0, `${entry} has an empty _why`);
	}
});
