// Usage: node lib/sandbox/preflight.mjs <repo> <agent-dir> <cwd>
import { checkDependencies, checkPinnedVersion, checkPolicy, checkPolicyLink, checkProjectPolicy } from "./checks.mjs";

const [repo, agentDir, cwd] = process.argv.slice(2);
if (!repo || !agentDir || !cwd) {
	console.error("Usage: node lib/sandbox/preflight.mjs <repo> <agent-dir> <cwd>");
	process.exit(2);
}

const problems = [
	...checkPolicyLink(repo, agentDir),
	...checkPolicy(repo),
	...checkProjectPolicy(repo, cwd),
	...checkPinnedVersion(repo, agentDir),
	...(await checkDependencies(agentDir)),
];
for (const problem of problems) console.error(`samwise: ${problem}`);
if (problems.length) process.exit(1);
