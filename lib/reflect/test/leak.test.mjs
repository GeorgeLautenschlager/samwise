import assert from "node:assert/strict";
import { test } from "node:test";
import { leakReason, parseVocabulary, serializeVocabulary } from "../leak.mjs";

test("vocabulary terms match case-insensitively", () => {
	assert.equal(leakReason("restart skiffline first", ["Skiffline"]), 'contains "Skiffline"');
});

test("general lessons pass, including public standard IDs", () => {
	const lesson = "Prefer circuit breakers to longer timeouts. Use UTF-8, SHA-256 and RFC-9110; rank #1 wins in v2.3.";
	assert.equal(leakReason(lesson, ["Skiffline"]), null);
});

test("IDs, PR refs, Keystone pointers and URLs are blocked", () => {
	assert.equal(leakReason("after INC-2291 we learned", []), 'contains an ID ("INC-2291")');
	assert.equal(leakReason("see PR #1561", []), 'contains a PR reference ("#1561")');
	assert.equal(leakReason("keystone:doc-9 explains it", []), 'contains a Keystone pointer ("keystone:")');
	assert.equal(leakReason("docs at https://wiki.internal/x", []), 'contains a URL ("https://")');
});

test("vocabulary file round-trips", () => {
	const terms = ["Skiffline", "Priya Okafor"];
	assert.deepEqual(parseVocabulary(serializeVocabulary(terms)), terms);
});
