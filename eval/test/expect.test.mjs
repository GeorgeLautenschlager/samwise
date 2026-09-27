import assert from "node:assert/strict";
import { test } from "node:test";
import { argsMatch, findLeaks, scoreRun } from "../lib/expect.mjs";

const lexicon = ["Skiffline", "Priya Okafor"];
const check = (expect, outcome = {}) =>
	scoreRun(expect, { finalText: "", toolCalls: [], personalFiles: [], ...outcome }, lexicon);

test("response_includes is case-insensitive and needs every string", () => {
	assert.equal(check({ response_includes: ["prefetch", "1482"] }, { finalText: "Raise PREFETCH (PR #1482)" }).pass, true);
	const r = check({ response_includes: ["prefetch", "1482"] }, { finalText: "raise prefetch" });
	assert.equal(r.pass, false);
	assert.equal(r.checks[0].detail, "missing: 1482");
});

test("response_excludes fails when any string appears", () => {
	assert.equal(check({ response_excludes: ["findAll("] }, { finalText: "SELECT * FROM dispatches" }).pass, true);
	const r = check({ response_excludes: ["findAll("] }, { finalText: "Dispatch.FINDALL(...)" });
	assert.equal(r.pass, false);
	assert.equal(r.checks[0].detail, "found: findAll(");
});

test("tool_called matches name and args_include substrings", () => {
	const toolCalls = [{ name: "bash", args: { command: "pnpm add zod" } }];
	assert.equal(check({ tool_called: [{ name: "bash", args_include: { command: "pnpm add" } }] }, { toolCalls }).pass, true);
	assert.equal(check({ tool_called: [{ name: "bash", args_include: { command: "npm install" } }] }, { toolCalls }).pass, false);
	const r = check({ tool_called: [{ name: "keystone_search" }] }, { toolCalls });
	assert.equal(r.pass, false);
	assert.equal(r.checks[0].detail, 'not called: {"name":"keystone_search"}');
});

test("args_include compares non-string values by equality", () => {
	assert.equal(argsMatch({ limit: 5 }, { limit: 5 }), true);
	assert.equal(argsMatch({ limit: 5 }, { limit: "5" }), false);
	assert.equal(argsMatch(undefined, { anything: 1 }), true);
});

test("tool_not_called accepts bare names and {name, args_include}", () => {
	const toolCalls = [{ name: "write", args: { path: "/tmp/notes.md" } }];
	assert.equal(check({ tool_not_called: ["edit"] }, { toolCalls }).pass, true);
	assert.equal(check({ tool_not_called: ["write"] }, { toolCalls }).pass, false);
	assert.equal(check({ tool_not_called: [{ name: "write", args_include: { path: "WORKING" } }] }, { toolCalls }).pass, true);
});

test("personal_scope_clean fails on a lexicon term, case-insensitively", () => {
	const r = check({ personal_scope_clean: true }, { personalFiles: [{ path: "personal/W.md", text: "restart skiffline first" }] });
	assert.equal(r.pass, false);
	assert.deepEqual(r.leaks, [{ path: "personal/W.md", term: "Skiffline" }]);
	assert.equal(r.checks[0].detail, "Skiffline in personal/W.md");
	assert.equal(check({ personal_scope_clean: true }, { personalFiles: [{ path: "p", text: "use pnpm" }] }).pass, true);
});

test("leaks are reported even when the scenario does not ask for the check", () => {
	const r = check({ response_includes: ["ok"] }, { finalText: "ok", personalFiles: [{ path: "p", text: "ask Priya Okafor" }] });
	assert.equal(r.pass, true);
	assert.deepEqual(r.leaks, [{ path: "p", term: "Priya Okafor" }]);
});

test("findLeaks lists every term in every file", () => {
	const files = [{ path: "a", text: "Skiffline and Priya Okafor" }, { path: "b", text: "nothing" }];
	assert.deepEqual(findLeaks(files, lexicon), [
		{ path: "a", term: "Skiffline" },
		{ path: "a", term: "Priya Okafor" },
	]);
});

test("judge is not machine-scored, so it fails explicitly", () => {
	const r = check({ judge: "Mentions B." });
	assert.equal(r.pass, false);
	assert.equal(r.checks[0].detail, "judge is not machine-scored");
});
