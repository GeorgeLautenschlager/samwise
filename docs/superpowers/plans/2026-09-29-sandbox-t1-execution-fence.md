# Sandbox T1: Install Execution Fence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use steward:steward-local-sdd (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap installs a pinned pi-sandbox and links the config repo's `sandbox.json`; `bin/samwise` never lets Pi start with the fence silently off; bootstrap reports uncommitted policy changes.

**Architecture:** pi-sandbox is a Pi package pinned in `pi/settings.json`. Its policy file lives at `pi/sandbox.json` and is symlinked into the agent dir. Because pi-sandbox fails open, `bin/samwise` refuses `--no-sandbox`, refuses non-macOS platforms unless `SAMWISE_UNSANDBOXED=1`, and on macOS runs a Node preflight (`lib/sandbox/preflight.mjs` over `lib/sandbox/checks.mjs`) before `exec pi`. Two small bash helpers (`lib/sandbox/deps.sh`, `lib/sandbox/drift.sh`) keep bootstrap's new steps testable with stubs.

**Tech Stack:** bash, Node ≥ 22.19 (ESM, `node:test`), Pi 0.87.1, pi-sandbox 0.6.8 (`@carderne/sandbox-runtime` 0.0.72).

**Spec:** `docs/superpowers/specs/2026-09-29-sandbox-t1-execution-fence-design.md`

**Conventions in this repo:**
- Bash tests are `test/*.test.sh`, sourcing `test/lib.sh` (`fail`, `pass`, `assert_eq`, `assert_contains`, `assert_not_contains`). `test/run.sh` runs them all; `SKIP_INTEGRATION=1` skips `bootstrap.test.sh` (slow, needs network).
- Node unit tests are `node:test` files under `<module>/test/*.test.mjs`, run by `test/unit.test.sh`. JS uses tabs; bash uses 2 spaces.
- Commit messages: short imperative subject ending in `(#11)`, then a blank line and:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9
  ```
- Work on branch `sandbox-t1-execution-fence` (already checked out). Do not edit repo files while a long test (bootstrap/eval-runner) is running in the background.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `pi/settings.json` | modify | Pin `npm:pi-sandbox@0.6.8` |
| `pi/sandbox.json` | create | Placeholder policy (`enabled: true`) |
| `lib/sandbox/checks.mjs` | create | Pure preflight checks, each returning problem strings |
| `lib/sandbox/preflight.mjs` | create | CLI: run all checks, print problems, exit 1 on any |
| `lib/sandbox/test/checks.test.mjs` | create | Unit tests for the checks |
| `lib/sandbox/deps.sh` | create | Install ripgrep on macOS; note "unsupported" elsewhere |
| `lib/sandbox/drift.sh` | create | Report uncommitted changes to `pi/sandbox.json` |
| `bin/samwise` | modify | Refuse `--no-sandbox`; platform gate; preflight |
| `bootstrap.sh` | modify | Link `sandbox.json`; run deps.sh and drift.sh |
| `eval/lib/pi-run.mjs` | modify | Set `SAMWISE_UNSANDBOXED=1` for eval sessions |
| `test/settings.test.sh` | modify | Every npm package pinned exactly |
| `test/unit.test.sh` | modify | Also run `lib/sandbox/test/*.test.mjs` |
| `test/launcher.test.sh` | modify | Fence behaviour of the launcher |
| `test/sandbox.test.sh` | create | deps.sh, drift.sh, policy-file formatting |
| `test/bootstrap.test.sh` | modify | Link, install, notice, re-run, e2e opt-in |
| `README.md` | modify | Document the fence |

---

### Task 1: Pin pi-sandbox and add the placeholder policy

**Files:**
- Modify: `pi/settings.json`
- Create: `pi/sandbox.json`
- Modify: `test/settings.test.sh` (append)

- [ ] **Step 1: Write the failing test**

Append to the end of `test/settings.test.sh`:

```bash

# --- repo settings: npm packages pinned exactly (sandbox D1) -----------------

unpinned="$(node -e '
const { packages = [] } = require(process.argv[1]);
for (const p of packages) {
	const s = typeof p === "string" ? p : p.source;
	if (s.startsWith("npm:") && !/^npm:(@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+$/.test(s)) console.log(s);
}' "$REPO/pi/settings.json")"
assert_eq "$unpinned" "" "every npm package in pi/settings.json is pinned to an exact version"
assert_contains "$(cat "$REPO/pi/settings.json")" '"npm:pi-sandbox@0.6.8"' "pi-sandbox is pinned (D1)"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash test/settings.test.sh`
Expected: FAIL with `pi-sandbox is pinned (D1): '"npm:pi-sandbox@0.6.8"' not found in: ...` (the exact-pin check passes first).

- [ ] **Step 3: Pin the package and add the policy file**

- `pi/settings.json`: add `"npm:pi-sandbox@0.6.8"` to `packages`, after pi-memory. Keep the file's existing 2-space formatting.
- Create `pi/sandbox.json`: the JSON object `{"enabled": true}`, formatted exactly as pi-sandbox rewrites the file (`JSON.stringify(config, null, 2)` plus a trailing newline), so approvals written through the symlink make minimal diffs. It is a placeholder: pi-sandbox's built-in defaults apply until T2 writes the real policy.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash test/settings.test.sh`
Expected: all lines `ok - ...`, including `ok - pi-sandbox is pinned (D1)`.

- [ ] **Step 5: Commit**

```bash
git add pi/settings.json pi/sandbox.json test/settings.test.sh
git commit -m "Pin pi-sandbox 0.6.8 and add a placeholder sandbox policy (#11)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9"
```

---

### Task 2: Preflight checks

**Files:**
- Create: `lib/sandbox/checks.mjs`
- Create: `lib/sandbox/preflight.mjs`
- Create: `lib/sandbox/test/checks.test.mjs`
- Modify: `test/unit.test.sh`

- [ ] **Step 1: Write the failing tests**

Create `lib/sandbox/test/checks.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	checkDependencies,
	checkPinnedVersion,
	checkPolicy,
	checkPolicyLink,
	checkProjectPolicy,
} from "../checks.mjs";

// A fake config repo with pi/settings.json and pi/sandbox.json, and an empty agent dir.
function fixture({ policy = '{\n  "enabled": true\n}\n', pin = "0.6.8" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "samwise-checks-"));
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

const runtimeReporting = (errors) =>
	`export const SandboxManager = { checkDependencies: () => ({ errors: ${JSON.stringify(errors)}, warnings: [] }) };\n`;

test("policy link: a symlink to the repo policy passes", () => {
	const { repo, agent } = fixture();
	symlinkSync(join(repo, "pi", "sandbox.json"), join(agent, "sandbox.json"));
	assert.deepEqual(checkPolicyLink(repo, agent), []);
});

test("policy link: missing, a regular file, or pointing elsewhere fails", () => {
	const { root, repo, agent } = fixture();
	assert.match(checkPolicyLink(repo, agent)[0], /sandbox\.json is missing/);

	writeFileSync(join(agent, "sandbox.json"), "{}");
	assert.match(checkPolicyLink(repo, agent)[0], /is not a symlink/);

	const other = fixture();
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

test("policy: a JSON object that does not disable the fence passes", () => {
	assert.deepEqual(checkPolicy(fixture().repo), []);
	assert.deepEqual(checkPolicy(fixture({ policy: '{"enabled": true, "network": {}}' }).repo), []);
});

test("policy: missing, invalid JSON, non-object, or enabled:false fails", () => {
	assert.match(checkPolicy(fixture({ policy: null }).repo)[0], /is missing/);
	assert.match(checkPolicy(fixture({ policy: "{ not json" }).repo)[0], /not valid JSON.*fall back to its defaults/);
	assert.match(checkPolicy(fixture({ policy: "[]" }).repo)[0], /must be a JSON object/);
	assert.match(checkPolicy(fixture({ policy: '{"enabled": false}' }).repo)[0], /"enabled": false/);
});

test("project policy: none in the launch dir passes", () => {
	const { repo, root } = fixture();
	assert.deepEqual(checkProjectPolicy(repo, root), []);
});

test("project policy: a file or symlink at <cwd>/.pi/sandbox.json fails and says where to move it", () => {
	const { repo, root } = fixture();
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

test("pinned version: installed at the pin passes; missing or different fails", () => {
	const { repo, agent } = fixture();
	assert.match(checkPinnedVersion(repo, agent)[0], /not installed/);
	installPackage(join(agent, "npm", "node_modules", "pi-sandbox"), "pi-sandbox", "0.6.7");
	assert.match(checkPinnedVersion(repo, agent)[0], /0\.6\.7 is installed but 0\.6\.8 is pinned/);
	installPackage(join(agent, "npm", "node_modules", "pi-sandbox"), "pi-sandbox", "0.6.8");
	assert.deepEqual(checkPinnedVersion(repo, agent), []);
});

test("pinned version: pi-sandbox absent from settings fails", () => {
	const { repo, agent } = fixture();
	writeFileSync(join(repo, "pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-memory@0.4.2"] }));
	assert.match(checkPinnedVersion(repo, agent)[0], /not in .*settings\.json/);
});

test("dependencies: the runtime's own check is reported, hoisted or nested", async () => {
	const { agent } = fixture();
	assert.match((await checkDependencies(agent))[0], /sandbox-runtime not found/);

	const nested = join(agent, "npm", "node_modules", "pi-sandbox", "node_modules", "@carderne", "sandbox-runtime");
	installPackage(nested, "@carderne/sandbox-runtime", "0.0.72", { "index.js": runtimeReporting([]) });
	assert.deepEqual(await checkDependencies(agent), []);

	const hoisted = join(agent, "npm", "node_modules", "@carderne", "sandbox-runtime");
	installPackage(hoisted, "@carderne/sandbox-runtime", "0.0.72", {
		"index.js": runtimeReporting(["bubblewrap (bwrap) not installed", "socat not installed"]),
	});
	assert.deepEqual(await checkDependencies(agent), [
		"sandbox dependency: bubblewrap (bwrap) not installed",
		"sandbox dependency: socat not installed",
	]);
});
```

In `test/unit.test.sh`, change the comment and the loop so they cover the new directory:

```bash
# Runs the node:test unit tests: eval/test, lib/reflect/test and lib/sandbox/test.
```

```bash
for t in "$REPO"/eval/test/*.test.mjs "$REPO"/lib/reflect/test/*.test.mjs "$REPO"/lib/sandbox/test/*.test.mjs; do
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/sandbox/test/checks.test.mjs`
Expected: FAIL, `Cannot find module '.../lib/sandbox/checks.mjs'`.

- [ ] **Step 3: Implement the checks**

`lib/sandbox/checks.mjs`: ES module, tab-indented, Node built-ins only, header comment explaining that pi-sandbox fails open (if it cannot initialise, bash runs unwrapped and read/write/edit go unchecked, with only a UI notice), so `bin/samwise` runs these first. Every export returns an array of problem strings (empty = pass); the messages must satisfy the regexes in the tests. Interface and behaviour:

- `checkPolicyLink(repo, agentDir)`: `<agentDir>/sandbox.json` must be a symlink whose real path equals the real path of `<repo>/pi/sandbox.json`. Distinguish, in this order: missing (`... is missing; run bootstrap.sh`), not a symlink (`... is not a symlink to <policy>; move it aside and run bootstrap.sh`), broken symlink (`... is a broken symlink; run bootstrap.sh`), points elsewhere (`<link> points to <target>, not <policy>; run bootstrap.sh`). Detect existence with `lstat` so a broken link counts as present.
- `checkPolicy(repo)`: `<repo>/pi/sandbox.json` missing → `<path> is missing`; unparseable → `<path> is not valid JSON (<parser message>); pi-sandbox would fall back to its defaults`; not a plain object (array, null, scalar) → `<path> must be a JSON object`; `"enabled": false` → `<path> sets "enabled": false`.
- `checkProjectPolicy(repo, cwd)`: if `<cwd>/.pi/sandbox.json` exists as a file or a symlink (even broken), one problem: `<that path> exists; move its entries into <repo>/pi/sandbox.json and delete it (a project policy can widen or disable the sandbox)`.
- `checkPinnedVersion(repo, agentDir)`: read the pin from the `npm:pi-sandbox@<version>` entry of `<repo>/pi/settings.json` `packages` (entries may be strings or `{ source }` objects). No entry → `pi-sandbox is not in <settings path>`; `<agentDir>/npm/node_modules/pi-sandbox/package.json` missing → `pi-sandbox is not installed in <agentDir>; run bootstrap.sh`; different version → `pi-sandbox <installed> is installed but <pinned> is pinned; run bootstrap.sh`.
- `async checkDependencies(agentDir)`: find `@carderne/sandbox-runtime` at `<agentDir>/npm/node_modules/@carderne/sandbox-runtime` (hoisted, preferred) or `<agentDir>/npm/node_modules/pi-sandbox/node_modules/@carderne/sandbox-runtime` (nested). Neither → `@carderne/sandbox-runtime not found under <agentDir>/npm/node_modules; run bootstrap.sh`. Otherwise dynamically import its entry (`main` from its `package.json`, default `index.js`, via a `file://` URL) and return `SandboxManager.checkDependencies().errors`, each prefixed `sandbox dependency: `.

`lib/sandbox/preflight.mjs`: CLI, `node lib/sandbox/preflight.mjs <repo> <agent-dir> <cwd>`. Missing arguments → usage line to stderr, exit 2. Runs all five checks, prints each problem to stderr as `samwise: <problem>`, exits 1 if there were any, else exits 0 printing nothing. Header comment with the usage line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/sandbox/test/checks.test.mjs && bash test/unit.test.sh`
Expected: `# pass 9`, `# fail 0`; `unit.test.sh` prints `ok - lib/sandbox/test/checks.test.mjs (pass 9)`.

- [ ] **Step 5: Check against the real runtime (evidence for fail-closed on this box)**

```bash
scratch="$(mktemp -d)"
PI_CODING_AGENT_DIR="$scratch/agent" pi install npm:pi-sandbox@0.6.8 </dev/null >/dev/null
node --input-type=module -e '
import { checkDependencies } from "./lib/sandbox/checks.mjs";
console.log(await checkDependencies(process.argv[1]));' "$scratch/agent"
rm -rf "$scratch"
```

Expected on this Linux box: a non-empty list including `sandbox dependency: bubblewrap (bwrap) not installed` and `sandbox dependency: socat not installed`. This proves the check calls the real runtime.

- [ ] **Step 6: Commit**

```bash
git add lib/sandbox/checks.mjs lib/sandbox/preflight.mjs lib/sandbox/test/checks.test.mjs test/unit.test.sh
git commit -m "Add sandbox preflight checks (#11)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9"
```

---

### Task 3: Fail-closed launcher, and the eval runner opts in

**Files:**
- Modify: `bin/samwise`
- Modify: `test/launcher.test.sh`
- Modify: `eval/lib/pi-run.mjs:40` (the `extra` object in `runPi`)

- [ ] **Step 1: Write the failing tests**

In `test/launcher.test.sh`, the three existing launches run on Linux and now need the opt-in; Pi also receives `--no-sandbox` first. Replace the three existing blocks (from `out="$(SAMWISE_HOME="$tmp/home" PATH="$tmp/stub:$PATH" "$REPO/bin/samwise" --model x "hello world")"` to the end of the file) with:

```bash
# Every launch here is on Linux, where the fence is unsupported: opt in.
export SAMWISE_UNSANDBOXED=1

out="$(SAMWISE_HOME="$tmp/home" PATH="$tmp/stub:$PATH" "$REPO/bin/samwise" --model x "hello world" 2>/dev/null)"
assert_eq "$out" "$tmp/home/agent|per-turn|--no-sandbox --model x hello world" \
  "launcher exports env and passes args to pi"

# Launching through a symlink (e.g. ~/bin/samwise) must still find lib/env.sh.
ln -s "$REPO/bin/samwise" "$tmp/links/samwise"
out="$(SAMWISE_HOME="$tmp/home" PATH="$tmp/stub:$PATH" "$tmp/links/samwise" 2>/dev/null)"
assert_eq "$out" "$tmp/home/agent|per-turn|--no-sandbox" "launcher works through a symlink"

# The launcher puts the repo's bin/ on PATH, so Samwise can run samwise-reflect.
mkdir -p "$tmp/stub2"
cat >"$tmp/stub2/pi" <<'EOF'
#!/usr/bin/env bash
command -v samwise-reflect
EOF
chmod +x "$tmp/stub2/pi"
out="$(SAMWISE_HOME="$tmp/home" PATH="$tmp/stub2:$PATH" "$REPO/bin/samwise" 2>/dev/null)"
assert_eq "$out" "$REPO/bin/samwise-reflect" "launcher puts samwise-reflect on PATH"

# --- execution fence (sandbox D7) --------------------------------------------

# launch <expected-exit|any> <env...> -- <args...>: run the launcher with the
# echo stub; sets $out (stdout+stderr) and fails if the exit code differs.
launch() {
  local want="$1" envs=() code=0
  shift
  while [[ "$1" != -- ]]; do envs+=("$1"); shift; done
  shift
  out="$(env "${envs[@]}" SAMWISE_HOME="$tmp/home" PATH="$tmp/stub:$PATH" "$REPO/bin/samwise" "$@" 2>&1)" || code=$?
  [[ "$want" == any || "$code" == "$want" ]] || fail "expected exit $want, got $code: $out"
}

launch 2 -- --model x --no-sandbox "hi"
assert_contains "$out" "--no-sandbox is not allowed" "--no-sandbox is refused (AC3)"
assert_not_contains "$out" "per-turn" "pi is not started when --no-sandbox is passed"

launch 2 -u SAMWISE_UNSANDBOXED -- "hi"
assert_contains "$out" "only runs on macOS" "non-macOS without the opt-in is refused"
assert_not_contains "$out" "per-turn" "pi is not started without the opt-in"

launch 0 -- "hi"
assert_contains "$out" "WARNING: running WITHOUT the sandbox" "the opt-in warns loudly"
assert_contains "$out" "|per-turn|--no-sandbox hi" "the opt-in starts pi with the sandbox off"

# macOS, simulated with a uname stub first on PATH.
mkdir -p "$tmp/darwin"
printf '#!/usr/bin/env bash\necho Darwin\n' >"$tmp/darwin/uname"
chmod +x "$tmp/darwin/uname"

# launch_darwin <expected-exit> <args...>: launch as macOS with home $tmp/mac
# from the current directory; SAMWISE_UNSANDBOXED stays as the caller set it.
launch_darwin() {
  local want="$1" code=0
  shift
  out="$(SAMWISE_HOME="$tmp/mac" PATH="$tmp/darwin:$tmp/stub:$PATH" "$REPO/bin/samwise" "$@" 2>&1)" || code=$?
  [[ "$code" == "$want" ]] || fail "expected exit $want, got $code: $out"
}

launch_darwin 2 "hi" # SAMWISE_UNSANDBOXED=1 is still exported
assert_contains "$out" "SAMWISE_UNSANDBOXED is not honoured on macOS" "macOS refuses the opt-out"
assert_not_contains "$out" "per-turn" "pi is not started on macOS with the opt-out set"

unset SAMWISE_UNSANDBOXED

launch_darwin 2 "hi"
assert_contains "$out" "sandbox preflight failed" "macOS with a failing preflight is refused"
assert_contains "$out" "sandbox.json is missing" "the preflight's problems are shown"
assert_not_contains "$out" "per-turn" "pi is not started when the preflight fails"

# A home that passes the preflight: linked policy, pinned pi-sandbox, a
# runtime reporting no missing dependencies.
pin="$(node -p 'require(process.argv[1]).packages.find((p) => p.startsWith("npm:pi-sandbox@")).split("@")[1]' "$REPO/pi/settings.json")"
mods="$tmp/mac/agent/npm/node_modules"
mkdir -p "$mods/pi-sandbox" "$mods/@carderne/sandbox-runtime"
ln -s "$REPO/pi/sandbox.json" "$tmp/mac/agent/sandbox.json"
printf '{"name":"pi-sandbox","version":"%s"}' "$pin" >"$mods/pi-sandbox/package.json"
printf '{"name":"@carderne/sandbox-runtime","version":"0.0.72","type":"module","main":"./index.js"}' \
  >"$mods/@carderne/sandbox-runtime/package.json"
echo 'export const SandboxManager = { checkDependencies: () => ({ errors: [], warnings: [] }) };' \
  >"$mods/@carderne/sandbox-runtime/index.js"

pushd "$tmp" >/dev/null # a launch dir without .pi/sandbox.json
launch_darwin 0 --model x "hi"
popd >/dev/null
assert_eq "$out" "$tmp/mac/agent|per-turn|--model x hi" "macOS with a passing preflight starts pi with the sandbox on"

mkdir -p "$tmp/project/.pi"
echo '{"enabled": false}' >"$tmp/project/.pi/sandbox.json"
pushd "$tmp/project" >/dev/null
launch_darwin 2 "hi"
popd >/dev/null
assert_contains "$out" ".pi/sandbox.json exists" "a project .pi/sandbox.json stops the launch"
```

Also update the file's first comment line to:

```bash
# Unit tests for bin/samwise, using a stub `pi` that echoes its environment
# and a stub `uname` to simulate macOS.
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bash test/launcher.test.sh`
Expected: FAIL on the first assertion, `launcher exports env and passes args to pi: expected '.../home/agent|per-turn|--no-sandbox --model x hello world', got '.../home/agent|per-turn|--model x hello world'`.

- [ ] **Step 3: Implement the launcher**

`bin/samwise` keeps its current start (resolve `repo` through symlinks, source `lib/env.sh`, put `$repo/bin` on PATH). Update its header comment to say it also keeps the execution fence on, and that pi-sandbox fails open, so the launcher refuses to start Pi unless the fence will come up (D7). Then, in order:

1. Any argument exactly equal to `--no-sandbox`: print `samwise: --no-sandbox is not allowed; Samwise always runs with the sandbox (D7)` to stderr and exit 2.
2. `uname -s` is not `Darwin`:
   - `SAMWISE_UNSANDBOXED` is not exactly `1`: print `samwise: the sandbox only runs on macOS; set SAMWISE_UNSANDBOXED=1 to run unfenced here (dev and eval only)` to stderr, exit 2.
   - Otherwise print `samwise: WARNING: running WITHOUT the sandbox (SAMWISE_UNSANDBOXED=1)` to stderr and `exec pi --no-sandbox "$@"`.
3. `Darwin`:
   - `SAMWISE_UNSANDBOXED` set to any value (even empty): print `samwise: SAMWISE_UNSANDBOXED is not honoured on macOS; unset it` to stderr, exit 2.
   - Run `node "$repo/lib/sandbox/preflight.mjs" "$repo" "$PI_CODING_AGENT_DIR" "$PWD"`; if it fails, print `samwise: sandbox preflight failed (see above); fix it or re-run bootstrap.sh` to stderr, exit 2.
   - `exec pi "$@"`.

All refusals go through one small helper that prints `samwise: <message>` to stderr and exits 2. Mind `set -e` pitfalls: use `if` blocks rather than a trailing `[[ ... ]] && ...` as the last command of a loop.

`eval/lib/pi-run.mjs`: in `runPi`, add `SAMWISE_UNSANDBOXED: "1"` to the `extra` environment object, with a one-line comment that the fence is macOS-only and eval runs on Linux run unfenced (sandbox T1).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash test/launcher.test.sh`
Expected: every line `ok - ...`, ending with `ok - a project .pi/sandbox.json stops the launch`.

Run: `bash test/eval-runner.test.sh` (slow, several minutes; run it in the background and do not edit files meanwhile)
Expected: passes as before (the runner's sessions now opt in).

- [ ] **Step 5: Commit**

```bash
git add bin/samwise test/launcher.test.sh eval/lib/pi-run.mjs
git commit -m "Launcher: fail closed unless the sandbox will come up (#11)" -m "Refuses --no-sandbox (D7), refuses non-macOS unless SAMWISE_UNSANDBOXED=1,
and runs the preflight on macOS. The eval runner opts in.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9"
```

---

### Task 4: Bootstrap helpers: ripgrep and policy drift

**Files:**
- Create: `lib/sandbox/deps.sh`
- Create: `lib/sandbox/drift.sh`
- Create: `test/sandbox.test.sh`

- [ ] **Step 1: Write the failing tests**

Create `test/sandbox.test.sh`:

```bash
#!/usr/bin/env bash
# Unit tests for bootstrap's sandbox helpers (lib/sandbox/deps.sh, drift.sh)
# and the policy file's format, using stub commands.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# stub <dir> <name> <body>: an executable with an absolute bash shebang, so it
# runs with a PATH that holds nothing but stubs.
stub() {
  mkdir -p "$1"
  printf '#!%s\n%s\n' "$BASH" "$3" >"$1/$2"
  chmod +x "$1/$2"
}

# --- deps.sh ------------------------------------------------------------------
# PATH is only the stub dir, so no real rg or brew can be found.
deps() { PATH="$1" "$BASH" "$REPO/lib/sandbox/deps.sh" 2>&1; }

stub "$tmp/linux" uname 'echo Linux'
out="$(deps "$tmp/linux")"
assert_contains "$out" "Sandbox unsupported on Linux" "deps: non-macOS prints the unsupported notice"
assert_contains "$out" "SAMWISE_UNSANDBOXED=1" "deps: the notice names the opt-in"

stub "$tmp/mac-rg" uname 'echo Darwin'
stub "$tmp/mac-rg" rg 'exit 0'
stub "$tmp/mac-rg" brew "echo called >'$tmp/brew-called'"
out="$(deps "$tmp/mac-rg")"
assert_eq "$out" "" "deps: macOS with rg present does nothing"
[[ ! -e "$tmp/brew-called" ]] || fail "deps: brew was called although rg is present"
pass "deps: brew is not called when rg is present"

stub "$tmp/mac-brew" uname 'echo Darwin'
stub "$tmp/mac-brew" brew "echo \"\$*\" >'$tmp/brew-args'"
deps "$tmp/mac-brew" >/dev/null
assert_eq "$(cat "$tmp/brew-args")" "install ripgrep" "deps: macOS without rg runs brew install ripgrep"

stub "$tmp/mac-bare" uname 'echo Darwin'
code=0
out="$(deps "$tmp/mac-bare")" || code=$?
assert_eq "$code" 1 "deps: macOS without rg or brew fails"
assert_contains "$out" "ripgrep (rg) is required" "deps: the failure says what is missing"

# --- drift.sh -----------------------------------------------------------------
repo="$tmp/repo"
mkdir -p "$repo/pi"
git -C "$repo" init -q -b main
printf '{\n  "enabled": true\n}\n' >"$repo/pi/sandbox.json"
git -C "$repo" add -A
git -C "$repo" -c user.name=t -c user.email=t@localhost commit -q -m init

assert_eq "$("$REPO/lib/sandbox/drift.sh" "$repo")" "" "drift: a committed policy is silent"

printf '{\n  "enabled": true,\n  "network": {\n    "allowedDomains": [\n      "example.com"\n    ]\n  }\n}\n' \
  >"$repo/pi/sandbox.json"
out="$("$REPO/lib/sandbox/drift.sh" "$repo")"
assert_contains "$out" "uncommitted sandbox policy changes" "drift: an uncommitted edit is reported"
assert_contains "$out" '+      "example.com"' "drift: the report shows the diff"

git -C "$repo" add pi/sandbox.json
assert_contains "$("$REPO/lib/sandbox/drift.sh" "$repo")" '+      "example.com"' "drift: a staged edit is reported too"
assert_eq "$(git -C "$repo" status --porcelain)" "M  pi/sandbox.json" "drift: reports only, never commits or reverts"

# --- the policy file is formatted as pi-sandbox writes it ---------------------
node -e '
const text = require("node:fs").readFileSync(process.argv[1], "utf8");
process.exit(text === JSON.stringify(JSON.parse(text), null, 2) + "\n" ? 0 : 1);
' "$REPO/pi/sandbox.json" || fail "pi/sandbox.json is not in pi-sandbox's own format"
pass "pi/sandbox.json uses pi-sandbox's format, so approvals make minimal diffs"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bash test/sandbox.test.sh`
Expected: FAIL, `deps: non-macOS prints the unsupported notice: 'Sandbox unsupported on Linux' not found in: ...No such file or directory`.

- [ ] **Step 3: Implement the helpers**

`lib/sandbox/deps.sh` (executable, `#!/usr/bin/env bash`, `set -euo pipefail`, header comment citing sandbox D2). Takes no arguments. Behaviour:

- `uname -s` is not `Darwin`: print exactly one line to stdout, `    Sandbox unsupported on <os>: bin/samwise runs here only with SAMWISE_UNSANDBOXED=1 (unfenced).` (4-space indent, `<os>` from `uname -s`), exit 0.
- `Darwin` and `type -P rg` finds a binary: print nothing, exit 0. (Use `type -P`, not `command -v`: a shell function named `rg` must not count.)
- `Darwin`, no `rg`, no `brew` binary: print to stderr `bootstrap: ripgrep (rg) is required by the sandbox; install it or Homebrew (https://brew.sh), then re-run`, exit 1.
- `Darwin`, no `rg`, `brew` present: run `brew install ripgrep`.

`lib/sandbox/drift.sh <repo>` (executable, same conventions, header comment citing sandbox D8: approvals land in `pi/sandbox.json` through the agent dir's symlink; report only). Behaviour:

- `git -C <repo> status --porcelain -- pi/sandbox.json` empty: print nothing, exit 0.
- Otherwise print `    WARNING: uncommitted sandbox policy changes (commit or revert them):`, then each status line indented 4 spaces, then `git -C <repo> --no-pager diff HEAD -- pi/sandbox.json` with every line indented 4 spaces (`diff HEAD` so staged and unstaged edits both show). Exit 0. Never stage, commit or revert anything.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash test/sandbox.test.sh`
Expected: every line `ok - ...`, ending with `ok - pi/sandbox.json uses pi-sandbox's format, so approvals make minimal diffs`.

- [ ] **Step 5: Commit**

```bash
git add lib/sandbox/deps.sh lib/sandbox/drift.sh test/sandbox.test.sh
git commit -m "Add bootstrap helpers for ripgrep and sandbox policy drift (#11)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9"
```

---

### Task 5: Wire the fence into bootstrap

**Files:**
- Modify: `bootstrap.sh`
- Modify: `test/bootstrap.test.sh`

- [ ] **Step 1: Write the failing tests**

In `test/bootstrap.test.sh`:

(a) After the block `# --- context files: contract and personal wisdom are symlinked in (T3) ---` (after the `extensions` assertion), add:

```bash

# --- execution fence (sandbox T1) ---------------------------------------------
assert_eq "$(readlink "$home/agent/sandbox.json")" "$REPO/pi/sandbox.json" \
  "sandbox.json links to the config repo's policy (D3)"
assert_contains "$(in_samwise 'pi list')" "npm:pi-sandbox@0.6.8" "pi list reports pi-sandbox"
[[ -e "$home/agent/npm/node_modules/pi-sandbox/package.json" ]] || fail "pi-sandbox not installed in the agent dir"
pass "pi-sandbox is installed in the agent dir"
assert_contains "$(cat "$tmp/first.log")" "==> Checking sandbox dependencies" "bootstrap checks sandbox dependencies"
if [[ "$(uname -s)" != Darwin ]]; then
  assert_contains "$(cat "$tmp/first.log")" "Sandbox unsupported on $(uname -s)" "non-macOS: bootstrap says the fence is unsupported"
fi
assert_contains "$(cat "$tmp/first.log")" "==> Checking sandbox policy" "bootstrap checks for policy drift"
```

Do not assert that the first log lacks a drift warning: during development the working tree may legitimately have uncommitted policy edits, and `test/sandbox.test.sh` covers drift.

(b) In the re-run section, after `assert_eq "$(readlink "$home/agent/AGENTS.md")" "$REPO/pi/AGENTS.md" "re-run keeps the AGENTS.md link"`, add:

```bash
assert_eq "$(readlink "$home/agent/sandbox.json")" "$REPO/pi/sandbox.json" "re-run keeps the sandbox.json link"
```

(c) In the end-to-end session, the launcher now needs the opt-in on Linux. Change:

```bash
(cd "$tmp" && as_clean PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=0 \
```

to:

```bash
(cd "$tmp" && as_clean SAMWISE_UNSANDBOXED=1 PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=0 \
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash test/bootstrap.test.sh` (slow, ~2 min, needs network; run in the background and do not edit files meanwhile)
Expected: FAIL, `sandbox.json links to the config repo's policy (D3): expected '.../pi/sandbox.json', got ''`.

- [ ] **Step 3: Wire bootstrap**

Behaviour to add to `bootstrap.sh`:

- Header comment: mention that bootstrap now also installs pi-sandbox (pinned in `pi/settings.json`) and the sandbox policy link.
- In the "Linking Samwise context files" step, after the `extensions` link: link `$PI_CODING_AGENT_DIR/sandbox.json` to `$repo/pi/sandbox.json` with the existing `link()` helper, with a one-line comment that pi-sandbox writes "Allow for all projects" approvals through this link, so they show up as diffs in the repo (sandbox D3, D8).
- New step `step "Checking sandbox dependencies"` right after the "Installing Pi packages" step: runs `"$repo/lib/sandbox/deps.sh"` (a failure stops bootstrap, as `set -e` already does).
- New step `step "Checking sandbox policy"` immediately before `step "Done"`: runs `"$repo/lib/sandbox/drift.sh" "$repo"`.
- In the final summary heredoc, add a line after `Memory dir:`, aligned like the others: `  Sandbox:      $repo/pi/sandbox.json`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash test/bootstrap.test.sh` (background; no edits meanwhile)
Expected: all `ok - ...`, including `sandbox.json links to the config repo's policy (D3)`, `pi-sandbox is installed in the agent dir`, `re-run keeps the sandbox.json link`, `re-run skips pi install`, and the end-to-end `Samwise session runs against the stub LLM`.

- [ ] **Step 5: Commit**

```bash
git add bootstrap.sh test/bootstrap.test.sh
git commit -m "Bootstrap: install the execution fence and report policy drift (#11)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9"
```

---

### Task 6: Document the fence and run everything

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

Edit `README.md` (keep its tone: short, factual, no marketing):

- `## Requirements`: add a bullet saying the sandbox needs macOS (Seatbelt), that bootstrap installs ripgrep with Homebrew if it is missing, and that elsewhere Samwise runs only unfenced, on request.
- `## Install` table, `agent/` row: also say `sandbox.json` links to `pi/sandbox.json`.
- New `## Sandbox` section after `## Run`, covering:
  - The fence is pi-sandbox (link `https://github.com/carderne/pi-sandbox`), pinned in `pi/settings.json`; it wraps bash in macOS Seatbelt and checks Pi's read, write and edit tools against `pi/sandbox.json`.
  - Policy lives in this repo: `~/.pi/samwise/agent/sandbox.json` links to `pi/sandbox.json`, so "Allow for all projects" at a prompt edits this repo; bootstrap reports uncommitted policy changes (commit or revert them). A project-local `.pi/sandbox.json` is not allowed: `bin/samwise` refuses to start and says to move its entries here.
  - It never runs silently off: pi-sandbox fails open, so `bin/samwise` refuses `--no-sandbox` and on macOS runs `lib/sandbox/preflight.mjs` (policy link, policy file, pinned version, the runtime's dependency check) first.
  - macOS only: elsewhere `bin/samwise` refuses unless `SAMWISE_UNSANDBOXED=1`, then warns and runs Pi with the sandbox off; the eval runner sets it; on macOS the variable is refused.

- [ ] **Step 2: Run the full suite**

Run: `test/run.sh` (background; several minutes; no edits meanwhile)
Expected: every test file passes and the last line is `all tests passed`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: document the execution fence (#11)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9"
```

---

## Manual check for George (on the Mac, after merge)

AC1's last clause cannot run on Linux:

1. `./bootstrap.sh` on the Mac.
2. `bin/samwise`, then `/sandbox`: it should show the policy from `pi/sandbox.json` (currently pi-sandbox's defaults with `enabled: true`) and the lock indicator in the footer.
3. `bin/samwise --no-sandbox` exits with `--no-sandbox is not allowed`.
