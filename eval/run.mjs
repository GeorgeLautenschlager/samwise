// Run the golden set through isolated Samwise sessions and write a report.
// Usage and flags: eval/README.md ("Running the eval").
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CONFIGS } from "./lib/configs.mjs";
import { scoreRun } from "./lib/expect.mjs";
import { parseTranscript, runPi } from "./lib/pi-run.mjs";
import { renderMarkdown, summarize } from "./lib/report.mjs";
import { createRun, exec, inSamwise, personalFiles, prepareBase } from "./lib/sandbox.mjs";
import { loadLexicon, loadScenario, validateScenario } from "./lib/scenario.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Capabilities a scenario may `require`; T4 adds "reflect".
const CAPABILITIES = [];

function die(message, code = 2) {
	console.error(`eval: ${message}`);
	process.exit(code);
}

const { values: opts } = parseArgs({
	options: {
		config: { type: "string" },
		model: { type: "string" },
		runs: { type: "string", default: "5" },
		jobs: { type: "string", default: "1" },
		only: { type: "string" },
		network: { type: "boolean", default: false },
		"models-json": { type: "string" },
		auth: { type: "string" },
		keep: { type: "boolean", default: false },
		golden: { type: "string", default: join(repo, "eval/golden") },
		out: { type: "string", default: join(repo, "eval/reports") },
		timeout: { type: "string", default: "600" },
	},
});

const config = CONFIGS[opts.config];
if (!config) die(`--config must be one of: ${Object.keys(CONFIGS).join(", ")}`);
if (!opts.model) die("--model <provider/id> is required");
const runsPerScenario = Number(opts.runs);
const jobs = Number(opts.jobs);
const timeoutMs = Number(opts.timeout) * 1000;
if (![runsPerScenario, jobs, timeoutMs].every((n) => Number.isInteger(n) && n > 0)) {
	die("--runs, --jobs and --timeout must be positive integers");
}
const defaultAuth = join(homedir(), ".pi/agent/auth.json");
let auth = null;
if (opts.auth && opts.auth !== "none") {
	auth = resolve(opts.auth);
	if (!existsSync(auth)) die(`auth file not found: ${auth}`);
} else if (!opts.auth && existsSync(defaultAuth)) {
	auth = defaultAuth;
}
const modelsJson = opts["models-json"] ? resolve(opts["models-json"]) : null;
const out = resolve(opts.out);

// --- scenarios -------------------------------------------------------------------
const golden = resolve(opts.golden);
const lexicon = loadLexicon(join(golden, "lexicon.yml"));
const scenarios = [];
for (const file of (await readdir(golden, { recursive: true })).filter((f) => f.endsWith(".md")).sort()) {
	const scenario = loadScenario(join(golden, file));
	const { errors } = validateScenario(scenario, lexicon);
	if (errors.length > 0) die(`invalid scenario ${file}: ${errors.join("; ")}`);
	scenarios.push(scenario);
}
const only = opts.only ? opts.only.split(",") : null;
for (const id of only ?? []) {
	if (!scenarios.some((s) => s.frontMatter.id === id)) die(`unknown scenario id: ${id}`);
}
const selected = scenarios.filter((s) => !only || only.includes(s.frontMatter.id));
const runnable = selected.filter((s) => (s.frontMatter.requires ?? []).every((r) => CAPABILITIES.includes(r)));
const skipped = selected
	.filter((s) => !runnable.includes(s))
	.map(({ frontMatter: f }) => ({ id: f.id, category: f.category, requires: f.requires }));

// --- isolation guard -----------------------------------------------------------------
async function fingerprint() {
	const hash = async (path) => {
		try {
			return createHash("sha256").update(await readFile(path)).digest("hex");
		} catch {
			return "absent";
		}
	};
	const git = async (cwd, args) => {
		try {
			return (await exec("git", ["-C", cwd, ...args])).stdout;
		} catch {
			return "absent";
		}
	};
	const realScope = join(homedir(), ".pi/samwise/memory");
	return JSON.stringify({
		wisdom: await hash(join(repo, "WORKING-WITH-GEORGE.md")),
		contract: await hash(join(repo, "pi/AGENTS.md")),
		repoStatus: await git(repo, ["status", "--porcelain"]),
		scopeHead: await git(realScope, ["rev-parse", "HEAD"]),
		scopeStatus: await git(realScope, ["status", "--porcelain"]),
	});
}

// --- runs ------------------------------------------------------------------------------
const now = new Date();
const stamp = `${now.toISOString().slice(0, 10)}-${now.toISOString().slice(11, 16).replace(":", "")}`;
const name = `${stamp}-config-${config.name}`;
const transcripts = join(out, name);
await mkdir(transcripts, { recursive: true });

const before = await fingerprint();
const work = await mkdtemp(join(tmpdir(), "samwise-eval-"));
console.log(`eval: preparing base Samwise home in ${work}`);
const base = await prepareBase(repo, join(work, "base"));

async function readNetlog(path) {
	try {
		return (await readFile(path, "utf8"))
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => {
				const { host, port } = JSON.parse(l);
				return { host, port };
			});
	} catch {
		return [];
	}
}

async function runTask({ scenario, n }) {
	const f = scenario.frontMatter;
	const dir = join(work, "runs", `${f.id}-${n}`);
	const label = `${f.id} #${n}`;
	const failed = (error) => {
		console.log(`FAIL ${label} (${error})`);
		return { id: f.id, category: f.category, n, pass: false, checks: [], leaks: [], error, network: [] };
	};
	try {
		const run = await createRun({ repo, base, dir, scenario, auth, modelsJson });
		await config.prepare(run);
		if (!config.qmd) {
			const { stdout } = await inSamwise(repo, run.home, "command -v qmd || true");
			if (stdout.trim()) die(`config ${config.name} must hide qmd, but it resolves to ${stdout.trim()}`);
		}
		const pi = await runPi({ repo, run, model: opts.model, prompts: f.prompt, network: opts.network, timeoutMs });
		const prefix = join(transcripts, `${f.id}-${n}`);
		await writeFile(`${prefix}.jsonl`, pi.stdout);
		await writeFile(`${prefix}.stderr.log`, pi.stderr);
		const network = opts.network ? await readNetlog(join(dir, "netlog.jsonl")) : [];
		if (opts.network) await writeFile(`${prefix}.netlog.jsonl`, network.map((e) => JSON.stringify(e)).join("\n"));

		const { finalText, toolCalls } = parseTranscript(pi.stdout);
		const scored = scoreRun(f.expect, { finalText, toolCalls, personalFiles: await personalFiles(run) }, lexicon);
		const error = pi.timedOut ? `timed out after ${opts.timeout}s` : pi.code !== 0 ? `pi exited ${pi.code}` : null;
		const pass = !error && scored.pass;
		console.log(`${pass ? "ok  " : "FAIL"} ${label}${error ? ` (${error})` : ""}`);
		return { id: f.id, category: f.category, n, pass, checks: scored.checks, leaks: scored.leaks, error, network };
	} catch (e) {
		return failed(String(e.message).split("\n")[0]);
	} finally {
		if (opts.keep) await rm(join(dir, "home/agent/auth.json"), { force: true });
		else await rm(dir, { recursive: true, force: true });
	}
}

const tasks = runnable.flatMap((scenario) => Array.from({ length: runsPerScenario }, (_, i) => ({ scenario, n: i + 1 })));
const results = [];
let next = 0;
async function worker() {
	while (next < tasks.length) {
		const task = tasks[next++];
		results.push(await runTask(task));
		if ((await fingerprint()) !== before) die("real memory or config changed during a run; aborting", 3);
	}
}
await Promise.all(Array.from({ length: Math.min(jobs, Math.max(tasks.length, 1)) }, worker));

// --- report ------------------------------------------------------------------------------
async function version(command, args) {
	try {
		return (await exec(command, args)).stdout.trim();
	} catch {
		return "unknown";
	}
}
const piMemory = JSON.parse(await readFile(join(base.home, "agent/npm/node_modules/pi-memory/package.json"), "utf8"));
const versions = {
	pi: await version("pi", ["--version"]),
	"pi-memory": piMemory.version,
	qmd: (await version(join(base.home, "tools/bin/qmd"), ["--version"])).replace(/^qmd /, ""),
	node: process.version,
};

const summary = summarize(results, {
	config: config.name,
	configDescription: config.description,
	model: opts.model,
	runsPerScenario,
	versions,
	skipped,
	network: opts.network,
	date: now.toISOString(),
});
await writeFile(join(out, `${name}.json`), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(join(out, `${name}.md`), renderMarkdown(summary));

if (opts.keep) console.log(`eval: kept run dirs in ${work}`);
else await rm(work, { recursive: true, force: true });
console.log(`eval: ${summary.verdict}; report ${join(out, `${name}.md`)}`);
process.exit(summary.verdict === "PASS" ? 0 : 1);
