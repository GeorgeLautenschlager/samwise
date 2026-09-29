// Mirrors pi-sandbox 0.6.8 src/policy.ts (expandPath, canonicalizePath,
// matchesPattern) so policy tests and preflight judge paths the way the fence does.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export function expandPath(pattern, { home, cwd }) {
	const expanded = pattern === "~" ? home : pattern.startsWith("~/") ? join(home, pattern.slice(2)) : pattern;
	return resolve(cwd, expanded);
}

function canonicalizePath(path) {
	let current = path;
	const remainder = [];
	while (true) {
		try {
			return resolve(realpathSync(current), ...remainder.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			remainder.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			current = parent;
		}
	}
}

function globRegex(pattern) {
	return new RegExp(`^${pattern.split("*").map(part => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*")}$`);
}

export function matchesPattern(path, patterns, { home, cwd, canonical = false }) {
	const expandedPath = expandPath(path, { home, cwd });
	const candidate = canonical ? canonicalizePath(expandedPath) : expandedPath;
	return patterns.some(pattern => {
		if (pattern.includes("*")) return globRegex(expandPath(pattern, { home, cwd })).test(candidate);
		let expandedPattern = expandPath(pattern, { home, cwd });
		if (canonical) expandedPattern = canonicalizePath(expandedPattern);
		return candidate === expandedPattern || (expandedPattern.endsWith(sep)
			? candidate.startsWith(expandedPattern)
			: candidate.startsWith(expandedPattern + sep));
	});
}
