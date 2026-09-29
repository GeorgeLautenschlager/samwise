// Preflight checks bin/samwise runs on macOS before starting Pi. pi-sandbox
// fails open if it cannot initialise: bash runs unwrapped and read/write/edit
// go unchecked, with only a UI notice (unseen in -p and JSON mode). Every
// check returns a list of problem strings; an empty list means it passed.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { matchesPattern } from "./match.mjs";
import { pathToFileURL } from "node:url";

// lstat, not existsSync: existsSync follows symlinks and calls a dangling one
// absent, but a dangling link is still in the way (and can start resolving).
const present = (path) => {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
};

export function checkPolicyLink(repo, agentDir) {
	const link = join(agentDir, "sandbox.json");
	const policy = join(repo, "pi", "sandbox.json");
	if (!present(link)) return [`${link} is missing; run bootstrap.sh`];
	if (!lstatSync(link).isSymbolicLink()) return [`${link} is not a symlink to ${policy}; move it aside and run bootstrap.sh`];
	try {
		if (realpathSync(link) !== realpathSync(policy)) return [`${link} points to ${realpathSync(link)}, not ${realpathSync(policy)}; run bootstrap.sh`];
	} catch (error) {
		if (error.code === "ENOENT") return [`${link} is a broken symlink; run bootstrap.sh`];
		throw error;
	}
	return [];
}

export function checkPolicy(repo) {
	const path = join(repo, "pi", "sandbox.json");
	if (!existsSync(path)) return [`${path} is missing`];
	let policy;
	try {
		policy = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return [`${path} is not valid JSON (${error.message}); pi-sandbox would fall back to its defaults`];
	}
	if (policy === null || typeof policy !== "object" || Array.isArray(policy)) return [`${path} must be a JSON object`];
	if (policy.enabled === false) return [`${path} sets "enabled": false`];
	return [];
}

// Catch paths samwise-reflect needs before entering the fence; otherwise it
// fails at run time, not at launch.
export function checkLaunchDir(repo, cwd, env = process.env) {
	const home = env.HOME ?? os.homedir();
	const options = { home, cwd, canonical: true };
	const contains = (a, b) => matchesPattern(b, [a], options);
	const problems = [];
	// The policy allows writes to `.`, so the launch directory must not expose protected paths.
	if (contains(cwd, home)) problems.push(`launch dir ${cwd} contains your home directory; Samwise may write its launch dir, so start it from a project directory`);
	for (const [name, path] of [["the config repo", repo], ["the memory dir", env.PI_MEMORY_DIR], ["the Pi agent dir", env.PI_CODING_AGENT_DIR], ["the Samwise home", env.SAMWISE_HOME]]) {
		if (path && (contains(cwd, path) || contains(path, cwd))) problems.push(`launch dir ${cwd} overlaps ${name} (${path}); Samwise may write its launch dir, so start it from a project directory`);
	}
	return problems;
}

export function checkPolicyCoverage(repo, cwd, env = process.env) {
	const path = join(repo, "pi", "sandbox.json");
	let policy;
	try {
		policy = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
	const problems = [];
	for (const name of ["PI_MEMORY_DIR", "SAMWISE_HOME"]) {
		if (!env[name]) problems.push(`${name} is not set (run through bin/samwise)`);
	}
	const options = { home: env.HOME ?? os.homedir(), cwd, canonical: true };
	const fs = policy?.filesystem ?? {};
	const readable = [...(Array.isArray(fs.allowRead) ? fs.allowRead : []), ...(Array.isArray(fs.allowWrite) ? fs.allowWrite : [])];
	if (!matchesPattern(repo, readable, options)) problems.push(`${repo} is not readable under ${path} (samwise-reflect runs from it); add it to allowRead`);
	if (env.PI_MEMORY_DIR && !matchesPattern(env.PI_MEMORY_DIR, readable, options)) problems.push(`${env.PI_MEMORY_DIR} is not readable under ${path} (samwise-reflect reads memory); add it to allowRead`);
	if (env.SAMWISE_HOME) {
		const reflect = join(env.SAMWISE_HOME, "reflect");
		if (!matchesPattern(reflect, Array.isArray(fs.allowWrite) ? fs.allowWrite : [], options)) problems.push(`${reflect} is not writable under ${path} (/reflect stores proposals there); add it to allowWrite`);
	}
	return problems;
}

export function checkProjectPolicy(repo, cwd) {
	const path = join(cwd, ".pi", "sandbox.json");
	return present(path) ? [`${path} exists; move its entries into ${join(repo, "pi", "sandbox.json")} and delete it (a project policy can widen or disable the sandbox)`] : [];
}

export function checkPinnedVersion(repo, agentDir) {
	const settings = join(repo, "pi", "settings.json");
	const data = JSON.parse(readFileSync(settings, "utf8"));
	const entry = (data.packages ?? []).map((item) => typeof item === "string" ? item : item?.source).find((item) => typeof item === "string" && /^npm:pi-sandbox@/.test(item));
	if (!entry) return [`pi-sandbox is not in ${settings}`];
	const pinned = entry.match(/^npm:pi-sandbox@(.+)$/)[1];
	const packagePath = join(agentDir, "npm", "node_modules", "pi-sandbox", "package.json");
	if (!existsSync(packagePath)) return [`pi-sandbox is not installed in ${agentDir}; run bootstrap.sh`];
	const installed = JSON.parse(readFileSync(packagePath, "utf8")).version;
	return installed === pinned ? [] : [`pi-sandbox ${installed} is installed but ${pinned} is pinned; run bootstrap.sh`];
}

export async function checkDependencies(agentDir) {
	const modules = join(agentDir, "npm", "node_modules");
	// Check the copy pi-sandbox loads: Node resolves pi-sandbox's own
	// node_modules before the hoisted one, so the nested copy goes first.
	const candidates = [join(modules, "pi-sandbox", "node_modules", "@carderne", "sandbox-runtime"), join(modules, "@carderne", "sandbox-runtime")];
	const runtime = candidates.find((path) => existsSync(join(path, "package.json")));
	if (!runtime) return [`@carderne/sandbox-runtime not found under ${modules}; run bootstrap.sh`];
	const metadata = JSON.parse(readFileSync(join(runtime, "package.json"), "utf8"));
	const entry = join(runtime, metadata.main ?? "index.js");
	const { SandboxManager } = await import(pathToFileURL(entry).href);
	return SandboxManager.checkDependencies().errors.map((error) => `sandbox dependency: ${error}`);
}
