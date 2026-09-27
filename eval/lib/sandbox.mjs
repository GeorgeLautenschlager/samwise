// Build isolated eval runs: a throwaway SAMWISE_HOME wired by the real
// bootstrap.sh, a copy of the personal scope, seeds, and a scratch workspace.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const exec = promisify(execFile);
export const MAX_BUFFER = 64 * 1024 * 1024;

// Environment for a Samwise process rooted at `home`. lib/env.sh derives the
// rest from SAMWISE_HOME; drop inherited values so nothing points at real memory.
export function samwiseEnv(home, extra = {}) {
	const env = { ...process.env, ...extra, SAMWISE_HOME: home };
	for (const key of ["PI_CODING_AGENT_DIR", "PI_MEMORY_DIR", "QMD_CONFIG_DIR", "INDEX_PATH"]) delete env[key];
	return env;
}
