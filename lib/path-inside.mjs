// Exit 0 if <path> is <dir> or inside it, 1 otherwise. Compares physical
// paths (symlinks resolved); <path> need not exist yet, so the check can run
// before anything is created.
// Usage: node lib/path-inside.mjs <path> <dir>
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const [target, dir] = process.argv.slice(2);
if (!target || !dir) {
	console.error("usage: path-inside.mjs <path> <dir>");
	process.exit(2);
}

// Resolve the nearest existing ancestor physically, then re-append the rest.
function physical(p) {
	let existing = resolve(p);
	const rest = [];
	while (!existsSync(existing)) {
		rest.unshift(basename(existing));
		existing = dirname(existing);
	}
	return join(realpathSync(existing), ...rest);
}

const t = physical(target);
const d = physical(dir);
process.exit(t === d || t.startsWith(d + sep) ? 0 : 1);
