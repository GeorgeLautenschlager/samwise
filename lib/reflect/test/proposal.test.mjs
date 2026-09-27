import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWisdom } from "../entries.mjs";
import { applyItems, buildProposal, renderDiff } from "../proposal.mjs";

const TODAY = "2026-09-27";
const state = () => ({
	thanx: parseWisdom("# Thanx memory\n\nWisdom.\n\n### Deploys\nas-of: 2026-05-01\n\nJenkins.\n", "thanx"),
	personal: parseWisdom(
		"# WWG\n\n## Entries\n\n### PRs\nas-of: 2026-06-02\n\nSmall PRs.\n\n### Old\nas-of: 2026-01-01\n\nWrong.\n",
		"personal",
	),
	vocabulary: ["Skiffline"],
});
const shape = (p) => p.items.map((i) => [i.n, i.op, i.scope, i.target ?? null]);

test("adds, edits and retires resolve against entry ids and are stamped with today", () => {
	const p = buildProposal(
		{
			items: [
				{ op: "add", scope: "personal", title: "Breakers", body: "Prefer circuit breakers." },
				{ op: "edit", target: "T1", title: "Deploys", body: "Argo CD." },
				{ op: "retire", target: "P2", reason: "marked wrong" },
			],
		},
		state(),
		TODAY,
	);
	assert.deepEqual(shape(p), [
		[1, "add", "personal", null],
		[2, "edit", "thanx", "T1"],
		[3, "retire", "personal", "P2"],
	]);
	assert.equal(p.items[0].text, "### Breakers\nas-of: 2026-09-27\n\nPrefer circuit breakers.");
	assert.equal(p.items[1].before, "### Deploys\nas-of: 2026-05-01\n\nJenkins.");
});

test("a leaky personal add is rerouted to thanx", () => {
	const p = buildProposal({ items: [{ op: "add", scope: "personal", title: "Carrier calls", body: "Skiffline needs a breaker." }] }, state(), TODAY);
	assert.deepEqual(shape(p), [[1, "add", "thanx", null]]);
	assert.equal(p.items[0].rerouted, 'contains "Skiffline"');
});

test("proposal vocabulary counts for the leak check; only new terms are reported", () => {
	const p = buildProposal(
		{ items: [{ op: "add", scope: "personal", title: "Paging", body: "Ask Priya Okafor." }], vocabulary: ["Priya Okafor", "skiffline", " "] },
		state(),
		TODAY,
	);
	assert.equal(p.items[0].scope, "thanx");
	assert.deepEqual(p.vocabulary, ["Priya Okafor"]);
});

test("a leaky personal edit becomes a retirement plus a thanx add", () => {
	const p = buildProposal({ items: [{ op: "edit", target: "P1", title: "PRs", body: "Small PRs, see #1561." }] }, state(), TODAY);
	assert.deepEqual(shape(p), [
		[1, "retire", "personal", "P1"],
		[2, "add", "thanx", null],
	]);
	assert.match(p.items[0].reason, /^rerouted to thanx: contains a PR reference/);
});

test("invalid proposals report every problem", () => {
	assert.throws(
		() =>
			buildProposal(
				{
					items: [
						{ op: "add", title: "x", body: "y" },
						{ op: "edit", target: "T9", title: "a", body: "b" },
						{ op: "retire", target: "P1" },
						{ op: "retire", target: "P1" },
						{ op: "zap" },
					],
				},
				state(),
				TODAY,
			),
		(e) =>
			[
				"item 1: add needs scope thanx or personal",
				"item 2: unknown target 'T9'",
				"item 4: target 'P1' used twice",
				"item 5: unknown op 'zap'",
			].every((m) => e.message.includes(m)),
	);
	assert.throws(() => buildProposal({ items: [] }, state(), TODAY), /items must be a non-empty list/);
	assert.throws(
		() => buildProposal({ items: [{ op: "edit", target: "T1", title: "", body: "b" }] }, state(), TODAY),
		/item 1: edit needs title and body/,
	);
});

test("applyItems adds, replaces and deletes without touching its input", () => {
	const s = state();
	const p = buildProposal(
		{
			items: [
				{ op: "add", scope: "thanx", title: "New", body: "n" },
				{ op: "edit", target: "P1", title: "PRs", body: "Tiny PRs." },
				{ op: "retire", target: "P2" },
			],
		},
		s,
		TODAY,
	);
	const next = applyItems(s, p.items);
	assert.deepEqual(
		next.thanx.entries.map((e) => e.text.split("\n")[0]),
		["### Deploys", "### New"],
	);
	assert.deepEqual(
		next.personal.entries.map((e) => e.text),
		["### PRs\nas-of: 2026-09-27\n\nTiny PRs."],
	);
	assert.equal(s.personal.entries.length, 2);
});

test("renderDiff numbers items and shows reroutes, targets and vocabulary", () => {
	const p = buildProposal(
		{
			items: [
				{ op: "add", scope: "personal", title: "Carrier calls", body: "Skiffline needs a breaker." },
				{ op: "retire", target: "P2", reason: "marked wrong" },
			],
			vocabulary: ["Priya Okafor"],
		},
		state(),
		TODAY,
	);
	const diff = renderDiff(p, TODAY);
	for (const expected of [
		"/reflect proposal 2026-09-27: 2 items",
		'[1] add  thanx  MEMORY.md  ↪ rerouted from personal: contains "Skiffline"',
		"  + ### Carrier calls",
		"  +\n",
		"[2] retire  personal  WORKING-WITH-GEORGE.md  P2: marked wrong",
		"  - ### Old",
		"New vocabulary (thanx scope): Priya Okafor",
		'Approve all, some (e.g. "all but 2"), or none.',
	]) {
		assert.ok(diff.includes(expected), `missing: ${expected}`);
	}
});
