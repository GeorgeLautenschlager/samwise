// Build isolated eval runs: a throwaway SAMWISE_HOME wired by the real
// bootstrap.sh, a copy of the personal scope, seeds, and a scratch workspace.
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
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

// Run bootstrap.sh for `home`, linking personal wisdom to `wisdom`.
export async function bootstrap(repo, home, wisdom) {
	await exec("bash", [join(repo, "bootstrap.sh")], {
		env: samwiseEnv(home, { SAMWISE_PERSONAL_WISDOM: wisdom }),
		maxBuffer: MAX_BUFFER,
	});
}

// Run a shell snippet with Samwise's environment for `home` loaded.
export function inSamwise(repo, home, script) {
	return exec("bash", ["-c", `source "${join(repo, "lib/env.sh")}"; ${script}`], {
		env: samwiseEnv(home),
		maxBuffer: MAX_BUFFER,
	});
}

// A base home, bootstrapped once per eval, whose tools (qmd) every run shares.
export async function prepareBase(repo, dir) {
	const home = join(dir, "home");
	const wisdom = join(dir, "WORKING-WITH-GEORGE.md");
	await mkdir(dir, { recursive: true });
	await copyFile(join(repo, "WORKING-WITH-GEORGE.md"), wisdom);
	await bootstrap(repo, home, wisdom);
	return { home };
}

// Build run dir `dir` for `scenario`. Returns the paths the runner needs.
export async function createRun({ repo, base, dir, scenario, auth, modelsJson }) {
	const home = join(dir, "home");
	const personal = join(dir, "personal");
	const wisdom = join(personal, "WORKING-WITH-GEORGE.md");
	const workspace = join(dir, "workspace");
	const keystone = join(dir, "keystone.json");
	const seed = scenario.frontMatter.seed ?? {};

	await mkdir(home, { recursive: true });
	await mkdir(personal, { recursive: true });
	await symlink(join(base.home, "tools"), join(home, "tools"));
	await copyFile(join(repo, "WORKING-WITH-GEORGE.md"), wisdom);
	if (seed.personal) await appendFile(wisdom, `\n${seed.personal}`);

	await bootstrap(repo, home, wisdom);

	const memory = join(home, "memory");
	for (const [date, text] of Object.entries(seed.daily ?? {})) {
		await writeFile(join(memory, "daily", `${date}.md`), text);
	}
	if (seed.memory) await appendFile(join(memory, "MEMORY.md"), `\n${seed.memory}`);
	await inSamwise(repo, home, "qmd update >/dev/null && qmd embed >/dev/null");

	const agent = join(home, "agent");
	if (auth) await symlink(auth, join(agent, "auth.json"));
	if (modelsJson) await copyFile(modelsJson, join(agent, "models.json"));
	await writeFile(keystone, JSON.stringify(scenario.frontMatter.keystone_mock ?? []));

	await mkdir(workspace);
	await writeFile(join(workspace, "package.json"), `${JSON.stringify({ name: "scratch", version: "0.0.0", private: true }, null, 2)}\n`);
	await exec("git", ["init", "-q"], { cwd: workspace });

	return { dir, home, personal, wisdom, workspace, keystone };
}

// Personal-scope files after a run: the run's WORKING-WITH-GEORGE.md copy plus
// any file of that name the model created in the workspace. Paths are relative
// to the run dir.
export async function personalFiles(run) {
	const paths = [run.wisdom];
	for (const entry of await readdir(run.workspace, { recursive: true })) {
		const parts = entry.split(sep);
		if (basename(entry) === "WORKING-WITH-GEORGE.md" && !parts.includes(".git") && !parts.includes("node_modules")) {
			paths.push(join(run.workspace, entry));
		}
	}
	return Promise.all(paths.map(async (p) => ({ path: relative(run.dir, p), text: await readFile(p, "utf8") })));
}
