// Load and validate golden-set scenarios: markdown files with YAML front
// matter (schema in eval/README.md). Used by eval/validate.mjs and the eval runner.
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parse } from "yaml";

export const CATEGORIES = ["recall", "preference", "stale-knowledge", "scope-leak"];

// Seeds must predate any run by 2+ days so they are never in pi-memory's
// today/yesterday injection: recall has to come from search.
const LATEST_SEED_DATE = "2026-08-31";
const STAMP = /^<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[[0-9a-f]{8}\] -->$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function loadScenario(path) {
	const text = readFileSync(path, "utf8");
	const match = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(text);
	if (!match) throw new Error(`${path}: no YAML front matter`);
	return { frontMatter: parse(match[1]) ?? {}, body: match[2] ?? "", path };
}

// The lexicon groups terms (systems, people, ...); callers want one flat list.
export function loadLexicon(path) {
	const groups = parse(readFileSync(path, "utf8")) ?? {};
	return Object.values(groups).flat().map(String);
}

export function findLexiconTerm(text, lexicon) {
	const haystack = text.toLowerCase();
	return lexicon.find((term) => haystack.includes(term.toLowerCase()));
}

const isMapping = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringList = (v) =>
	Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.trim() !== "");

// Split text into entries (arrays of lines), each starting at a line matching `start`.
function splitEntries(text, start) {
	const entries = [];
	for (const line of text.trim().split("\n")) {
		if (start.test(line) || entries.length === 0) entries.push([line]);
		else entries.at(-1).push(line);
	}
	return entries;
}

function dailyErrors(daily) {
	if (!isMapping(daily)) return ["seed.daily must map YYYY-MM-DD dates to log text"];
	const errors = [];
	for (const [date, text] of Object.entries(daily)) {
		if (!DATE.test(date) || date > LATEST_SEED_DATE) {
			errors.push(`seed.daily ${date}: date must be YYYY-MM-DD no later than ${LATEST_SEED_DATE}`);
		}
		if (typeof text !== "string") {
			errors.push(`seed.daily ${date} must be log text`);
			continue;
		}
		splitEntries(text, STAMP).forEach((lines, i) => {
			const where = `seed.daily ${date} entry ${i + 1}`;
			if (!STAMP.test(lines[0])) errors.push(`${where}: must start with a pi-memory timestamp line`);
			if (!/^#problem \[\[[a-z0-9-]+\]\] \S/.test(lines[1] ?? "")) {
				errors.push(`${where}: second line must be '#problem [[slug]] <problem>'`);
			}
			for (const field of ["Tried", "Worked", "Pointers"]) {
				if (!lines.some((l) => l.startsWith(`- ${field}: `))) errors.push(`${where}: missing '- ${field}: ' line`);
			}
		});
	}
	return errors;
}

function seedErrors(seed, lexicon) {
	if (!isMapping(seed)) return ["seed must be a mapping"];
	const errors = [];
	if (seed.daily !== undefined) errors.push(...dailyErrors(seed.daily));
	if (seed.memory !== undefined) {
		splitEntries(String(seed.memory), STAMP).forEach((lines, i) => {
			if (!STAMP.test(lines[0]) || !lines.slice(1).some((l) => l.trim())) {
				errors.push(`seed.memory entry ${i + 1} must start with a pi-memory timestamp line`);
			}
		});
	}
	if (seed.personal !== undefined) {
		const text = String(seed.personal);
		splitEntries(text, /^### /).forEach((lines, i) => {
			if (!/^### \S/.test(lines[0]) || !/^as-of: \d{4}-\d{2}-\d{2}$/.test(lines[1] ?? "")) {
				errors.push(`seed.personal entry ${i + 1} must be '### title' then 'as-of: YYYY-MM-DD'`);
			}
		});
		const term = findLexiconTerm(text, lexicon);
		if (term) errors.push(`seed.personal must not contain lexicon term '${term}'`);
	}
	return errors;
}

const isToolItem = (t) =>
	isMapping(t) && typeof t.name === "string" && t.name !== "" && (t.args_include === undefined || isMapping(t.args_include));

function expectErrors(expect) {
	if (!isMapping(expect) || Object.keys(expect).length === 0) return ["expect must be a mapping with at least one key"];
	const errors = [];
	for (const [key, value] of Object.entries(expect)) {
		switch (key) {
			case "response_includes":
			case "response_excludes":
			case "artifact_includes":
			case "artifact_excludes":
				if (!isStringList(value)) errors.push(`expect.${key} must be a non-empty list of strings`);
				break;
			case "tool_called":
				if (!(Array.isArray(value) && value.length > 0 && value.every(isToolItem))) {
					errors.push("expect.tool_called must be a list of {name, args_include?}");
				}
				break;
			case "tool_not_called":
				if (!(Array.isArray(value) && value.length > 0 && value.every((t) => (typeof t === "string" && t) || isToolItem(t)))) {
					errors.push("expect.tool_not_called must be a list of tool names or {name, args_include?}");
				}
				break;
			case "personal_scope_clean":
				if (value !== true) errors.push("expect.personal_scope_clean must be true");
				break;
			case "judge":
				if (typeof value !== "string" || value.trim() === "") errors.push("expect.judge must be a non-empty string");
				break;
			default:
				errors.push(`unknown expect key '${key}'`);
		}
	}
	return errors;
}

function staleKnowledgeErrors(f, expect) {
	const errors = [];
	const mock = f.keystone_mock;
	if (!Array.isArray(mock) || mock.length === 0) {
		errors.push("stale-knowledge scenarios need a non-empty keystone_mock");
	} else {
		mock.forEach((doc, i) => {
			if (!isMapping(doc) || !doc.id || !doc.title || !isStringList(doc.match) || !doc.content) {
				errors.push(`keystone_mock item ${i + 1} needs id, title, non-empty match and content`);
			}
		});
	}
	const calls = Array.isArray(expect.tool_called) ? expect.tool_called : [];
	if (!calls.some((t) => t?.name === "keystone_search")) {
		errors.push("stale-knowledge scenarios must expect a keystone_search call");
	}
	return errors;
}

function scopeLeakErrors(f, expect, lexicon) {
	const errors = [];
	if (expect.personal_scope_clean !== true) errors.push("scope-leak scenarios must expect personal_scope_clean: true");
	const prompts = Array.isArray(f.prompt) ? f.prompt : [];
	if (!findLexiconTerm([...prompts, JSON.stringify(f.seed ?? {})].join("\n"), lexicon)) {
		errors.push("scope-leak scenarios need a lexicon term in the prompt or seed");
	}
	return errors;
}

// Returns { errors: string[], judgeScored: boolean } for a loaded scenario.
export function validateScenario({ frontMatter: f, path }, lexicon) {
	const errors = [];
	for (const key of ["id", "category", "description", "prompt", "expect"]) {
		if (f[key] === undefined) errors.push(`missing '${key}'`);
	}

	const slug = basename(path, ".md");
	if (f.id !== undefined && f.id !== slug) errors.push(`id '${f.id}' must equal the filename '${slug}'`);
	const dir = basename(dirname(path));
	if (f.category !== undefined) {
		if (!CATEGORIES.includes(f.category)) {
			errors.push(`category '${f.category}' must be one of: ${CATEGORIES.join(", ")}`);
		} else if (f.category !== dir) {
			errors.push(`category '${f.category}' must match its directory '${dir}'`);
		}
	}
	if (f.prompt !== undefined && !isStringList(f.prompt)) errors.push("prompt must be a non-empty list of non-empty strings");
	if (f.requires !== undefined && !(Array.isArray(f.requires) && f.requires.every((r) => typeof r === "string"))) {
		errors.push("requires must be a list of strings");
	}
	if (f.seed !== undefined) errors.push(...seedErrors(f.seed, lexicon));
	if (f.expect !== undefined) errors.push(...expectErrors(f.expect));

	const expect = isMapping(f.expect) ? f.expect : {};
	if (f.category === "stale-knowledge") errors.push(...staleKnowledgeErrors(f, expect));
	if (f.category === "scope-leak") errors.push(...scopeLeakErrors(f, expect, lexicon));

	const keys = Object.keys(expect);
	return { errors, judgeScored: keys.length === 1 && keys[0] === "judge" };
}
