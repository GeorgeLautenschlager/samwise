// Mirrors pi-sandbox's tool matcher and sandbox-runtime's bash matcher so
// policy tests account for both Pi tools and bash.
import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export function expandPath(pattern, { home, cwd }) {
	const expanded = pattern === "~" ? home : pattern.startsWith("~/") ? join(home, pattern.slice(2)) : pattern;
	return resolve(cwd, expanded);
}

function canonicalizePath(path) {
	let current = path;
	const remainder = [];
	while (true) {
		try {
			return resolve(realpathSync.native(current), ...remainder.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			remainder.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			current = parent;
		}
	}
}

function globRegex(pattern, mode) {
	if (mode === "tool") return new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*" && pattern[i + 1] === "*") {
			if (pattern[i + 2] === "/") { source += "(.*/)?"; i += 2; }
			else { source += ".*"; i++; }
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if (".^$+{}()|\\".includes(char)) source += `\\${char}`;
		else if (char === "[" && !pattern.slice(i).includes("]")) source += "\\[";
		else source += char;
	}
	return new RegExp(`^${source}$`);
}

export function matchesPattern(path, patterns, { home, cwd, canonical = false, globs = "tool" }) {
	const expandedPath = expandPath(path, { home, cwd });
	const candidate = canonical ? canonicalizePath(expandedPath) : expandedPath;
	return patterns.some(pattern => {
		if (pattern.includes("*") || (globs === "runtime" && pattern.includes("?"))) return globRegex(expandPath(pattern, { home, cwd }), globs).test(candidate);
		let expandedPattern = expandPath(pattern, { home, cwd });
		if (canonical) expandedPattern = canonicalizePath(expandedPattern);
		return candidate === expandedPattern || (expandedPattern.endsWith(sep)
			? candidate.startsWith(expandedPattern)
			: candidate.startsWith(expandedPattern + sep));
	});
}
