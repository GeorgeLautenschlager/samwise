// Print each package source from the repo settings that is not installed in
// the agent dir at its pinned version, one per line. Non-npm sources are
// always printed, since `pi install` is idempotent for them.
// Usage: node lib/missing-packages.mjs <repo-settings.json> <agent-dir>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [repoPath, agentDir] = process.argv.slice(2);
if (!repoPath || !agentDir) {
	console.error("usage: missing-packages.mjs <repo-settings.json> <agent-dir>");
	process.exit(2);
}

const { packages = [] } = JSON.parse(readFileSync(repoPath, "utf8"));

function installedVersion(name) {
	const pkgJson = join(agentDir, "npm", "node_modules", name, "package.json");
	return existsSync(pkgJson) ? JSON.parse(readFileSync(pkgJson, "utf8")).version : null;
}

for (const entry of packages) {
	const source = typeof entry === "string" ? entry : entry.source;
	const npm = /^npm:(@?[^@]+)@(.+)$/.exec(source);
	if (npm && installedVersion(npm[1]) === npm[2]) continue;
	console.log(source);
}
