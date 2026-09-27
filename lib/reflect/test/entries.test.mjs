import assert from "node:assert/strict";
import { test } from "node:test";
import { formatEntry, parseWisdom, serializeWisdom } from "../entries.mjs";

const WWG = [
	"# Working with George",
	"",
	"Intro.",
	"",
	"## Entry format",
	"",
	"```",
	"### <Short title>",
	"as-of: YYYY-MM-DD",
	"",
	"<body>",
	"```",
	"",
	"## Entries",
	"",
].join("\n");

test("personal: the template's fenced example is header, not an entry", () => {
	const w = parseWisdom(WWG, "personal");
	assert.equal(w.entries.length, 0);
	assert.equal(serializeWisdom(w), WWG);
});

test("personal: entries after '## Entries' get P ids and round-trip", () => {
	const text = `${WWG}\n### Package manager\nas-of: 2026-07-10\n\nAlways pnpm.\n\n### PRs\nas-of: 2026-06-02\n\nSmall PRs.\n`;
	const w = parseWisdom(text, "personal");
	assert.deepEqual(
		w.entries.map((e) => e.id),
		["P1", "P2"],
	);
	assert.equal(w.entries[1].text, "### PRs\nas-of: 2026-06-02\n\nSmall PRs.");
	assert.equal(serializeWisdom(w), text);
});

test("thanx: pi-memory stamped entries and ### entries both get T ids", () => {
	const text =
		"# Thanx memory\n\nWisdom from working at Thanx.\n\n<!-- 2026-07-02 09:12:44 [c3d4e5f6] -->\n#decision [[x]] No ORM.\n\n### Breakers\nas-of: 2026-09-01\n\nUse them.\n";
	const w = parseWisdom(text, "thanx");
	assert.equal(w.header, "# Thanx memory\n\nWisdom from working at Thanx.");
	assert.deepEqual(
		w.entries.map((e) => [e.id, e.text.split("\n")[0]]),
		[
			["T1", "<!-- 2026-07-02 09:12:44 [c3d4e5f6] -->"],
			["T2", "### Breakers"],
		],
	);
	assert.equal(serializeWisdom(w), text);
});

test("thanx: a header-only file round-trips", () => {
	const text = "# Thanx memory\n\nWisdom.\n";
	assert.equal(serializeWisdom(parseWisdom(text, "thanx")), text);
});

test("formatEntry stamps as-of and trims", () => {
	assert.equal(formatEntry(" T ", "2026-09-27", "  body \n"), "### T\nas-of: 2026-09-27\n\nbody");
});

test("a personal file without '## Entries' is an error", () => {
	assert.throws(() => parseWisdom("# x\n", "personal"), /## Entries/);
});
