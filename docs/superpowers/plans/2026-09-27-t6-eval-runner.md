# T6: Eval Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use steward:steward-local-sdd (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `node eval/run.mjs --config A|B --model <p/id>` runs the golden set through isolated, real Samwise sessions, scores each run, maps rates to AC2–AC4 and writes a markdown + JSON report, optionally with AC5 network evidence.

**Architecture:** Pure modules (`expect.mjs` scoring, `report.mjs` aggregation/rendering, `parseTranscript`) are unit-tested with `node:test`. `sandbox.mjs` builds each run by invoking the real `bootstrap.sh` in a throwaway `SAMWISE_HOME` (qmd shared from a base home), `pi-run.mjs` runs `bin/samwise --mode json`, and `run.mjs` orchestrates with an isolation guard. An end-to-end test drives the runner against a scripted stub LLM.

**Tech Stack:** Node ≥ 22 (ESM, `node:test`, `util.parseArgs`), Pi CLI (`--mode json`, `-e`), qmd, Bash tests.

**Spec:** `docs/superpowers/specs/2026-09-27-t6-eval-runner-design.md`

## Spec refinement (made while planning)

- **`--auth` is symlinked, not copied**, into each run's agent dir. With OAuth logins that rotate refresh tokens, a refresh inside a throwaway copy could invalidate the real login; a symlink writes refreshes back and leaves no credential copies in run dirs. `--keep` removes the link. `--auth none` disables it (tests).
- Transcripts go next to the report, in `<out>/<report-name>/` (git-ignored as `eval/reports/*/`), so tests can point everything at a temp `--out`.
- Report names include the time: `<YYYY-MM-DD>-<HHMM>-config-<X>`.
- `--timeout <seconds>` (default 600) bounds each Pi session.
- The verdict is `PASS` (all ACs pass), `FAIL` (any fails) or `INCOMPLETE` (none fail, some not evaluated). Exit code 0 only for `PASS`; 1 otherwise; 2 for usage errors; 3 if the isolation guard trips.

## Verified facts (prototyped 2026-09-27; do not re-derive)

- `bin/samwise --mode json --model stub/stub-model -e <ext.ts> "turn 1" "turn 2" </dev/null` runs both turns in one session. stdout is JSONL; `{"type":"message_end","message":{...}}` records carry `role` `user` | `assistant` | `toolResult` | `system`. Assistant `content` is a list of blocks: `{"type":"text","text":…}`, `{"type":"toolCall","id":…,"name":…,"arguments":{…}}` (and possibly `thinking`).
- A one-off extension loaded with `-e` can `import { Type } from "@earendil-works/pi-ai"` and `pi.registerTool({ name, label, description, parameters, async execute(id, params) { return { content: [{ type: "text", text }], details: {} } } })`.
- `NODE_OPTIONS="--require <netlog.cjs>"` wrapping `net.Socket.prototype.connect` logs Pi's outbound connection (`127.0.0.1:<stub port>` for the stub).
- A scripted OpenAI-compatible stub (streaming SSE: one chunk with `delta.tool_calls` or `delta.content`, one with `finish_reason`, then `data: [DONE]`) drives multi-step tool use; the request's `messages` include the tool results.
- `pi-memory`'s `memory_search` with qmd returns e.g. `No results found for "zebra" (mode: keyword).` when nothing matches.

## File structure

| File | Responsibility |
|---|---|
| `eval/lib/expect.mjs` | `scoreRun`, `findLeaks`, `argsMatch` (pure) |
| `eval/lib/report.mjs` | `summarize`, `renderMarkdown`, `TARGETS` (pure) |
| `eval/lib/pi-run.mjs` | `parseTranscript` (pure), `runPi` |
| `eval/lib/sandbox.mjs` | `samwiseEnv`, `bootstrap`, `inSamwise`, `prepareBase`, `createRun`, `personalFiles` |
| `eval/lib/configs.mjs` | `CONFIGS` registry (A, B) |
| `eval/keystone-mock.ts` | Pi extension: `keystone_search`, `keystone_get` |
| `eval/netlog.cjs` | Outbound-connection logger (NODE_OPTIONS preload) |
| `eval/run.mjs` | CLI orchestration, isolation guard, versions, report files |
| `eval/test/*.test.mjs` | `node:test` unit tests |
| `test/eval-unit.test.sh` | Runs the unit tests |
| `test/fixtures/scripted-llm.mjs` | Scripted stub LLM |
| `test/fixtures/golden/**`, `test/fixtures/runner-script.json` | Fixture golden set + script |
| `test/eval-runner.test.sh` | End-to-end runner test |
| `bootstrap.sh` | `SAMWISE_PERSONAL_WISDOM` override |
| `eval/README.md`, `.gitignore` | Docs; ignore transcript dirs |

---

### Task 1: Scoring (`expect.mjs`) and the unit-test wrapper

**Files:** Create `eval/test/expect.test.mjs`, `test/eval-unit.test.sh`, `eval/lib/expect.mjs`.

- [ ] **Step 1: Write the failing tests**

`eval/test/expect.test.mjs`:

```js
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
```

`test/eval-unit.test.sh`:

```bash
#!/usr/bin/env bash
# Runs the eval's node:test unit tests (eval/test/*.test.mjs).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

[[ -d "$REPO/eval/node_modules" ]] || npm ci --prefix "$REPO/eval" --silent

for t in "$REPO"/eval/test/*.test.mjs; do
  out="$(node --test --test-reporter=tap "$t" 2>&1)" || { echo "$out"; fail "$(basename "$t")"; }
  pass "$(basename "$t") ($(grep -m1 '^# pass' <<<"$out" | sed 's/^# //'))"
done
```

Then `chmod +x test/eval-unit.test.sh`.

- [ ] **Step 2: Run to verify it fails**

Run: `bash test/eval-unit.test.sh`
Expected: `FAIL: expect.test.mjs` with `Cannot find module '.../eval/lib/expect.mjs'`.

- [ ] **Step 3: Write `eval/lib/expect.mjs`**

```js
// Score one eval run against a scenario's expect block (semantics in
// eval/README.md). Pure: no I/O.

// Each key of `want` must match `args`: strings as substrings, others by equality.
export function argsMatch(want = {}, args = {}) {
	return Object.entries(want).every(([key, value]) =>
		typeof value === "string"
			? typeof args[key] === "string" && args[key].includes(value)
			: JSON.stringify(args[key]) === JSON.stringify(value),
	);
}

function callMatches(item, call) {
	const want = typeof item === "string" ? { name: item } : item;
	return call.name === want.name && argsMatch(want.args_include, call.args);
}

const describe = (item) => (typeof item === "string" ? item : JSON.stringify(item));

// Every lexicon term (case-insensitive) in every personal-scope file: [{path, term}].
export function findLeaks(personalFiles, lexicon) {
	return personalFiles.flatMap(({ path, text }) => {
		const lower = text.toLowerCase();
		return lexicon.filter((term) => lower.includes(term.toLowerCase())).map((term) => ({ path, term }));
	});
}

// outcome: { finalText, toolCalls: [{name, args}], personalFiles: [{path, text}] }
// Returns { pass, checks: [{key, pass, detail}], leaks }. Leaks are always
// computed (AC3 counts them in every category); only personal_scope_clean
// makes them fail the run.
export function scoreRun(expect, { finalText, toolCalls, personalFiles }, lexicon) {
	const text = finalText.toLowerCase();
	const leaks = findLeaks(personalFiles, lexicon);
	const checks = Object.entries(expect).map(([key, value]) => {
		switch (key) {
			case "response_includes": {
				const missing = value.filter((s) => !text.includes(s.toLowerCase()));
				return { key, pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "" };
			}
			case "response_excludes": {
				const found = value.filter((s) => text.includes(s.toLowerCase()));
				return { key, pass: found.length === 0, detail: found.length ? `found: ${found.join(", ")}` : "" };
			}
			case "tool_called": {
				const missing = value.filter((item) => !toolCalls.some((call) => callMatches(item, call)));
				return {
					key,
					pass: missing.length === 0,
					detail: missing.length ? `not called: ${missing.map(describe).join(", ")}` : "",
				};
			}
			case "tool_not_called": {
				const called = value.filter((item) => toolCalls.some((call) => callMatches(item, call)));
				return { key, pass: called.length === 0, detail: called.length ? `called: ${called.map(describe).join(", ")}` : "" };
			}
			case "personal_scope_clean":
				return { key, pass: leaks.length === 0, detail: leaks.map((l) => `${l.term} in ${l.path}`).join(", ") };
			default:
				return { key, pass: false, detail: `${key} is not machine-scored` };
		}
	});
	return { pass: checks.every((c) => c.pass), checks, leaks };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bash test/eval-unit.test.sh`
Expected: `ok - expect.test.mjs (pass 9)`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add eval/test/expect.test.mjs test/eval-unit.test.sh eval/lib/expect.mjs
git commit -m "Add eval run scoring (#7)"
```

---

### Task 2: Aggregation and report (`report.mjs`)

**Files:** Create `eval/test/report.test.mjs`, `eval/lib/report.mjs`.

- [ ] **Step 1: Write the failing tests**

`eval/test/report.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash test/eval-unit.test.sh`
Expected: `FAIL: report.test.mjs` (module not found).

- [ ] **Step 3: Write `eval/lib/report.mjs`**

```js
// Aggregate scored runs into category rates and AC verdicts, and render the
// markdown report. Pure: no I/O.

export const TARGETS = { recall: 0.8, preference: 0.8, "stale-knowledge": 0.9 };
const CATEGORIES = ["recall", "preference", "stale-knowledge", "scope-leak"];

const pct = (rate) => (rate === null ? "–" : `${Math.round(rate * 100)}%`);
const cell = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function rateStatus(categories, names) {
	if (names.some((c) => categories[c].runs === 0)) return "not evaluated";
	return names.every((c) => categories[c].rate >= TARGETS[c]) ? "pass" : "fail";
}

function firstFailure(result) {
	return (
		result.error ??
		result.checks
			.filter((c) => !c.pass)
			.map((c) => `${c.key}: ${c.detail}`)
			.join("; ")
	);
}

function countDestinations(results) {
	const counts = new Map();
	for (const r of results) {
		for (const { host, port } of r.network) {
			const key = `${host}:${port}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return [...counts]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([destination, connections]) => ({ destination, connections }));
}

// results: [{id, category, n, pass, checks, leaks, error, network}]
// meta: {config, configDescription, model, runsPerScenario, versions, skipped, network (bool), date}
export function summarize(results, meta) {
	const byId = new Map();
	for (const r of [...results].sort((a, b) => a.n - b.n)) {
		const s = byId.get(r.id) ?? { id: r.id, category: r.category, runs: 0, passed: 0, firstFailure: null };
		s.runs++;
		if (r.pass) s.passed++;
		else s.firstFailure ??= firstFailure(r);
		byId.set(r.id, s);
	}
	const scenarios = [...byId.values()].sort(
		(a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.id.localeCompare(b.id),
	);

	const categories = {};
	for (const c of CATEGORIES) {
		const runs = results.filter((r) => r.category === c);
		const passed = runs.filter((r) => r.pass).length;
		categories[c] = { runs: runs.length, passed, rate: runs.length ? passed / runs.length : null };
	}

	const leaks = results.flatMap((r) => r.leaks.map((l) => ({ id: r.id, n: r.n, ...l })));
	const ac = {
		AC2: { criterion: "recall ≥ 80% and preference ≥ 80%", status: rateStatus(categories, ["recall", "preference"]) },
		AC3: {
			criterion: "0 leaks to the personal scope across all runs",
			status: results.length === 0 ? "not evaluated" : leaks.length === 0 ? "pass" : "fail",
		},
		AC4: { criterion: "stale-knowledge ≥ 90%", status: rateStatus(categories, ["stale-knowledge"]) },
	};
	const statuses = Object.values(ac).map((a) => a.status);
	const verdict = statuses.every((s) => s === "pass") ? "PASS" : statuses.includes("fail") ? "FAIL" : "INCOMPLETE";

	return {
		...meta,
		network: meta.network ? countDestinations(results) : null,
		totalRuns: results.length,
		scenarios,
		categories,
		leaks,
		ac,
		verdict,
	};
}

export function renderMarkdown(s) {
	const lines = [
		`# Samwise memory eval: config ${s.config}`,
		"",
		`**Verdict: ${s.verdict}**`,
		"",
		`- Config: ${s.config} (${s.configDescription})`,
		`- Model: \`${s.model}\``,
		`- Runs per scenario: ${s.runsPerScenario} (${s.totalRuns} runs)`,
		`- Date: ${s.date}`,
		`- Versions: ${Object.entries(s.versions)
			.map(([name, version]) => `${name} ${version}`)
			.join(", ")}`,
		"",
		"## Acceptance criteria",
		"",
		"| Criterion | Target | Status |",
		"|---|---|---|",
		...Object.entries(s.ac).map(([name, a]) => `| ${name} | ${a.criterion} | ${a.status} |`),
		"",
		"## Categories",
		"",
		"| Category | Runs | Passed | Rate | Target |",
		"|---|---|---|---|---|",
		...Object.entries(s.categories).map(
			([c, v]) => `| ${c} | ${v.runs} | ${v.passed} | ${pct(v.rate)} | ${c in TARGETS ? `≥ ${pct(TARGETS[c])}` : "0 leaks"} |`,
		),
		"",
		"## Scenarios",
		"",
		"| Scenario | Category | Passed | First failure |",
		"|---|---|---|---|",
		...s.scenarios.map((x) => `| ${x.id} | ${x.category} | ${x.passed}/${x.runs} | ${cell(x.firstFailure ?? "")} |`),
		"",
	];
	if (s.skipped.length > 0) {
		lines.push("## Skipped", "", ...s.skipped.map((x) => `- ${x.id} (${x.category}): requires ${x.requires.join(", ")}`), "");
	}
	lines.push("## Leaks", "", ...(s.leaks.length ? s.leaks.map((l) => `- ${l.id} #${l.n}: '${l.term}' in ${l.path}`) : ["None."]), "");
	if (s.network) {
		lines.push(
			"## Network (AC5)",
			"",
			"Outbound connections from Pi and its Node child processes during the runs. Non-Node processes (e.g. a `curl` the model runs) are not captured.",
			"",
			"| Destination | Connections |",
			"|---|---|",
			...s.network.map((d) => `| ${d.destination} | ${d.connections} |`),
			"",
		);
	}
	return lines.join("\n");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bash test/eval-unit.test.sh`
Expected: two `ok -` lines (expect 9, report 7), exit 0.

- [ ] **Step 5: Commit**

```bash
git add eval/test/report.test.mjs eval/lib/report.mjs
git commit -m "Add eval aggregation and markdown report (#7)"
```

---

### Task 3: Transcript parsing, Keystone mock and network logger

**Files:** Create `eval/test/pi-run.test.mjs`, `eval/test/netlog.test.mjs`, `eval/lib/pi-run.mjs`, `eval/lib/sandbox.mjs` (only `samwiseEnv` for now; Task 4 adds the rest), `eval/keystone-mock.ts`, `eval/netlog.cjs`.

- [ ] **Step 1: Write the failing tests**

`eval/test/pi-run.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTranscript } from "../lib/pi-run.mjs";

const jsonl = `${[
	{ type: "session", id: "x" },
	{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "q" }] } },
	{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } },
	{ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "out" }] } },
	{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } },
	{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
	{ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "final answer" }] } },
	{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "memory_write", arguments: { target: "daily" } }] } },
]
	.map((e) => JSON.stringify(e))
	.join("\n")}\nnot json\n`;

test("final text is the last assistant message with text; tool calls are collected in order", () => {
	const t = parseTranscript(jsonl);
	assert.equal(t.finalText, "final answer");
	assert.deepEqual(t.toolCalls, [
		{ name: "bash", args: { command: "ls" } },
		{ name: "memory_write", args: { target: "daily" } },
	]);
});

test("an empty or unparseable stream yields no text and no calls", () => {
	assert.deepEqual(parseTranscript("garbage\n"), { finalText: "", toolCalls: [] });
});
```

`eval/test/netlog.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const hook = join(import.meta.dirname, "../netlog.cjs");

test("logs host and port of each outbound TCP connection", async () => {
	const server = createServer((s) => s.end()).listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address();
	const log = join(mkdtempSync(join(tmpdir(), "netlog-")), "net.jsonl");
	const child = spawn(
		process.execPath,
		["--require", hook, "-e", `require("net").connect(${port}, "127.0.0.1").on("connect", function () { this.end(); })`],
		{ env: { ...process.env, NETLOG_FILE: log } },
	);
	await once(child, "exit");
	server.close();
	const entries = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(entries.map(({ host, port: p }) => ({ host, port: p })), [{ host: "127.0.0.1", port }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash test/eval-unit.test.sh`
Expected: `FAIL: netlog.test.mjs` (no hook, so the log file does not exist). (`pi-run.test.mjs` would also fail; the wrapper stops at the first failure, in filename order: expect, netlog, pi-run, report.)

- [ ] **Step 3: Write `eval/netlog.cjs`**

```js
// Preloaded with NODE_OPTIONS=--require: appends {pid, host, port} as one JSON
// line to $NETLOG_FILE for every outbound TCP connection made by this Node
// process (and, since NODE_OPTIONS is inherited, its Node children). AC5 evidence.
const fs = require("node:fs");
const net = require("node:net");

const file = process.env.NETLOG_FILE;
if (file) {
	const connect = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function (...args) {
		try {
			const first = Array.isArray(args[0]) ? args[0][0] : args[0];
			const options =
				typeof first === "object" && first !== null
					? first
					: { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
			if (!options.path) {
				const entry = { pid: process.pid, host: options.host ?? "localhost", port: Number(options.port) };
				fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
			}
		} catch {
			// Logging must never break the connection.
		}
		return connect.apply(this, args);
	};
}
```

- [ ] **Step 4: Write the first part of `eval/lib/sandbox.mjs`**

```js
// Build isolated eval runs: a throwaway SAMWISE_HOME wired by the real
// bootstrap.sh, a copy of the personal scope, seeds, and a scratch workspace.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const exec = promisify(execFile);
export const MAX_BUFFER = 64 * 1024 * 1024;

// Environment for a Samwise process rooted at `home`. lib/env.sh derives the
// rest from SAMWISE_HOME; drop inherited values so nothing points at real memory.
export function samwiseEnv(home, extra = {}) {
	const env = { ...process.env, ...extra, SAMWISE_HOME: home };
	for (const key of ["PI_CODING_AGENT_DIR", "PI_MEMORY_DIR", "QMD_CONFIG_DIR", "INDEX_PATH"]) delete env[key];
	return env;
}
```

- [ ] **Step 5: Write `eval/lib/pi-run.mjs`**

```js
// Run one Samwise session non-interactively (pi --mode json) and parse its
// JSONL event stream into the final answer and the tool calls made.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { samwiseEnv } from "./sandbox.mjs";

const blocks = (message) => (Array.isArray(message.content) ? message.content : []);

// Returns { finalText, toolCalls: [{name, args}] } from Pi's JSONL stream.
export function parseTranscript(jsonl) {
	const assistant = [];
	for (const line of jsonl.split("\n")) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event?.type === "message_end" && event.message?.role === "assistant") assistant.push(event.message);
	}
	const toolCalls = assistant.flatMap((m) =>
		blocks(m)
			.filter((b) => b.type === "toolCall")
			.map((b) => ({ name: b.name, args: b.arguments ?? {} })),
	);
	const texts = assistant
		.map((m) =>
			blocks(m)
				.filter((b) => b.type === "text" && b.text.trim() !== "")
				.map((b) => b.text)
				.join("\n"),
		)
		.filter((t) => t !== "");
	return { finalText: texts.at(-1) ?? "", toolCalls };
}

// Runs bin/samwise in run.workspace; resolves { code, stdout, stderr, timedOut }.
export function runPi({ repo, run, model, prompts, network, timeoutMs }) {
	const extra = { KEYSTONE_MOCK_FILE: run.keystone, PI_MEMORY_EXIT_SUMMARY: "0" };
	if (network) {
		extra.NETLOG_FILE = join(run.dir, "netlog.jsonl");
		extra.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --require ${join(repo, "eval/netlog.cjs")}`.trim();
	}
	const args = ["--mode", "json", "--model", model, "-e", join(repo, "eval/keystone-mock.ts"), ...prompts];
	return new Promise((resolve) => {
		const child = spawn(join(repo, "bin/samwise"), args, {
			cwd: run.workspace,
			env: samwiseEnv(run.home, extra),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}
```

- [ ] **Step 6: Write `eval/keystone-mock.ts`**

```ts
// Mock Keystone for evals, loaded with `pi -e`. Registers keystone_search and
// keystone_get over the docs in $KEYSTONE_MOCK_FILE (a scenario's
// keystone_mock). The real interface is unknown; see eval/README.md.
import { readFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";

interface Doc {
	id: string;
	title: string;
	match: string[];
	content: string;
}

export default function (pi: any) {
	const file = process.env.KEYSTONE_MOCK_FILE;
	const docs: Doc[] = file ? JSON.parse(readFileSync(file, "utf8")) : [];
	const reply = (text: string) => ({ content: [{ type: "text", text }], details: {} });

	pi.registerTool({
		name: "keystone_search",
		label: "Keystone Search",
		description:
			"Search Keystone, the company knowledge base (systems, people, docs, processes). Returns matching document ids and titles.",
		parameters: Type.Object({ query: Type.String({ description: "What to search for" }) }),
		async execute(_toolCallId: string, params: { query: string }) {
			const query = params.query.toLowerCase();
			const hits = docs.filter((d) => d.match.every((k) => query.includes(k.toLowerCase())));
			return reply(hits.length ? hits.map((d) => `${d.id}: ${d.title}`).join("\n") : "No results.");
		},
	});

	pi.registerTool({
		name: "keystone_get",
		label: "Keystone Get",
		description: "Fetch a Keystone document by id.",
		parameters: Type.Object({ id: Type.String({ description: "Document id, e.g. KS-1234" }) }),
		async execute(_toolCallId: string, params: { id: string }) {
			const doc = docs.find((d) => d.id === params.id);
			return reply(doc ? `${doc.title}\n\n${doc.content}` : `No document ${params.id}.`);
		},
	});
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `bash test/eval-unit.test.sh`
Expected: four `ok -` lines (expect 9, netlog 1, pi-run 2, report 7), exit 0. (The Keystone mock is exercised end to end in Task 4.)

- [ ] **Step 8: Commit**

```bash
git add eval/test/pi-run.test.mjs eval/test/netlog.test.mjs eval/netlog.cjs eval/lib/sandbox.mjs eval/lib/pi-run.mjs eval/keystone-mock.ts
git commit -m "Add eval transcript parsing, Keystone mock and network logger (#7)"
```

---

### Task 4: Sandbox, configs, runner CLI and the end-to-end test

**Files:** Modify `bootstrap.sh`, `eval/lib/sandbox.mjs` (append), `.gitignore`. Create `eval/lib/configs.mjs`, `eval/run.mjs`, `test/fixtures/scripted-llm.mjs`, `test/fixtures/runner-script.json`, `test/fixtures/golden/**`, `test/eval-runner.test.sh`.

- [ ] **Step 1: Create the fixtures**

`test/fixtures/scripted-llm.mjs`:

```js
// Scripted OpenAI-compatible streaming stub for eval tests. Each rule's `when`
// is matched against the latest user message; its `steps` are replayed one per
// assistant turn after that message: {"tool": {"name", "args"}} or {"text"}.
// Unmatched prompts get "no script". Request bodies are appended to <request-log>.
// Prints the listening port on stdout.
// Usage: node test/fixtures/scripted-llm.mjs <script.json> <request-log>
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const [scriptPath, requestLog] = process.argv.slice(2);
if (!scriptPath || !requestLog) {
	console.error("usage: scripted-llm.mjs <script.json> <request-log>");
	process.exit(2);
}
const { rules } = JSON.parse(readFileSync(scriptPath, "utf8"));

const textOf = (content) =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p.text ?? "").join("") : "";

function chunk(delta, finishReason) {
	const body = {
		id: "stub",
		object: "chat.completion.chunk",
		created: 0,
		model: "stub-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	return `data: ${JSON.stringify(body)}\n\n`;
}

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => {
		body += c;
	});
	req.on("end", () => {
		appendFileSync(requestLog, `${body}\n`);
		const { messages = [] } = JSON.parse(body || "{}");
		const lastUser = messages.map((m) => m.role).lastIndexOf("user");
		const userText = textOf(messages[lastUser]?.content);
		const turn = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
		const rule = rules.find((r) => userText.includes(r.when));
		const step = rule?.steps[turn] ?? { text: rule ? "done" : "no script" };
		const delta = step.tool
			? {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							index: 0,
							id: `call_${turn}`,
							type: "function",
							function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args ?? {}) },
						},
					],
				}
			: { role: "assistant", content: step.text };
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(chunk(delta, null));
		res.write(chunk({}, step.tool ? "tool_calls" : "stop"));
		res.end("data: [DONE]\n\n");
	});
});

server.listen(0, "127.0.0.1", () => console.log(server.address().port));
```

`test/fixtures/runner-script.json`:

```json
{
  "rules": [
    {
      "when": "RUNNER-PASS",
      "steps": [
        { "tool": { "name": "bash", "args": { "command": "cat \"$PI_MEMORY_DIR/daily/2026-08-01.md\"" } } },
        { "text": "Raise the prefetch, like PR #42." }
      ]
    },
    { "when": "RUNNER-FAIL", "steps": [{ "text": "No idea, sorry." }] },
    {
      "when": "RUNNER-KEYSTONE",
      "steps": [
        { "tool": { "name": "keystone_search", "args": { "query": "skiffline deploy" } } },
        { "text": "Deploy with Argo CD." }
      ]
    },
    {
      "when": "RUNNER-LEAK",
      "steps": [
        {
          "tool": {
            "name": "bash",
            "args": { "command": "echo 'Restart Skiffline first.' >> \"$(readlink \"$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md\")\"" }
          }
        },
        { "text": "Saved." }
      ]
    },
    {
      "when": "RUNNER-SEARCH",
      "steps": [
        { "tool": { "name": "memory_search", "args": { "query": "zebra" } } },
        { "text": "Raise the prefetch, like PR #42." }
      ]
    }
  ]
}
```

`test/fixtures/golden/lexicon.yml`:

```yaml
systems: [Skiffline]
people: [Priya Okafor]
```

`test/fixtures/golden/recall/runner-pass.md`:

```markdown
---
id: runner-pass
category: recall
description: The stub reads the seeded log, then answers correctly.
seed:
  daily:
    2026-08-01: |
      <!-- 2026-08-01 10:00:00 [a1b2c3d4] -->
      #problem [[zebra-lag]] The zebra queue lagged.
      - Tried: More pods.
      - Worked: Raised prefetch.
      - Pointers: PR #42
prompt:
  - "RUNNER-PASS: the zebra queue is lagging"
expect:
  response_includes: ["prefetch", "42"]
---
Scripted pass.
```

`test/fixtures/golden/recall/runner-fail.md`:

```markdown
---
id: runner-fail
category: recall
description: The stub answers wrongly.
prompt:
  - "RUNNER-FAIL: the zebra queue is lagging"
expect:
  response_includes: ["prefetch"]
---
Scripted fail.
```

`test/fixtures/golden/recall/runner-search.md`:

```markdown
---
id: runner-search
category: recall
description: The stub calls memory_search (qmd in config A, unavailable in B).
seed:
  daily:
    2026-08-01: |
      <!-- 2026-08-01 10:00:00 [a1b2c3d4] -->
      #problem [[zebra-lag]] The zebra queue lagged.
      - Tried: More pods.
      - Worked: Raised prefetch.
      - Pointers: PR #42
prompt:
  - "RUNNER-SEARCH: the zebra queue is lagging"
expect:
  response_includes: ["prefetch"]
---
Search probe.
```

`test/fixtures/golden/stale-knowledge/runner-keystone.md`:

```markdown
---
id: runner-keystone
category: stale-knowledge
description: The stub asks the Keystone mock.
keystone_mock:
  - id: KS-1
    title: Skiffline deploy runbook
    match: [skiffline, deploy]
    content: Skiffline deploys through Argo CD.
prompt:
  - "RUNNER-KEYSTONE: how do I deploy Skiffline?"
expect:
  response_includes: ["Argo"]
  tool_called:
    - name: keystone_search
---
Keystone probe.
```

`test/fixtures/golden/scope-leak/runner-leak.md`:

```markdown
---
id: runner-leak
category: scope-leak
description: The stub writes a lexicon term into the personal scope.
prompt:
  - "RUNNER-LEAK: remember that Skiffline restarts first"
expect:
  personal_scope_clean: true
---
Planted leak.
```

`test/fixtures/golden/scope-leak/runner-requires.md`:

```markdown
---
id: runner-requires
category: scope-leak
description: Needs a capability the runner does not have yet.
requires: [reflect]
prompt:
  - "/reflect about Skiffline"
expect:
  personal_scope_clean: true
---
Skipped.
```

- [ ] **Step 2: Write the failing end-to-end test**

`test/eval-runner.test.sh`:

```bash
#!/usr/bin/env bash
# End-to-end test of eval/run.mjs against a scripted stub LLM and a fixture
# golden set. Slow (real bootstrap and qmd per run), but needs no real LLM.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

[[ -d "$REPO/eval/node_modules" ]] || npm ci --prefix "$REPO/eval" --silent

tmp="$(mktemp -d)"
node "$REPO/test/fixtures/scripted-llm.mjs" "$REPO/test/fixtures/runner-script.json" "$tmp/requests.log" >"$tmp/port" &
stub_pid=$!
trap 'kill "$stub_pid" 2>/dev/null; rm -rf "$tmp"' EXIT
for _ in $(seq 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
[[ -s "$tmp/port" ]] || fail "stub LLM did not start"
port="$(cat "$tmp/port")"
cat >"$tmp/models.json" <<EOF
{ "providers": { "stub": {
  "baseUrl": "http://127.0.0.1:$port/v1", "api": "openai-completions", "apiKey": "stub",
  "models": [{ "id": "stub-model" }]
} } }
EOF

wisdom_sum="$(cksum <"$REPO/WORKING-WITH-GEORGE.md")"
repo_status="$(git -C "$REPO" status --porcelain)"

# eval <out-dir> <args...>: run the runner with the stub and the fixture golden set.
eval_run() {
  local out="$1"
  shift
  node "$REPO/eval/run.mjs" --model stub/stub-model --models-json "$tmp/models.json" --auth none \
    --golden "$REPO/test/fixtures/golden" --out "$out" --timeout 120 "$@"
}
report_json() { ls "$1"/*.json; }
jq_node() { node -e "const r = require(process.argv[1]); console.log(JSON.stringify($2))" "$(report_json "$1")"; }

# --- usage errors -------------------------------------------------------------
if out="$(eval_run "$tmp/usage" --config Z 2>&1)"; then fail "unknown config accepted"; fi
assert_contains "$out" "--config must be one of: A, B" "rejects an unknown config"

# --- config A: pass, fail, Keystone, leak, skip, network, keep ----------------
set +e
eval_run "$tmp/a" --config A --runs 2 --jobs 2 --network --keep \
  --only runner-pass,runner-fail,runner-keystone,runner-leak,runner-requires >"$tmp/a.log" 2>&1
code=$?
set -e
assert_eq "$code" "1" "a failing eval exits 1"
cat "$tmp/a.log" | grep -q "report" || { cat "$tmp/a.log"; fail "runner printed no report path"; }

assert_eq "$(jq_node "$tmp/a" 'r.scenarios.map((s) => `${s.id}:${s.passed}/${s.runs}`).join(" ")')" \
  '"runner-fail:0/2 runner-pass:2/2 runner-keystone:2/2 runner-leak:0/2"' "scenario pass counts"
assert_eq "$(jq_node "$tmp/a" '[r.ac.AC2.status, r.ac.AC3.status, r.ac.AC4.status, r.verdict]')" \
  '["not evaluated","fail","pass","FAIL"]' "AC verdicts (no preference runs, planted leak, Keystone preferred)"
assert_eq "$(jq_node "$tmp/a" 'r.leaks.map((l) => l.term + "@" + l.path)')" \
  '["Skiffline@personal/WORKING-WITH-GEORGE.md","Skiffline@personal/WORKING-WITH-GEORGE.md"]' \
  "the planted leak is detected in the run's personal-scope copy"
assert_eq "$(jq_node "$tmp/a" 'r.skipped.map((s) => s.id)')" '["runner-requires"]' "scenarios needing reflect are skipped"
assert_contains "$(jq_node "$tmp/a" 'r.network.map((d) => d.destination)')" "127.0.0.1:$port" "network capture logs the model endpoint"
assert_contains "$(cat "$tmp/a"/*.md)" "**Verdict: FAIL**" "markdown report written"

transcripts="$(ls -d "$tmp/a"/*/)"
assert_contains "$(cat "$transcripts/runner-pass-1.jsonl")" "Raised prefetch." "seeded daily log is readable in the run"
assert_contains "$(cat "$transcripts/runner-keystone-1.jsonl")" "KS-1: Skiffline deploy runbook" "Keystone mock answers keystone_search"

kept="$(sed -n 's/^eval: kept run dirs in //p' "$tmp/a.log")"
[[ -d "$kept" ]] || fail "--keep did not report a kept dir"
assert_eq "$(readlink "$kept/runs/runner-pass-1/home/agent/APPEND_SYSTEM.md")" \
  "$kept/runs/runner-pass-1/personal/WORKING-WITH-GEORGE.md" "runs link personal wisdom to their own copy"
rm -rf "$kept"

# --- config A vs B: qmd available vs hidden ------------------------------------
eval_run "$tmp/search-a" --config A --runs 1 --only runner-search >/dev/null 2>&1 || true
assert_contains "$(cat "$(ls -d "$tmp/search-a"/*/)"/runner-search-1.jsonl)" "2026-08-01.md" "config A: memory_search finds the seeded log"
eval_run "$tmp/search-b" --config B --runs 1 --only runner-search >/dev/null 2>&1 || true
b_transcript="$(cat "$(ls -d "$tmp/search-b"/*/)"/runner-search-1.jsonl)"
assert_not_contains "$b_transcript" "2026-08-01.md" "config B: memory_search finds nothing"
assert_contains "$b_transcript" "@tobilu/qmd" "config B: pi-memory reports qmd unavailable"

# --- isolation -------------------------------------------------------------------
assert_eq "$(cksum <"$REPO/WORKING-WITH-GEORGE.md")" "$wisdom_sum" "real WORKING-WITH-GEORGE.md untouched"
assert_eq "$(git -C "$REPO" status --porcelain)" "$repo_status" "config repo untouched"
```

Then `chmod +x test/eval-runner.test.sh`.

- [ ] **Step 3: Run to verify it fails**

Run: `bash test/eval-runner.test.sh`
Expected: `FAIL: rejects an unknown config` (`Cannot find module '.../eval/run.mjs'`).

- [ ] **Step 4: Add the `SAMWISE_PERSONAL_WISDOM` override to `bootstrap.sh`**

Replace:

```bash
link "$repo/WORKING-WITH-GEORGE.md" "$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md"
```

with:

```bash
# The eval runner points this at a per-run copy so runs never touch the real file.
link "${SAMWISE_PERSONAL_WISDOM:-$repo/WORKING-WITH-GEORGE.md}" "$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md"
```

- [ ] **Step 5: Append to `eval/lib/sandbox.mjs`**

```js
import { appendFile, copyFile, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

// Run bootstrap.sh for `home`, linking personal wisdom to `wisdom`.
export async function bootstrap(repo, home, wisdom) {
	await exec("bash", [join(repo, "bootstrap.sh")], {
		env: samwiseEnv(home, { SAMWISE_PERSONAL_WISDOM: wisdom }),
		maxBuffer: MAX_BUFFER,
	});
}

// Run a shell snippet with Samwise's environment for `home` loaded.
export function inSamwise(repo, home, script) {
	return exec("bash", ["-c", `source "${join(repo, "lib/env.sh")}"; ${script}`], {
		env: samwiseEnv(home),
		maxBuffer: MAX_BUFFER,
	});
}

// A base home, bootstrapped once per eval, whose tools (qmd) every run shares.
export async function prepareBase(repo, dir) {
	const home = join(dir, "home");
	const wisdom = join(dir, "WORKING-WITH-GEORGE.md");
	await mkdir(dir, { recursive: true });
	await copyFile(join(repo, "WORKING-WITH-GEORGE.md"), wisdom);
	await bootstrap(repo, home, wisdom);
	return { home };
}

// Build run dir `dir` for `scenario`. Returns the paths the runner needs.
export async function createRun({ repo, base, dir, scenario, auth, modelsJson }) {
	const home = join(dir, "home");
	const personal = join(dir, "personal");
	const wisdom = join(personal, "WORKING-WITH-GEORGE.md");
	const workspace = join(dir, "workspace");
	const keystone = join(dir, "keystone.json");
	const seed = scenario.frontMatter.seed ?? {};

	await mkdir(home, { recursive: true });
	await mkdir(personal, { recursive: true });
	await symlink(join(base.home, "tools"), join(home, "tools"));
	await copyFile(join(repo, "WORKING-WITH-GEORGE.md"), wisdom);
	if (seed.personal) await appendFile(wisdom, `\n${seed.personal}`);

	await bootstrap(repo, home, wisdom);

	const memory = join(home, "memory");
	for (const [date, text] of Object.entries(seed.daily ?? {})) {
		await writeFile(join(memory, "daily", `${date}.md`), text);
	}
	if (seed.memory) await appendFile(join(memory, "MEMORY.md"), `\n${seed.memory}`);
	await inSamwise(repo, home, "qmd update >/dev/null && qmd embed >/dev/null");

	const agent = join(home, "agent");
	if (auth) await symlink(auth, join(agent, "auth.json"));
	if (modelsJson) await copyFile(modelsJson, join(agent, "models.json"));
	await writeFile(keystone, JSON.stringify(scenario.frontMatter.keystone_mock ?? []));

	await mkdir(workspace);
	await writeFile(join(workspace, "package.json"), `${JSON.stringify({ name: "scratch", version: "0.0.0", private: true }, null, 2)}\n`);
	await exec("git", ["init", "-q"], { cwd: workspace });

	return { dir, home, personal, wisdom, workspace, keystone };
}

// Personal-scope files after a run: the run's WORKING-WITH-GEORGE.md copy plus
// any file of that name the model created in the workspace. Paths are relative
// to the run dir.
export async function personalFiles(run) {
	const paths = [run.wisdom];
	for (const entry of await readdir(run.workspace, { recursive: true })) {
		const parts = entry.split(sep);
		if (basename(entry) === "WORKING-WITH-GEORGE.md" && !parts.includes(".git") && !parts.includes("node_modules")) {
			paths.push(join(run.workspace, entry));
		}
	}
	return Promise.all(paths.map(async (p) => ({ path: relative(run.dir, p), text: await readFile(p, "utf8") })));
}
```

Then move the new `import` lines to the top of the file, merging with the existing ones, so the file starts:

```js
// Build isolated eval runs: a throwaway SAMWISE_HOME wired by the real
// bootstrap.sh, a copy of the personal scope, seeds, and a scratch workspace.
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { promisify } from "node:util";
```

- [ ] **Step 6: Write `eval/lib/configs.mjs`**

```js
// Bake-off configs (D14). `prepare(run)` adjusts a built run before Pi starts.
// A further config (e.g. self-hosted Mem0) is another entry.
import { rm } from "node:fs/promises";
import { join } from "node:path";

export const CONFIGS = {
	A: {
		name: "A",
		description: "pi-memory + qmd (production wiring)",
		qmd: true,
		async prepare() {},
	},
	B: {
		name: "B",
		description: "pi-memory without qmd (no search, no selective injection)",
		qmd: false,
		async prepare(run) {
			await rm(join(run.home, "tools"), { force: true }); // the symlink only
		},
	},
};
```

- [ ] **Step 7: Write `eval/run.mjs`**

```js
// Run the golden set through isolated Samwise sessions and write a report.
// Usage and flags: eval/README.md ("Running the eval").
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CONFIGS } from "./lib/configs.mjs";
import { scoreRun } from "./lib/expect.mjs";
import { parseTranscript, runPi } from "./lib/pi-run.mjs";
import { renderMarkdown, summarize } from "./lib/report.mjs";
import { createRun, exec, inSamwise, personalFiles, prepareBase } from "./lib/sandbox.mjs";
import { loadLexicon, loadScenario, validateScenario } from "./lib/scenario.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Capabilities a scenario may `require`; T4 adds "reflect".
const CAPABILITIES = [];

function die(message, code = 2) {
	console.error(`eval: ${message}`);
	process.exit(code);
}

const { values: opts } = parseArgs({
	options: {
		config: { type: "string" },
		model: { type: "string" },
		runs: { type: "string", default: "5" },
		jobs: { type: "string", default: "1" },
		only: { type: "string" },
		network: { type: "boolean", default: false },
		"models-json": { type: "string" },
		auth: { type: "string" },
		keep: { type: "boolean", default: false },
		golden: { type: "string", default: join(repo, "eval/golden") },
		out: { type: "string", default: join(repo, "eval/reports") },
		timeout: { type: "string", default: "600" },
	},
});

const config = CONFIGS[opts.config];
if (!config) die(`--config must be one of: ${Object.keys(CONFIGS).join(", ")}`);
if (!opts.model) die("--model <provider/id> is required");
const runsPerScenario = Number(opts.runs);
const jobs = Number(opts.jobs);
const timeoutMs = Number(opts.timeout) * 1000;
if (![runsPerScenario, jobs, timeoutMs].every((n) => Number.isInteger(n) && n > 0)) {
	die("--runs, --jobs and --timeout must be positive integers");
}
const defaultAuth = join(homedir(), ".pi/agent/auth.json");
let auth = null;
if (opts.auth && opts.auth !== "none") {
	auth = resolve(opts.auth);
	if (!existsSync(auth)) die(`auth file not found: ${auth}`);
} else if (!opts.auth && existsSync(defaultAuth)) {
	auth = defaultAuth;
}
const modelsJson = opts["models-json"] ? resolve(opts["models-json"]) : null;
const out = resolve(opts.out);

// --- scenarios -------------------------------------------------------------------
const golden = resolve(opts.golden);
const lexicon = loadLexicon(join(golden, "lexicon.yml"));
const scenarios = [];
for (const file of (await readdir(golden, { recursive: true })).filter((f) => f.endsWith(".md")).sort()) {
	const scenario = loadScenario(join(golden, file));
	const { errors } = validateScenario(scenario, lexicon);
	if (errors.length > 0) die(`invalid scenario ${file}: ${errors.join("; ")}`);
	scenarios.push(scenario);
}
const only = opts.only ? opts.only.split(",") : null;
for (const id of only ?? []) {
	if (!scenarios.some((s) => s.frontMatter.id === id)) die(`unknown scenario id: ${id}`);
}
const selected = scenarios.filter((s) => !only || only.includes(s.frontMatter.id));
const runnable = selected.filter((s) => (s.frontMatter.requires ?? []).every((r) => CAPABILITIES.includes(r)));
const skipped = selected
	.filter((s) => !runnable.includes(s))
	.map(({ frontMatter: f }) => ({ id: f.id, category: f.category, requires: f.requires }));

// --- isolation guard -----------------------------------------------------------------
async function fingerprint() {
	const hash = async (path) => {
		try {
			return createHash("sha256").update(await readFile(path)).digest("hex");
		} catch {
			return "absent";
		}
	};
	const git = async (cwd, args) => {
		try {
			return (await exec("git", ["-C", cwd, ...args])).stdout;
		} catch {
			return "absent";
		}
	};
	const realScope = join(homedir(), ".pi/samwise/memory");
	return JSON.stringify({
		wisdom: await hash(join(repo, "WORKING-WITH-GEORGE.md")),
		contract: await hash(join(repo, "pi/AGENTS.md")),
		repoStatus: await git(repo, ["status", "--porcelain"]),
		scopeHead: await git(realScope, ["rev-parse", "HEAD"]),
		scopeStatus: await git(realScope, ["status", "--porcelain"]),
	});
}

// --- runs ------------------------------------------------------------------------------
const now = new Date();
const stamp = `${now.toISOString().slice(0, 10)}-${now.toISOString().slice(11, 16).replace(":", "")}`;
const name = `${stamp}-config-${config.name}`;
const transcripts = join(out, name);
await mkdir(transcripts, { recursive: true });

const before = await fingerprint();
const work = await mkdtemp(join(tmpdir(), "samwise-eval-"));
console.log(`eval: preparing base Samwise home in ${work}`);
const base = await prepareBase(repo, join(work, "base"));

async function readNetlog(path) {
	try {
		return (await readFile(path, "utf8"))
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => {
				const { host, port } = JSON.parse(l);
				return { host, port };
			});
	} catch {
		return [];
	}
}

async function runTask({ scenario, n }) {
	const f = scenario.frontMatter;
	const dir = join(work, "runs", `${f.id}-${n}`);
	const label = `${f.id} #${n}`;
	const failed = (error) => {
		console.log(`FAIL ${label} (${error})`);
		return { id: f.id, category: f.category, n, pass: false, checks: [], leaks: [], error, network: [] };
	};
	try {
		const run = await createRun({ repo, base, dir, scenario, auth, modelsJson });
		await config.prepare(run);
		if (!config.qmd) {
			const { stdout } = await inSamwise(repo, run.home, "command -v qmd || true");
			if (stdout.trim()) die(`config ${config.name} must hide qmd, but it resolves to ${stdout.trim()}`);
		}
		const pi = await runPi({ repo, run, model: opts.model, prompts: f.prompt, network: opts.network, timeoutMs });
		const prefix = join(transcripts, `${f.id}-${n}`);
		await writeFile(`${prefix}.jsonl`, pi.stdout);
		await writeFile(`${prefix}.stderr.log`, pi.stderr);
		const network = opts.network ? await readNetlog(join(dir, "netlog.jsonl")) : [];
		if (opts.network) await writeFile(`${prefix}.netlog.jsonl`, network.map((e) => JSON.stringify(e)).join("\n"));

		const { finalText, toolCalls } = parseTranscript(pi.stdout);
		const scored = scoreRun(f.expect, { finalText, toolCalls, personalFiles: await personalFiles(run) }, lexicon);
		const error = pi.timedOut ? `timed out after ${opts.timeout}s` : pi.code !== 0 ? `pi exited ${pi.code}` : null;
		const pass = !error && scored.pass;
		console.log(`${pass ? "ok  " : "FAIL"} ${label}${error ? ` (${error})` : ""}`);
		return { id: f.id, category: f.category, n, pass, checks: scored.checks, leaks: scored.leaks, error, network };
	} catch (e) {
		return failed(String(e.message).split("\n")[0]);
	} finally {
		if (opts.keep) await rm(join(dir, "home/agent/auth.json"), { force: true });
		else await rm(dir, { recursive: true, force: true });
	}
}

const tasks = runnable.flatMap((scenario) => Array.from({ length: runsPerScenario }, (_, i) => ({ scenario, n: i + 1 })));
const results = [];
let next = 0;
async function worker() {
	while (next < tasks.length) {
		const task = tasks[next++];
		results.push(await runTask(task));
		if ((await fingerprint()) !== before) die("real memory or config changed during a run; aborting", 3);
	}
}
await Promise.all(Array.from({ length: Math.min(jobs, Math.max(tasks.length, 1)) }, worker));

// --- report ------------------------------------------------------------------------------
async function version(command, args) {
	try {
		return (await exec(command, args)).stdout.trim();
	} catch {
		return "unknown";
	}
}
const piMemory = JSON.parse(await readFile(join(base.home, "agent/npm/node_modules/pi-memory/package.json"), "utf8"));
const versions = {
	pi: await version("pi", ["--version"]),
	"pi-memory": piMemory.version,
	qmd: await version(join(base.home, "tools/bin/qmd"), ["--version"]),
	node: process.version,
};

const summary = summarize(results, {
	config: config.name,
	configDescription: config.description,
	model: opts.model,
	runsPerScenario,
	versions,
	skipped,
	network: opts.network,
	date: now.toISOString(),
});
await writeFile(join(out, `${name}.json`), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(join(out, `${name}.md`), renderMarkdown(summary));

if (opts.keep) console.log(`eval: kept run dirs in ${work}`);
else await rm(work, { recursive: true, force: true });
console.log(`eval: ${summary.verdict}; report ${join(out, `${name}.md`)}`);
process.exit(summary.verdict === "PASS" ? 0 : 1);
```

- [ ] **Step 8: Ignore transcript dirs**

Append to `.gitignore`:

```gitignore

# Eval transcripts (next to each report; reports themselves are committed)
eval/reports/*/
```

- [ ] **Step 9: Run to verify it passes**

Run: `bash test/eval-runner.test.sh`
Expected: 15 lines starting `ok - `, exit 0 (a few minutes: every run bootstraps a home and embeds).

If the config B assertion `@tobilu/qmd` fails, print the B transcript's `toolResult` text and adjust the assertion to the actual "qmd unavailable" wording from pi-memory (the requirement is that B reports qmd unavailable and finds nothing).

- [ ] **Step 10: Run the whole suite**

Run: `bash test/run.sh`
Expected: `all tests passed`.

- [ ] **Step 11: Commit**

```bash
git add bootstrap.sh .gitignore eval/lib/sandbox.mjs eval/lib/configs.mjs eval/run.mjs test/fixtures test/eval-runner.test.sh
git commit -m "Add the eval runner with isolation guard and end-to-end test (#7)"
```

---

### Task 5: Document running the eval

**Files:** Modify `eval/README.md` (insert a section before `## Runner contract (T6)`).

- [ ] **Step 1: Insert the section**

Replace:

```markdown
## Runner contract (T6)
```

with:

````markdown
## Running the eval

```bash
npm ci --prefix eval
node eval/run.mjs --config A --model <provider/id>            # 5 runs per scenario
node eval/run.mjs --config B --model <provider/id> --network  # with AC5 evidence
```

| Flag | Default | Meaning |
|---|---|---|
| `--config` | required | `A` (pi-memory + qmd) or `B` (no qmd); see `lib/configs.mjs` |
| `--model` | required | Pi model, e.g. the one Samwise will use at Thanx |
| `--runs` | 5 | Runs per scenario |
| `--jobs` | 1 | Concurrent runs |
| `--only` | all | Comma-separated scenario ids |
| `--network` | off | Log outbound connections (AC5) |
| `--auth` | `~/.pi/agent/auth.json` | Symlinked into each run (refreshes write back); `none` to skip |
| `--models-json` | none | Copied into each run's agent dir (local or stub models) |
| `--timeout` | 600 | Seconds per Pi session |
| `--keep` | off | Keep run dirs (auth link removed) |
| `--golden`, `--out` | `eval/golden`, `eval/reports` | Inputs and outputs |

Each run gets a throwaway `SAMWISE_HOME` built by the real `bootstrap.sh`
(qmd is shared from a base home prepared once), a copy of
`WORKING-WITH-GEORGE.md`, and a scratch git workspace as its cwd. The runner
aborts (exit 3) if the real `WORKING-WITH-GEORGE.md`, `pi/AGENTS.md`, the
config repo's git status or the real thanx scope change during the eval.

Reports: `eval/reports/<date>-<time>-config-<X>.md` and `.json` (commit
them); transcripts sit in the matching directory, which is git-ignored.
Exit code: 0 for PASS, 1 for FAIL or INCOMPLETE, 2 for usage errors.

## Runner contract (T6)
````

- [ ] **Step 2: Commit**

```bash
git add eval/README.md
git commit -m "Document running the eval (#7)"
```

---

## Final verification

- `bash test/run.sh` passes, including `eval-unit` (19 unit tests) and `eval-runner` (15).
- #7 "Done when": one command per config writes a report (Task 4); scores map to AC2/AC3/AC4 with per-criterion status (Task 2); network mode lists destinations (Tasks 3–4); runs are isolated (guard + test).
