// pi-sandbox fails open if it cannot initialise: bash runs unwrapped and read/write/edit go unchecked, with only a UI notice. bin/samwise runs these checks first.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const present = (path) => {
	try { lstatSync(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
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
	try { policy = JSON.parse(readFileSync(path, "utf8")); }
	catch (error) { return [`${path} is not valid JSON (${error.message}); pi-sandbox would fall back to its defaults`]; }
	if (policy === null || typeof policy !== "object" || Array.isArray(policy)) return [`${path} must be a JSON object`];
	if (policy.enabled === false) return [`${path} sets "enabled": false`];
	return [];
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
	const candidates = [join(modules, "pi-sandbox", "node_modules", "@carderne", "sandbox-runtime"), join(modules, "@carderne", "sandbox-runtime")];
	const runtime = candidates.find((path) => existsSync(join(path, "package.json")));
	if (!runtime) return [`@carderne/sandbox-runtime not found under ${modules}; run bootstrap.sh`];
	const metadata = JSON.parse(readFileSync(join(runtime, "package.json"), "utf8"));
	const entry = join(runtime, metadata.main ?? "index.js");
	const { SandboxManager } = await import(pathToFileURL(entry).href);
	return SandboxManager.checkDependencies().errors.map((error) => `sandbox dependency: ${error}`);
}
