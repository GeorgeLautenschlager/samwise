import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	checkDependencies,
	checkPinnedVersion,
	checkPolicy,
	checkPolicyCoverage,
	checkPolicyLink,
	checkProjectPolicy,
} from "../checks.mjs";

// A fake config repo with pi/settings.json and pi/sandbox.json (skipped when
// policy is null) and an empty agent dir, all removed when the test ends.
function fixture(t, { policy = '{\n  "enabled": true\n}\n', pin = "0.6.8" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "samwise-checks-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const agent = join(root, "agent");
	mkdirSync(join(repo, "pi"), { recursive: true });
	mkdirSync(agent);
	writeFileSync(join(repo, "pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-memory@0.4.2", `npm:pi-sandbox@${pin}`] }));
	if (policy !== null) writeFileSync(join(repo, "pi", "sandbox.json"), policy);
	return { root, repo, agent };
}

function installPackage(dir, name, version, files = {}) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, type: "module", main: "./index.js" }));
	for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
}

// Source for a fake @carderne/sandbox-runtime whose checkDependencies()
// reports `errors`.
const runtimeReporting = (errors) =>
	`export const SandboxManager = { checkDependencies: () => ({ errors: ${JSON.stringify(errors)}, warnings: [] }) };\n`;

test("policy link: a symlink to the repo policy passes", (t) => {
	const { repo, agent } = fixture(t);
	symlinkSync(join(repo, "pi", "sandbox.json"), join(agent, "sandbox.json"));
	assert.deepEqual(checkPolicyLink(repo, agent), []);
});

test("policy link: missing, a regular file, pointing elsewhere, or broken fails", (t) => {
	const { root, repo, agent } = fixture(t);
	assert.match(checkPolicyLink(repo, agent)[0], /sandbox\.json is missing/);

	writeFileSync(join(agent, "sandbox.json"), "{}");
	assert.match(checkPolicyLink(repo, agent)[0], /is not a symlink/);

	const other = fixture(t);
	symlinkSync(join(other.repo, "pi", "sandbox.json"), join(root, "elsewhere.json"));
	const agent2 = join(root, "agent2");
	mkdirSync(agent2);
	symlinkSync(join(root, "elsewhere.json"), join(agent2, "sandbox.json"));
	assert.match(checkPolicyLink(repo, agent2)[0], /points to .*, not /);

	const agent3 = join(root, "agent3");
	mkdirSync(agent3);
	symlinkSync(join(root, "nonexistent.json"), join(agent3, "sandbox.json"));
	assert.match(checkPolicyLink(repo, agent3)[0], /broken symlink/);
});

test("policy coverage: repo and memory readable, reflect dir writable passes", (t) => {
	const { root, repo } = fixture(t);
	const home = join(root, "home");
	mkdirSync(home);
	writeFileSync(join(repo, "pi", "sandbox.json"), JSON.stringify({ filesystem: { allowRead: [repo, "~/.pi/samwise/memory"], allowWrite: ["~/.pi/samwise/reflect"] } }));
	const env = { HOME: home, PI_MEMORY_DIR: join(home, ".pi/samwise/memory"), SAMWISE_HOME: join(home, ".pi/samwise") };
	assert.deepEqual(checkPolicyCoverage(repo, root, env), []);
});

test("policy coverage: a reflect dir that is only readable is reported as not writable", (t) => {
	const { root, repo } = fixture(t);
	writeFileSync(join(repo, "pi", "sandbox.json"), JSON.stringify({ filesystem: { allowRead: [root] } }));
	const env = { HOME: root, PI_MEMORY_DIR: join(root, "mem"), SAMWISE_HOME: join(root, "sw") };
	const problems = checkPolicyCoverage(repo, root, env);
	assert.equal(problems.length, 1, problems.join("\n"));
	assert.match(problems[0], /sw\/reflect is not writable/);
});

test("policy coverage: each gap is named, with where to add it", (t) => {
	const { root, repo } = fixture(t);
	writeFileSync(join(repo, "pi", "sandbox.json"), JSON.stringify({ filesystem: { denyRead: ["~"] } }));
	const env = { HOME: root, PI_MEMORY_DIR: join(root, "mem"), SAMWISE_HOME: join(root, "sw") };
	const problems = checkPolicyCoverage(repo, join(root, "elsewhere"), env);
	assert.equal(problems.length, 3, problems.join("\\n"));
	assert.match(problems[0], /repo is not readable .*add it to allowRead/);
	assert.match(problems[1], /mem is not readable .*add it to allowRead/);
	assert.ok(problems[2].includes("sw/reflect is not writable") && problems[2].includes("add it to allowWrite"), problems[2]);
});

test("policy coverage: unset environment is reported; a broken policy is left to checkPolicy", (t) => {
	const { repo, root } = fixture(t);
	assert.deepEqual(checkPolicyCoverage(repo, root, { HOME: root }).filter((p) => /is not set/.test(p)).length, 2);
	writeFileSync(join(repo, "pi", "sandbox.json"), "{ not json");
	assert.deepEqual(checkPolicyCoverage(repo, root, { HOME: root, PI_MEMORY_DIR: "/m", SAMWISE_HOME: "/s" }), []);
});

test("policy: a JSON object that does not disable the fence passes", (t) => {
	assert.deepEqual(checkPolicy(fixture(t).repo), []);
	assert.deepEqual(checkPolicy(fixture(t, { policy: '{"enabled": true, "network": {}}' }).repo), []);
});

test("policy: missing, invalid JSON, non-object, or enabled:false fails", (t) => {
	assert.match(checkPolicy(fixture(t, { policy: null }).repo)[0], /is missing/);
	assert.match(checkPolicy(fixture(t, { policy: "{ not json" }).repo)[0], /not valid JSON.*fall back to its defaults/);
	assert.match(checkPolicy(fixture(t, { policy: "[]" }).repo)[0], /must be a JSON object/);
	assert.match(checkPolicy(fixture(t, { policy: '{"enabled": false}' }).repo)[0], /"enabled": false/);
});

test("project policy: none in the launch dir passes", (t) => {
	const { repo, root } = fixture(t);
	assert.deepEqual(checkProjectPolicy(repo, root), []);
});

test("project policy: a file or symlink at <cwd>/.pi/sandbox.json fails and says where to move it", (t) => {
	const { repo, root } = fixture(t);
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "sandbox.json"), '{"enabled": false}');
	const [problem] = checkProjectPolicy(repo, cwd);
	assert.match(problem, /\.pi\/sandbox\.json exists/);
	assert.ok(problem.includes(join(repo, "pi", "sandbox.json")), problem);

	const cwd2 = join(root, "project2");
	mkdirSync(join(cwd2, ".pi"), { recursive: true });
	symlinkSync(join(root, "nonexistent.json"), join(cwd2, ".pi", "sandbox.json"));
	assert.equal(checkProjectPolicy(repo, cwd2).length, 1);
});

test("pinned version: installed at the pin passes; missing or different fails", (t) => {
	const { repo, agent } = fixture(t);
	assert.match(checkPinnedVersion(repo, agent)[0], /not installed/);
	installPackage(join(agent, "npm", "node_modules", "pi-sandbox"), "pi-sandbox", "0.6.7");
	assert.match(checkPinnedVersion(repo, agent)[0], /0\.6\.7 is installed but 0\.6\.8 is pinned/);
	installPackage(join(agent, "npm", "node_modules", "pi-sandbox"), "pi-sandbox", "0.6.8");
	assert.deepEqual(checkPinnedVersion(repo, agent), []);
});

test("pinned version: pi-sandbox absent from settings fails", (t) => {
	const { repo, agent } = fixture(t);
	writeFileSync(join(repo, "pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-memory@0.4.2"] }));
	assert.match(checkPinnedVersion(repo, agent)[0], /not in .*settings\.json/);
});

test("dependencies: the runtime's own check is reported, from the hoisted copy or the nested one, which wins", async (t) => {
	const { agent } = fixture(t);
	assert.match((await checkDependencies(agent))[0], /sandbox-runtime not found/);

	const hoisted = join(agent, "npm", "node_modules", "@carderne", "sandbox-runtime");
	installPackage(hoisted, "@carderne/sandbox-runtime", "0.0.72", { "index.js": runtimeReporting([]) });
	assert.deepEqual(await checkDependencies(agent), []);

	const nested = join(agent, "npm", "node_modules", "pi-sandbox", "node_modules", "@carderne", "sandbox-runtime");
	installPackage(nested, "@carderne/sandbox-runtime", "0.0.72", {
		"index.js": runtimeReporting(["bubblewrap (bwrap) not installed", "socat not installed"]),
	});
	assert.deepEqual(await checkDependencies(agent), [
		"sandbox dependency: bubblewrap (bwrap) not installed",
		"sandbox dependency: socat not installed",
	]);
});
