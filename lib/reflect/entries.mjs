// Parse and serialise the wisdom files (MEMORY.md: thanx scope,
// WORKING-WITH-GEORGE.md: personal scope) as addressable entries. Each entry's
// text is preserved; only the blank lines between entries are normalised.

// pi-memory prefixes the entries it writes with `<!-- <timestamp> [<session>] -->`.
const STAMP = /^<!-- .*\[[^\]\r\n]+\] -->$/;

export function formatEntry(title, asOf, body) {
	return `### ${title.trim()}\nas-of: ${asOf}\n\n${body.trim()}`;
}

// kind: "thanx" or "personal". Returns { kind, header, entries: [{ id, text }] }
// with ids T1.. or P1.. in file order. In WORKING-WITH-GEORGE.md only blocks
// after "## Entries" are entries (the template's example sits above it).
export function parseWisdom(content, kind) {
	const lines = content.split("\n");
	const isStart = (line) => line.startsWith("### ") || (kind === "thanx" && STAMP.test(line));
	let from = 0;
	if (kind === "personal") {
		from = lines.indexOf("## Entries") + 1;
		if (from === 0) throw new Error("WORKING-WITH-GEORGE.md has no '## Entries' line");
	}
	let start = lines.findIndex((line, i) => i >= from && isStart(line));
	if (start === -1) start = lines.length;

	const blocks = [];
	for (const line of lines.slice(start)) {
		if (isStart(line)) blocks.push([line]);
		else blocks.at(-1).push(line);
	}
	const prefix = kind === "thanx" ? "T" : "P";
	return {
		kind,
		header: lines.slice(0, start).join("\n").trimEnd(),
		entries: blocks.map((block, i) => ({ id: `${prefix}${i + 1}`, text: block.join("\n").trimEnd() })),
	};
}

export function serializeWisdom({ header, entries }) {
	if (entries.length === 0) return `${header}\n`;
	return `${header}\n\n${entries.map((e) => e.text).join("\n\n")}\n`;
}
