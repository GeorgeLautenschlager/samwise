import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown, summarize } from "../lib/report.mjs";

const run = (id, category, pass, extra = {}) => ({
	id,
	category,
	n: 1,
	pass,
	checks: pass ? [{ key: "response_includes", pass: true, detail: "" }] : [{ key: "response_includes", pass: false, detail: "missing: x" }],
	leaks: [],
	error: null,
	network: [],
	...extra,
});
const meta = {
	config: "A",
	configDescription: "pi-memory + qmd",
	model: "stub/stub-model",
	runsPerScenario: 1,
	versions: { node: "v22", pi: "0.87.1" },
	skipped: [],
	network: false,
	date: "2026-09-27T12:00:00.000Z",
};
const passingSet = () => [
	...["r1", "r2", "r3", "r4"].map((id) => run(id, "recall", true)),
	run("r5", "recall", false),
	run("p1", "preference", true),
	run("k1", "stale-knowledge", true),
	run("l1", "scope-leak", true),
];

test("rates and AC verdicts at the thresholds", () => {
	const s = summarize(passingSet(), meta);
	assert.equal(s.categories.recall.rate, 0.8);
	assert.equal(s.ac.AC2.status, "pass");
	assert.equal(s.ac.AC3.status, "pass");
	assert.equal(s.ac.AC4.status, "pass");
	assert.equal(s.verdict, "PASS");
	assert.equal(s.totalRuns, 8);
});

test("a leak in any category fails AC3", () => {
	const results = passingSet();
	results[0].leaks = [{ path: "personal/W.md", term: "Skiffline" }];
	const s = summarize(results, meta);
	assert.equal(s.ac.AC3.status, "fail");
	assert.equal(s.verdict, "FAIL");
	assert.deepEqual(s.leaks, [{ id: "r1", n: 1, path: "personal/W.md", term: "Skiffline" }]);
});

test("stale-knowledge below 90% fails AC4", () => {
	const s = summarize([...passingSet(), run("k2", "stale-knowledge", false)], meta);
	assert.equal(s.categories["stale-knowledge"].rate, 0.5);
	assert.equal(s.ac.AC4.status, "fail");
});

test("categories without runs are not evaluated, giving INCOMPLETE", () => {
	const s = summarize([run("r1", "recall", true)], meta);
	assert.equal(s.ac.AC2.status, "not evaluated");
	assert.equal(s.ac.AC4.status, "not evaluated");
	assert.equal(s.ac.AC3.status, "pass");
	assert.equal(s.verdict, "INCOMPLETE");
});

test("per-scenario counts and first failure (errors take precedence)", () => {
	const s = summarize([run("r1", "recall", false), { ...run("r1", "recall", false), n: 2, error: "timed out after 600s" }], meta);
	assert.deepEqual(s.scenarios, [{ id: "r1", category: "recall", runs: 2, passed: 0, firstFailure: "response_includes: missing: x" }]);
	const t = summarize([{ ...run("r1", "recall", false), error: "pi exited 1" }], meta);
	assert.equal(t.scenarios[0].firstFailure, "pi exited 1");
});

test("network destinations are counted when capture is on", () => {
	const results = [
		run("r1", "recall", true, { network: [{ host: "127.0.0.1", port: 4000 }, { host: "api.example.com", port: 443 }] }),
		run("r2", "recall", true, { network: [{ host: "127.0.0.1", port: 4000 }] }),
	];
	const s = summarize(results, { ...meta, network: true });
	assert.deepEqual(s.network, [
		{ destination: "127.0.0.1:4000", connections: 2 },
		{ destination: "api.example.com:443", connections: 1 },
	]);
	assert.equal(summarize(results, meta).network, null);
});

test("markdown shows verdict, ACs, scenario rows, skipped, leaks and network", () => {
	const results = passingSet();
	results[1].leaks = [{ path: "personal/W.md", term: "Skiffline" }];
	results[0].network = [{ host: "127.0.0.1", port: 4000 }];
	const md = renderMarkdown(
		summarize(results, { ...meta, network: true, skipped: [{ id: "x", category: "scope-leak", requires: ["reflect"] }] }),
	);
	for (const expected of [
		"**Verdict: FAIL**",
		"| AC3 | 0 leaks to the personal scope across all runs | fail |",
		"| recall | 5 | 4 | 80% | ≥ 80% |",
		"| r5 | recall | 0/1 | response_includes: missing: x |",
		"- x (scope-leak): requires reflect",
		"- r2 #1: 'Skiffline' in personal/W.md",
		"| 127.0.0.1:4000 | 1 |",
		"- Model: `stub/stub-model`",
	]) {
		assert.ok(md.includes(expected), `missing: ${expected}`);
	}
});
