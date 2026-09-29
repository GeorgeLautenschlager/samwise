// Fail-closed gate bin/samwise runs on macOS before starting Pi: prints one
// line per problem (see checks.mjs) to stderr and exits 1 if there are any.
// Usage: node lib/sandbox/preflight.mjs <repo> <agent-dir> <cwd>
// Reads HOME, PI_MEMORY_DIR and SAMWISE_HOME from the environment (lib/env.sh
// sets them); <agent-dir> stands in for PI_CODING_AGENT_DIR.
import { checkDependencies, checkLaunchDir, checkPinnedVersion, checkPolicy, checkPolicyCoverage, checkPolicyLink, checkProjectPolicy } from "./checks.mjs";

const [repo, agentDir, cwd] = process.argv.slice(2);
if (!repo || !agentDir || !cwd) {
	console.error("Usage: node lib/sandbox/preflight.mjs <repo> <agent-dir> <cwd>");
	process.exit(2);
}

const problems = [
	...checkPolicyLink(repo, agentDir),
	...checkPolicy(repo),
	...checkPolicyCoverage(repo, cwd),
	...checkLaunchDir(repo, cwd, { ...process.env, PI_CODING_AGENT_DIR: agentDir }),
	...checkProjectPolicy(repo, cwd),
	...checkPinnedVersion(repo, agentDir),
	...(await checkDependencies(agentDir)),
];
for (const problem of problems) console.error(`samwise: ${problem}`);
if (problems.length) process.exit(1);
