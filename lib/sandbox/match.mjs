// The fence's two path matchers, so tests and the preflight can judge
// pi/sandbox.json the way the fence will: "tool" mirrors pi-sandbox's
// policy.ts (Pi's read/write/edit tools); "runtime" models the sandbox
// runtime's Seatbelt rules for bash (a trailing /** is stripped, * stays within
// a directory, **/ spans any depth, ? and [...] are glob syntax). Unlike
// upstream, home and cwd are passed in rather than read from the process, and
// symlink resolution (canonical) is opt-in.
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

// Expand `~` and `~/…` against `home` and resolve the rest against `cwd`, as
// pi-sandbox does for paths and patterns alike (`~user` is not special).
export function expandPath(pattern, { home, cwd }) {
	const expanded = pattern === "~" ? home : pattern.startsWith("~/") ? join(home, pattern.slice(2)) : pattern;
	return resolve(cwd, expanded);
}

// Real path of `path`. A path that does not exist yet (a file about to be
// written) resolves its nearest existing ancestor and re-appends the rest, so a
// new file under a symlinked dir still compares by its real location.
function canonicalizePath(path) {
	let current = path;
	const remainder = [];
	while (true) {
		try {
			return resolve(realpathSync.native(current), ...remainder);
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			remainder.unshift(basename(current));
			current = parent;
		}
	}
}

function globRegex(pattern, mode) {
	if (mode === "tool") return new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
	pattern = pattern.replace(/\/\*\*$/, "") || "/";
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*" && pattern[i + 1] === "*") {
			if (pattern[i + 2] === "/") { source += "(.*/)?"; i += 2; }
			else { source += ".*"; i++; }
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if (".^$+{}()|\\".includes(char)) source += `\\${char}`;
		else if (char === "[" && !pattern.includes("]", i + 1)) source += "\\[";
		else if (char === "]") source += "]";
		else source += char;
	}
	return new RegExp(`^${source}$`);
}

// Does `path` fall under any of `patterns`? A plain pattern matches itself and
// everything below it; a glob must match the whole path. `globs` picks the
// matcher: "tool" (`*` crosses `/`; `?` stays a regex quantifier, as upstream
// leaves it) or "runtime" (bash under Seatbelt). `canonical` resolves symlinks
// in the path and in plain patterns first; off by default so the policy tests
// judge fixed paths regardless of this machine's symlinks.
export function matchesPattern(path, patterns, { home, cwd, canonical = false, globs = "tool" }) {
	const expandedPath = expandPath(path, { home, cwd });
	const candidate = canonical ? canonicalizePath(expandedPath) : expandedPath;
	return patterns.some(pattern => {
		const runtimePattern = globs === "runtime" ? pattern.replace(/\/\*\*$/, "") || "/" : pattern;
		if (runtimePattern.includes("*") || (globs === "runtime" && /[?\[\]]/.test(runtimePattern))) {
			return globRegex(expandPath(runtimePattern, { home, cwd }), globs).test(candidate);
		}
		let expandedPattern = expandPath(runtimePattern, { home, cwd });
		if (canonical) expandedPattern = canonicalizePath(expandedPattern);
		return candidate === expandedPattern || (expandedPattern.endsWith(sep)
			? candidate.startsWith(expandedPattern)
			: candidate.startsWith(expandedPattern + sep));
	});
}
