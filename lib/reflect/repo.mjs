// The file-system and git side of /reflect: where the scopes live, which daily
// logs are unreflected, and writing + committing an approved proposal.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseWisdom, serializeWisdom } from "./entries.mjs";
import { parseVocabulary, serializeVocabulary } from "./leak.mjs";
import { applyItems } from "./proposal.mjs";

export function today(env = process.env) {
	return env.SAMWISE_REFLECT_TODAY ?? new Date().toLocaleDateString("sv-SE"); // local YYYY-MM-DD
}

export function paths(env = process.env) {
	for (const key of ["SAMWISE_HOME", "PI_MEMORY_DIR", "PI_CODING_AGENT_DIR"]) {
		if (!env[key]) throw new Error(`${key} is not set (run inside Samwise or via bin/samwise-reflect)`);
	}
	const memory = env.PI_MEMORY_DIR;
	return {
		memory,
		memoryFile: join(memory, "MEMORY.md"),
		vocabularyFile: join(memory, "VOCABULARY.md"),
		daily: join(memory, "daily"),
		// The personal wisdom file is whatever APPEND_SYSTEM.md links to (a copy in evals).
		personalFile: realpathSync(join(env.PI_CODING_AGENT_DIR, "APPEND_SYSTEM.md")),
		pending: join(env.SAMWISE_HOME, "reflect", "pending.json"),
		nudged: join(env.SAMWISE_HOME, "reflect", "nudged"),
	};
}

function git(cwd, args) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// The Reflected-Through trailer of the latest /reflect commit in the thanx scope.
export function reflectedThrough(memory) {
	try {
		const out = git(memory, ["log", "-1", "--grep=^Reflected-Through: ", "--format=%(trailers:key=Reflected-Through,valueonly)"]);
		return out.trim() || null;
	} catch {
		return null;
	}
}

export function dailyDates(daily) {
	if (!existsSync(daily)) return [];
	return readdirSync(daily)
		.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
		.map((f) => f.slice(0, 10))
		.sort();
}

export function loadState(p) {
	return {
		thanx: parseWisdom(readFileSync(p.memoryFile, "utf8"), "thanx"),
		personal: parseWisdom(readFileSync(p.personalFile, "utf8"), "personal"),
		vocabulary: existsSync(p.vocabularyFile) ? parseVocabulary(readFileSync(p.vocabularyFile, "utf8")) : [],
	};
}

// Hash of both wisdom files: apply refuses if they changed after propose.
export function fingerprint(p) {
	const hash = createHash("sha256");
	for (const file of [p.memoryFile, p.personalFile]) hash.update(readFileSync(file));
	return hash.digest("hex");
}

export function newRunId(date) {
	return `${date.replaceAll("-", "")}-${randomBytes(3).toString("hex")}`;
}

function identityArgs(cwd) {
	try {
		if (git(cwd, ["config", "user.email"]).trim()) return [];
	} catch {
		// no identity configured
	}
	return ["-c", "user.name=Samwise", "-c", "user.email=samwise@localhost"];
}

function insideWorkTree(dir) {
	try {
		return git(dir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
	} catch {
		return false;
	}
}

// Writes the approved items and commits in each scope's repo (AC6). The thanx
// commit is made even when nothing there changed, to record Reflected-Through.
// Returns short descriptions of the commits made.
export function applyApproved(p, pending, approved) {
	const state = loadState(p);
	const items = pending.items.filter((item) => approved.includes(item.n));
	const next = applyItems(state, items);
	const message = [
		`reflect: approved run ${pending.date}`,
		"",
		`Reflect-Run: ${pending.id}`,
		`Reflected-Through: ${pending.reflectedThrough}`,
		`Approved-Items: ${approved.join(",")}`,
	].join("\n");
	const commits = [];

	if (items.some((i) => i.scope === "thanx")) writeFileSync(p.memoryFile, serializeWisdom(next.thanx));
	if (pending.vocabulary.length > 0) {
		writeFileSync(p.vocabularyFile, serializeVocabulary([...state.vocabulary, ...pending.vocabulary]));
	}
	const thanxFiles = ["MEMORY.md", ...(existsSync(p.vocabularyFile) ? ["VOCABULARY.md"] : [])];
	git(p.memory, ["add", "--", ...thanxFiles]);
	git(p.memory, [...identityArgs(p.memory), "commit", "-q", "--allow-empty", "-m", message, "--", ...thanxFiles]);
	commits.push(`the thanx scope (${git(p.memory, ["rev-parse", "--short", "HEAD"]).trim()})`);

	if (items.some((i) => i.scope === "personal")) {
		writeFileSync(p.personalFile, serializeWisdom(next.personal));
		const dir = dirname(p.personalFile);
		if (insideWorkTree(dir)) {
			const file = basename(p.personalFile);
			git(dir, ["add", "--", file]);
			git(dir, [...identityArgs(dir), "commit", "-q", "-m", message, "--", file]);
			commits.push(`the personal scope (${git(dir, ["rev-parse", "--short", "HEAD"]).trim()})`);
		}
	}
	return commits;
}
