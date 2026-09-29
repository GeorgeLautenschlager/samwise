import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expandPath, matchesPattern } from "../match.mjs";

const opts = { home: "/home/g", cwd: "/home/g/dev/app" };
const m = (path, patterns) => matchesPattern(path, patterns, opts);

test("expandPath: tilde, relative and absolute forms", () => {
	assert.equal(expandPath("~", opts), "/home/g");
	assert.equal(expandPath("~/.ssh", opts), "/home/g/.ssh");
	assert.equal(expandPath("~foo", opts), "/home/g/dev/app/~foo");
	assert.equal(expandPath(".", opts), "/home/g/dev/app");
	assert.equal(expandPath(".pi/sandbox.json", opts), "/home/g/dev/app/.pi/sandbox.json");
	assert.equal(expandPath("/tmp", opts), "/tmp");
});

test("plain patterns match the path itself and anything under it, not siblings", () => {
	assert.ok(m("~/.ssh", ["~/.ssh"]));
	assert.ok(m("/home/g/.ssh/id_ed25519", ["~/.ssh"]));
	assert.ok(!m("/home/g/.sshx", ["~/.ssh"]));
	assert.ok(m("/home/g/dev/app/src/x.js", ["."]));
	assert.ok(!m("/home/g/dev/other", ["."]));
	assert.ok(m("/tmp/a", ["/tmp/"]));
	assert.ok(m("~", ["~"]));
	assert.ok(!m("/home/gx", ["~"]));
});

test("glob patterns: * crosses directories and the match is anchored", () => {
	assert.ok(m("/home/g/dev/app/vendor/x/.git/hooks/post-checkout", ["*/.git/hooks/*"]));
	assert.ok(!m("/home/g/dev/app/.git/hooks", ["*/.git/hooks/*"]));
	assert.ok(m("/home/g/dev/app/certs/server.pem", ["*.pem"]));
	assert.ok(!m("/home/g/dev/app/server.pem.txt", ["*.pem"]));
	assert.ok(m("/home/g/dev/app/.env.local", [".env.*"]));
});

test("canonical: symlinked paths and patterns are compared by real path", () => {
	const root = mkdtempSync(join(tmpdir(), "samwise-match-"));
	try {
		mkdirSync(join(root, "real", "dev"), { recursive: true });
		symlinkSync(join(root, "real"), join(root, "link"));
		const c = { home: join(root, "link"), cwd: root, canonical: true };
		assert.ok(matchesPattern(join(root, "real", "dev", "new-file"), ["~/dev"], c));
		assert.ok(matchesPattern(join(root, "link", "dev", "a", "b"), [join(root, "real", "dev")], c));
		assert.ok(!matchesPattern(join(root, "real", "other"), ["~/dev"], c));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
