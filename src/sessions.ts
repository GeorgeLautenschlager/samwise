import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Resolves the Samwise-only Pi session folder without depending on the current working directory. */
export function resolveDefaultSessionsDir(cwd = join(homedir(), "Samwise"), agentDir = join(homedir(), ".pi", "agent")): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}
