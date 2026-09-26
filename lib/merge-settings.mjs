// Merge the repo's declarative Pi settings into the agent's settings.json.
// Repo keys win; keys Pi wrote itself (e.g. lastChangelogVersion) are kept.
// Compares parsed JSON, not bytes, and writes only when the merged result
// differs, so re-runs are no-ops even though Pi formats the file itself.
// Usage: node lib/merge-settings.mjs <repo-settings.json> <agent-settings.json>
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [repoPath, agentPath] = process.argv.slice(2);
if (!repoPath || !agentPath) {
	console.error("usage: merge-settings.mjs <repo-settings.json> <agent-settings.json>");
	process.exit(2);
}

const repo = JSON.parse(readFileSync(repoPath, "utf8"));
const current = existsSync(agentPath) ? JSON.parse(readFileSync(agentPath, "utf8")) : null;
const merged = { ...current, ...repo };

if (JSON.stringify(merged) !== JSON.stringify(current)) {
	writeFileSync(agentPath, JSON.stringify(merged, null, 2));
	console.log(`updated ${agentPath}`);
}
