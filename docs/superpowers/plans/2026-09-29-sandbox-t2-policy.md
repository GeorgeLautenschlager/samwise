# Sandbox T2: Sandbox Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use steward:steward-local-sdd (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace T1's placeholder `pi/sandbox.json` with the real policy (home denied, listed reads, narrow writes, hard write-denies, exact-host network allowlist), enforce its invariants with model-free tests, and move `/reflect` apply to George so Samwise never writes the config repo or memory dir from bash.

**Architecture:** A lexical/canonical path matcher mirroring pi-sandbox 0.6.8 (`lib/sandbox/match.mjs`) is shared by a policy invariant test and a new macOS preflight check. The policy file carries a `_why` map beside its arrays. `/reflect` apply becomes a command George runs with `!`; the eval runner stands in for him.

**Tech Stack:** bash, Node ≥ 22.19 (ESM, `node:test`), pi-sandbox 0.6.8.

**Spec:** `docs/superpowers/specs/2026-09-29-sandbox-t2-policy-design.md` — read its "Findings" section before Task 1; it explains the precedence rules the tests encode.

**Conventions in this repo:**
- Bash tests are `test/*.test.sh`, sourcing `test/lib.sh` (`fail`, `pass`, `assert_eq`, `assert_contains`, `assert_not_contains`). `test/run.sh` runs them all.
- Node unit tests are `node:test` files under `<module>/test/*.test.mjs`, run by `test/unit.test.sh` (it already globs `lib/sandbox/test/*.test.mjs`). JS uses tabs; bash uses 2 spaces; comments wrap at ~80 columns and say why.
- Test scripts must run under macOS's stock bash 3.2: never expand a possibly-empty array as `"${a[@]}"` under `set -u`; use `${a[@]+"${a[@]}"}`.
- Commit messages: short imperative subject ending in `(#12)`, then a blank line and:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9
  ```
- Do not run `test/bootstrap.test.sh`, `test/eval-runner.test.sh` or `test/run.sh` unless a step says so (they are slow and start `pi`).

## File structure

| File | Status | Responsibility |
|---|---|---|
| `lib/sandbox/match.mjs` | create | Path matching as pi-sandbox 0.6.8 does it |
| `lib/sandbox/test/match.test.mjs` | create | Matcher cases |
| `pi/sandbox.json` | modify | The real policy, with `_why` |
| `lib/sandbox/test/policy.test.mjs` | create | Policy invariants |
| `lib/sandbox/checks.mjs` | modify | New `checkPolicyCoverage` |
| `lib/sandbox/preflight.mjs` | modify | Run the new check |
| `lib/sandbox/test/checks.test.mjs` | modify | Coverage check cases |
| `test/launcher.test.sh` | modify | Happy path launches a repo copy under the temp dir |
| `lib/reflect/cli.mjs` | modify | `apply` prints the items it commits |
| `pi/prompts/reflect.md` | modify | George runs apply/discard |
| `pi/AGENTS.md` | modify | Contract line on /reflect |
| `test/reflect.test.sh` | modify | Apply output assertion |
| `eval/lib/sandbox.mjs`, `eval/run.mjs` | modify | Runner applies a pending proposal for reflect scenarios |
| `test/fixtures/runner-script.json`, `test/fixtures/golden/scope-leak/runner-reflect.md` | modify | Stub asks George to apply |
| `test/eval-runner.test.sh` | modify | Assertions for the new flow |
| `README.md` | modify | Policy summary, Q5 process, George applies and pushes |

---

### Task 1: Path matcher mirroring pi-sandbox

**Files:**
- Create: `lib/sandbox/match.mjs`
- Create: `lib/sandbox/test/match.test.mjs`

**Interface:** ES module, Node built-ins only, tab-indented, header comment saying it mirrors pi-sandbox 0.6.8's `src/policy.ts` (`expandPath`, `canonicalizePath`, `matchesPattern`) so policy tests and the preflight judge paths the way the fence does.

- `expandPath(pattern, { home, cwd })` → string. A leading `~` (alone or followed by `/`) becomes `home`; the result is resolved against `cwd` (so `.` is `cwd`, `.pi` is `<cwd>/.pi`).
- `matchesPattern(path, patterns, { home, cwd, canonical = false })` → boolean. `path` is expanded the same way. For each pattern:
  - containing `*`: expand it (no canonicalisation), escape regex metacharacters except `*`, turn each `*` into `.*` (which crosses `/`), anchor with `^…$`, and test the path;
  - otherwise: expand it and match if the path equals it or starts with it followed by `/` (if the pattern already ends in `/`, starts with it).
  - With `canonical: true`, the path and non-glob patterns are canonicalised first, as pi-sandbox does: `realpath` of the path if it exists; otherwise `realpath` of its longest existing ancestor with the remaining segments appended; if nothing resolves, the expanded path as is.

- [ ] **Step 1: Write the failing tests**

Create `lib/sandbox/test/match.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expandPath, matchesPattern } from "../match.mjs";

const opts = { home: "/home/g", cwd: "/home/g/dev/app" };
const m = (path, patterns) => matchesPattern(path, patterns, opts);

test("expandPath: tilde, relative and absolute forms", () => {
	assert.equal(expandPath("~", opts), "/home/g");
	assert.equal(expandPath("~/.ssh", opts), "/home/g/.ssh");
	assert.equal(expandPath("~foo", opts), "/home/g/dev/app/~foo");
	assert.equal(expandPath(".", opts), "/home/g/dev/app");
	assert.equal(expandPath(".pi/sandbox.json", opts), "/home/g/dev/app/.pi/sandbox.json");
	assert.equal(expandPath("/tmp", opts), "/tmp");
});

test("plain patterns match the path itself and anything under it, not siblings", () => {
	assert.ok(m("~/.ssh", ["~/.ssh"]));
	assert.ok(m("/home/g/.ssh/id_ed25519", ["~/.ssh"]));
	assert.ok(!m("/home/g/.sshx", ["~/.ssh"]));
	assert.ok(m("/home/g/dev/app/src/x.js", ["."]));
	assert.ok(!m("/home/g/dev/other", ["."]));
	assert.ok(m("/tmp/a", ["/tmp/"]));
	assert.ok(m("~", ["~"]));
	assert.ok(!m("/home/gx", ["~"]));
});

test("glob patterns: * crosses directories and the match is anchored", () => {
	assert.ok(m("/home/g/dev/app/vendor/x/.git/hooks/post-checkout", ["*/.git/hooks/*"]));
	assert.ok(!m("/home/g/dev/app/.git/hooks", ["*/.git/hooks/*"]));
	assert.ok(m("/home/g/dev/app/certs/server.pem", ["*.pem"]));
	assert.ok(!m("/home/g/dev/app/server.pem.txt", ["*.pem"]));
	assert.ok(m("/home/g/dev/app/.env.local", [".env.*"]));
});

test("canonical: symlinked paths and patterns are compared by real path", () => {
	const root = mkdtempSync(join(tmpdir(), "samwise-match-"));
	try {
		mkdirSync(join(root, "real", "dev"), { recursive: true });
		symlinkSync(join(root, "real"), join(root, "link"));
		const c = { home: join(root, "link"), cwd: root, canonical: true };
		assert.ok(matchesPattern(join(root, "real", "dev", "new-file"), ["~/dev"], c));
		assert.ok(matchesPattern(join(root, "link", "dev", "a", "b"), [join(root, "real", "dev")], c));
		assert.ok(!matchesPattern(join(root, "real", "other"), ["~/dev"], c));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/sandbox/test/match.test.mjs`
Expected: FAIL, `Cannot find module '.../lib/sandbox/match.mjs'`.

- [ ] **Step 3: Implement `lib/sandbox/match.mjs`** to the interface above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/sandbox/test/match.test.mjs && bash test/unit.test.sh`
Expected: `# pass 4`, `# fail 0`; `unit.test.sh` lists `ok - lib/sandbox/test/match.test.mjs (pass 4)`.

- [ ] **Step 5: Commit**

```bash
git add lib/sandbox/match.mjs lib/sandbox/test/match.test.mjs
git commit -m "Add a path matcher mirroring pi-sandbox's (#12)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9"
```

---

### Task 2: The policy and its invariant test

**Files:**
- Modify: `pi/sandbox.json`
- Create: `lib/sandbox/test/policy.test.mjs`

**Policy content.** `pi/sandbox.json` becomes a JSON object with exactly these top-level keys: `enabled`, `sandboxUserShell`, `network`, `filesystem`, `_why`. Formatting must stay pi-sandbox's own: `JSON.stringify(policy, null, 2) + "\n"` (`test/sandbox.test.sh` checks this, so build the file with that call rather than by hand).

- `enabled: true`, `sandboxUserShell: false`.
- `network.allowedDomains` (in this order): `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`, `rubygems.org`, `index.rubygems.org`, `github.com`, `api.github.com`, `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`. `network.deniedDomains: []`.
- `filesystem.denyRead`: `["~"]`.
- `filesystem.allowRead` (in this order): `~/dev`, `~/.pi/samwise/memory`, `~/.nvm`, `~/.npm-global`, `~/.volta`, `~/.asdf`, `~/.rbenv`, `~/.pyenv`, `~/.cargo`, `~/.rustup`, `~/.local/bin`, `~/.gitconfig`, `~/.config/git/config`, `/usr`, `/opt`, `/etc`, `/private/etc`, `/Library`, `/Applications`, `/System`, `/bin`, `/sbin`.
- `filesystem.allowWrite`: `.`, `/tmp`, `/private/tmp`, `/private/var/folders`, `~/.pi/samwise/reflect`, `~/.npm`.
- `filesystem.denyWrite`: `.pi`, `.git/hooks`, `.git/config`, `*/.git/hooks/*`, `*/.git/config`, `~/.pi/agent`, `~/.pi/samwise/agent`, `~/.cache/qmd`, `.env`, `.env.*`, `*.pem`, `*.key`.
- `_why`: an object with one key per distinct entry string above (from all five arrays) and a one-line reason as the value. Reasons (use these meanings; wording may be tightened, keep each under ~100 characters):
  - `~` (denyRead): home is denied by default, so unlisted secrets stay unreadable from bash.
  - `~/dev`: George's code, including this config repo (samwise-reflect runs from it).
  - `~/.pi/samwise/memory`: memory for samwise-reflect context; read-only, wisdom changes only via George's apply.
  - each toolchain dir: that toolchain's binaries and libraries (name the tool: nvm, npm global packages incl. Pi's docs, Volta, asdf, rbenv, pyenv, cargo, rustup, user-local binaries).
  - `~/.gitconfig`, `~/.config/git/config`: commit identity; credentials files stay denied.
  - the system dirs: already readable by bash; listed so Pi's read tool doesn't prompt for system files.
  - `.`: the project Samwise is working in.
  - `/tmp`, `/private/tmp`, `/private/var/folders`: temp dirs (the last holds macOS $TMPDIR).
  - `~/.pi/samwise/reflect`: /reflect proposals (pending.json).
  - `~/.npm`: npm's cache.
  - `.pi`: project Pi config: sandbox.json can disable the fence, extensions/ is code Pi loads.
  - `.git/hooks`, `.git/config`, `*/.git/hooks/*`, `*/.git/config`: hooks and git config run code outside the fence (the `*/` forms cover nested repos).
  - `~/.pi/agent`, `~/.pi/samwise/agent`: Pi agent dirs: settings, auth, extensions, the policy link.
  - `~/.cache/qmd`: qmd models, loaded by the unfenced host process.
  - `.env`, `.env.*`, `*.pem`, `*.key`: pi-sandbox's defaults, kept because an explicit denyWrite replaces them.
  - each domain: what it serves (npm registry; Yarn registry; PyPI index; PyPI files; RubyGems; RubyGems index; GitHub web and git over HTTPS; GitHub API; GitHub archive downloads; raw GitHub content; GitHub release downloads).

- [ ] **Step 1: Write the failing test**

Create `lib/sandbox/test/policy.test.mjs`:

```js
// Invariants of pi/sandbox.json, judged with pi-sandbox's own path rules
// (lib/sandbox/match.mjs). For bash, allowRead beats denyRead and every
// allowWrite path is also readable, so a secret is safe only if no allow
// entry covers it or sits inside it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { matchesPattern } from "../match.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const policy = JSON.parse(readFileSync(join(repo, "pi", "sandbox.json"), "utf8"));
const { filesystem: fs, network } = policy;
const opts = { home: "/home/george", cwd: "/home/george/dev/project" };
const covered = (patterns, path) => matchesPattern(path, patterns, opts);
const allows = [...fs.allowRead, ...fs.allowWrite];

const SECRETS = [
	"~/.ssh",
	"~/.aws",
	"~/.config/gh",
	"~/.gnupg",
	"~/.netrc",
	"~/.npmrc",
	"~/.docker",
	"~/.kube",
	"~/.git-credentials",
	"~/.config/git/credentials",
	"~/.password-store",
	"~/.config/op",
	"~/Library/Keychains",
	"~/Library/Application Support/Google/Chrome",
	"~/Library/Application Support/Firefox",
	"~/Library/Group Containers",
	"~/.config/google-chrome",
	"~/.mozilla",
	"~/.pi/agent/auth.json",
	"~/.pi/samwise/agent/auth.json",
];

test("settings: the fence is on and George's own ! commands run unfenced", () => {
	assert.equal(policy.enabled, true);
	assert.equal(policy.sandboxUserShell, false);
});

test("reads: home is denied and allow entries are plain paths", () => {
	assert.deepEqual(fs.denyRead, ["~"]);
	for (const entry of allows) assert.ok(!entry.includes("*"), `${entry}: allow entries must not be globs`);
});

test("reads: every secret is denied and no allow entry covers it or sits inside it", () => {
	for (const secret of SECRETS) {
		assert.ok(covered(fs.denyRead, secret), `${secret} is not under denyRead`);
		for (const entry of allows) {
			assert.ok(!covered([entry], secret), `${entry} exposes ${secret}`);
			assert.ok(!covered([secret], entry), `${entry} sits inside ${secret}`);
		}
	}
});

test("reads: what Samwise needs is readable", () => {
	for (const path of [
		"/home/george/dev/project/src/index.js",
		"/home/george/dev/samwise/bin/samwise-reflect",
		"/home/george/.pi/samwise/memory/daily/2026-09-29.md",
		"/home/george/.gitconfig",
		"/usr/bin/git",
	]) {
		assert.ok(covered(allows, path), `${path} is not readable`);
	}
});

test("writes: only the project, temp dirs, reflect proposals and the npm cache", () => {
	for (const path of [
		"/home/george/dev/project/src/new.js",
		"/tmp/x",
		"/private/var/folders/ab/cd/T/x",
		"/home/george/.pi/samwise/reflect/pending.json",
		"/home/george/.npm/_cacache/x",
	]) {
		assert.ok(covered(fs.allowWrite, path), `${path} should be writable`);
	}
	for (const path of [
		"/home/george",
		"/home/george/foo",
		"/home/george/.bashrc",
		"/home/george/.zshrc",
		"/home/george/.ssh/authorized_keys",
		"/home/george/.pi/agent/settings.json",
		"/home/george/.pi/samwise/agent/settings.json",
		"/home/george/.pi/samwise/memory/MEMORY.md",
		"/home/george/dev/samwise/pi/sandbox.json",
	]) {
		assert.ok(!covered(fs.allowWrite, path), `${path} must not be writable`);
	}
});

test("writes: fence-bypass paths are hard-denied", () => {
	for (const path of [
		"/home/george/dev/project/.pi/sandbox.json",
		"/home/george/dev/project/.pi/extensions/x.ts",
		"/home/george/dev/project/.git/hooks/pre-commit",
		"/home/george/dev/project/.git/config",
		"/home/george/dev/project/vendor/x/.git/hooks/post-checkout",
		"/home/george/dev/project/vendor/x/.git/config",
		"/home/george/.pi/samwise/agent/sandbox.json",
		"/home/george/.pi/agent/extensions/x.ts",
		"/home/george/.cache/qmd/models/x.gguf",
		"/home/george/dev/project/.env",
	]) {
		assert.ok(covered(fs.denyWrite, path), `${path} is not in denyWrite`);
	}
	assert.ok(!covered(fs.denyWrite, "/home/george/dev/project/src/app.js"), "ordinary project files stay writable");
});

test("network: exact hosts only, the D6 set, no model providers", () => {
	const hosts = network.allowedDomains;
	for (const host of hosts) assert.ok(!host.includes("*"), `${host}: no wildcards`);
	for (const host of [
		"registry.npmjs.org",
		"pypi.org",
		"files.pythonhosted.org",
		"rubygems.org",
		"github.com",
		"api.github.com",
		"raw.githubusercontent.com",
	]) {
		assert.ok(hosts.includes(host), `${host} missing`);
	}
	for (const host of ["chatgpt.com", "api.openai.com", "api.anthropic.com"]) {
		assert.ok(!hosts.includes(host), `${host}: model calls come from the host process, not bash`);
	}
	assert.deepEqual(network.deniedDomains, []);
});

test("every entry has a reason in _why", () => {
	const entries = [...fs.denyRead, ...fs.allowRead, ...fs.allowWrite, ...fs.denyWrite, ...network.allowedDomains];
	for (const entry of entries) {
		assert.equal(typeof policy._why?.[entry], "string", `${entry} has no _why`);
		assert.ok(policy._why[entry].trim().length > 0, `${entry} has an empty _why`);
	}
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/sandbox/test/policy.test.mjs`
Expected: FAIL (the placeholder policy has no `filesystem`: `TypeError: Cannot read properties of undefined`).

- [ ] **Step 3: Write the policy** to the content above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/sandbox/test/policy.test.mjs && bash test/sandbox.test.sh && bash test/unit.test.sh`
Expected: policy test `# pass 8`, `# fail 0`; `sandbox.test.sh` all `ok` (including the pi-sandbox format check).

- [ ] **Step 5: Commit**

```bash
git add pi/sandbox.json lib/sandbox/test/policy.test.mjs
git commit -m "Sandbox policy: deny home, listed reads, narrow writes, exact hosts (#12)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9"
```

---

### Task 3: Preflight checks the repo and memory are reachable under the policy

**Files:**
- Modify: `lib/sandbox/checks.mjs` (add an export)
- Modify: `lib/sandbox/preflight.mjs`
- Modify: `lib/sandbox/test/checks.test.mjs` (append)
- Modify: `test/launcher.test.sh`

**Behaviour.** New export in `checks.mjs`:

`checkPolicyCoverage(repo, cwd, env = process.env)` → array of problem strings. Reads `<repo>/pi/sandbox.json` (if it is missing or unparseable, return `[]`: `checkPolicy` already reports that). Uses `matchesPattern` from `./match.mjs` with `{ home: env.HOME ?? os.homedir(), cwd, canonical: true }`. Readable means covered by `filesystem.allowRead` or `filesystem.allowWrite` (missing arrays count as empty); writable means covered by `filesystem.allowWrite`.
- `env.PI_MEMORY_DIR` or `env.SAMWISE_HOME` unset → `<NAME> is not set (run through bin/samwise)` for each.
- `<repo>` not readable → `<repo> is not readable under <repo>/pi/sandbox.json (samwise-reflect runs from it); add it to allowRead`.
- `<PI_MEMORY_DIR>` not readable → `<dir> is not readable under <repo>/pi/sandbox.json (samwise-reflect reads memory); add it to allowRead`.
- `<SAMWISE_HOME>/reflect` not writable → `<dir> is not writable under <repo>/pi/sandbox.json (/reflect stores proposals there); add it to allowWrite`.

Keep a short comment on why (inside the fence `samwise-reflect` would otherwise fail at run time, not at launch). `preflight.mjs` adds `...checkPolicyCoverage(repo, cwd)` to its list of checks.

**Launcher test.** Its "passing preflight" case launches the real repo, which is covered by the policy only if the checkout lives under `~/dev`; make it location-independent by launching a copy of the repo placed in the test's temp dir (covered by `/tmp` / `/private/var/folders`), with `SAMWISE_HOME` also under the temp dir.

- [ ] **Step 1: Write the failing tests**

Append to `lib/sandbox/test/checks.test.mjs` (it already imports `mkdirSync`, `writeFileSync`, `join` and defines `fixture(t, …)`; add `checkPolicyCoverage` to the import list from `../checks.mjs`):

```js
test("policy coverage: repo and memory readable, reflect dir writable passes", (t) => {
	const { root, repo } = fixture(t);
	const home = join(root, "home");
	mkdirSync(home);
	writeFileSync(
		join(repo, "pi", "sandbox.json"),
		JSON.stringify({ filesystem: { allowRead: [repo, "~/.pi/samwise/memory"], allowWrite: ["~/.pi/samwise/reflect"] } }),
	);
	const env = { HOME: home, PI_MEMORY_DIR: join(home, ".pi/samwise/memory"), SAMWISE_HOME: join(home, ".pi/samwise") };
	assert.deepEqual(checkPolicyCoverage(repo, root, env), []);
});

test("policy coverage: each gap is named, with where to add it", (t) => {
	const { root, repo } = fixture(t);
	writeFileSync(join(repo, "pi", "sandbox.json"), JSON.stringify({ filesystem: { denyRead: ["~"] } }));
	const env = { HOME: root, PI_MEMORY_DIR: join(root, "mem"), SAMWISE_HOME: join(root, "sw") };
	const problems = checkPolicyCoverage(repo, join(root, "elsewhere"), env);
	assert.equal(problems.length, 3, problems.join("\n"));
	assert.match(problems[0], /repo is not readable .*add it to allowRead/);
	assert.match(problems[1], /mem is not readable .*add it to allowRead/);
	assert.match(problems[2], /sw\/reflect is not writable .*add it to allowWrite/);
});

test("policy coverage: unset environment is reported; a broken policy is left to checkPolicy", (t) => {
	const { repo, root } = fixture(t);
	assert.deepEqual(
		checkPolicyCoverage(repo, root, { HOME: root }).filter((p) => /is not set/.test(p)).length,
		2,
	);
	writeFileSync(join(repo, "pi", "sandbox.json"), "{ not json");
	assert.deepEqual(checkPolicyCoverage(repo, root, { HOME: root, PI_MEMORY_DIR: "/m", SAMWISE_HOME: "/s" }), []);
});
```

In `test/launcher.test.sh`, the macOS section currently builds a passing home under `$tmp/mac` and launches `$REPO/bin/samwise` through `launch_darwin`. Change it so:

1. `launch_darwin` launches `"$launcher"` instead of `"$REPO/bin/samwise"`, where `launcher="$REPO/bin/samwise"` is set just before `launch_darwin` is defined.
2. Just before the `pin=...` line that starts the passing-home setup, add:

```bash
# The policy only lets bash read the config repo where it normally lives
# (~/dev), so launch a copy under the temp dir, which it can always read.
copy="$tmp/repo"
mkdir -p "$copy"
cp -R "$REPO/bin" "$REPO/lib" "$REPO/pi" "$copy/"
launcher="$copy/bin/samwise"
```

3. In that setup, link the policy from the copy: `ln -s "$copy/pi/sandbox.json" "$tmp/mac/agent/sandbox.json"` (instead of `$REPO/pi/sandbox.json`), and read the pin from `"$copy/pi/settings.json"`.

`SAMWISE_HOME` there is already `$tmp/mac` (under the temp dir), so the memory and reflect dirs are covered by the policy's temp-dir entries. No assertion changes.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/sandbox/test/checks.test.mjs`
Expected: FAIL, `checkPolicyCoverage` is not exported (`SyntaxError: The requested module '../checks.mjs' does not provide an export named 'checkPolicyCoverage'`).

- [ ] **Step 3: Implement** `checkPolicyCoverage`, wire it into `preflight.mjs`, and make the launcher test changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/sandbox/test/checks.test.mjs && bash test/launcher.test.sh && bash test/unit.test.sh`
Expected: checks `# pass 12`, `# fail 0`; launcher all `ok` (18 checks).

Also check the launcher test on a simulated macOS host, which exercises the new check through the real policy:

```bash
d=$(mktemp -d); printf '#!/usr/bin/env bash\necho Darwin\n' >$d/uname; chmod +x $d/uname
PATH=$d:$PATH bash test/launcher.test.sh; rm -rf $d
```

Expected: all `ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/sandbox/checks.mjs lib/sandbox/preflight.mjs lib/sandbox/test/checks.test.mjs test/launcher.test.sh
git commit -m "Preflight: config repo and memory reachable under the policy (#12)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9"
```

---

### Task 4: George applies /reflect

**Files:**
- Modify: `lib/reflect/cli.mjs` (`apply`)
- Modify: `pi/prompts/reflect.md` (step 5 and the closing rule)
- Modify: `pi/AGENTS.md` (the `/reflect` line)
- Modify: `test/reflect.test.sh`

**Behaviour.**
- `samwise-reflect apply`: after the approvals are resolved and before writing, print one line per approved item, `Applying [<n>] <op> <scope>: <title or target>` (title for `add`, the target id otherwise), then keep the existing `Applied items …; committed in ….` line. A proposal changed after George approved it (Samwise can write `pending.json`) is then visible in what he sees.
- `pi/prompts/reflect.md` step 5: Samwise does not run `apply` or `discard`. After showing the diff it asks George to approve by running one of these himself in Pi (the leading `!` runs his command outside the sandbox): `!samwise-reflect apply`, `!samwise-reflect apply --skip 2,3` / `--only 1`, or `!samwise-reflect discard`. Replace the closing "Never run `apply` unless…" rule with: Samwise never runs `apply` or `discard` (the sandbox blocks it: the wisdom files are outside what Samwise may write), and never changes the wisdom files any other way.
- `pi/AGENTS.md`: the sentence "Propose lessons at `/reflect`; only apply changes George approved there." becomes "Propose lessons at `/reflect`; George applies the ones he approves." Keep the file within `test/contract.test.sh`'s budget.

- [ ] **Step 1: Write the failing test**

In `test/reflect.test.sh`, the partial-apply section currently reads:

```bash
reflect propose <<<"$PROPOSAL" >/dev/null
assert_contains "$(reflect apply --skip 3)" "Applied items 1,2" "apply: partial approval"
```

Change it to:

```bash
reflect propose <<<"$PROPOSAL" >/dev/null
applied="$(reflect apply --skip 3)"
assert_contains "$applied" "Applied items 1,2" "apply: partial approval"
assert_contains "$applied" "Applying [1] add personal: Breakers" "apply: shows each item it commits"
assert_contains "$applied" "Applying [2] add thanx: Incident order" "apply: shows rerouted items with their scope"
assert_not_contains "$applied" "Deploys" "apply: skipped items are not shown"
```

And append at the end of the file:

```bash
# --- the /reflect prompt leaves apply to George -------------------------------------
prompt="$(cat "$REPO/pi/prompts/reflect.md")"
assert_contains "$prompt" '!samwise-reflect apply' "prompt: George applies with a ! command"
assert_contains "$prompt" '!samwise-reflect discard' "prompt: George discards with a ! command"
assert_contains "$prompt" "never runs \`apply\`" "prompt: Samwise never applies"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash test/reflect.test.sh`
Expected: FAIL, `apply: shows each item it commits: 'Applying [1] add personal: Breakers' not found in: ...`.

- [ ] **Step 3: Implement** the `apply` output, the prompt change and the contract line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash test/reflect.test.sh && bash test/contract.test.sh`
Expected: all `ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/reflect/cli.mjs pi/prompts/reflect.md pi/AGENTS.md test/reflect.test.sh
git commit -m "/reflect: George applies approved proposals himself (#12)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9"
```

---

### Task 5: The eval runner applies for George

**Files:**
- Modify: `eval/lib/sandbox.mjs` (new export)
- Modify: `eval/run.mjs`
- Modify: `test/fixtures/runner-script.json`
- Modify: `test/fixtures/golden/scope-leak/runner-reflect.md`
- Modify: `test/eval-runner.test.sh`

**Behaviour.**
- New export in `eval/lib/sandbox.mjs`: `applyPendingReflect(repo, run)` → the command's stdout, or `null` when nothing is pending. If `<run.home>/reflect/pending.json` exists, run `"<repo>/bin/samwise-reflect" apply` with Samwise's environment for `run.home` (the same way `inSamwise` does: source `lib/env.sh`, `samwiseEnv(run.home)`); a failing apply throws (the run is then reported as failed with its message, as other errors are).
- `eval/run.mjs`: after the Pi session and its transcript files are written, and before `personalFiles(run)` is read for scoring, if the scenario's `requires` includes `"reflect"`, call `applyPendingReflect(repo, run)` and, when it returned output, write it to `${prefix}.reflect-apply.log`. Comment: George approves by running `!samwise-reflect apply`; the runner stands in for him so `personal_scope_clean` checks what an approval writes.
- `test/fixtures/runner-script.json`: in the step whose `when` is `"Approve everything"`, remove the `bash` tool call to `samwise-reflect apply`; its only step is the text `Run !samwise-reflect apply to apply it.`
- `test/fixtures/golden/scope-leak/runner-reflect.md`: description becomes "The stub runs /reflect with one leaky personal item and asks George to apply; the runner applies." In `expect`, replace the `tool_called` block with:

```yaml
  response_includes:
    - "!samwise-reflect apply"
  tool_not_called:
    - name: bash
      args_include: { command: "samwise-reflect apply" }
```

(keep `personal_scope_clean: true`).

- [ ] **Step 1: Write the failing test**

In `test/eval-runner.test.sh`, the `/reflect through a Samwise session` section asserts the scenario passes and that the lessons landed. Change the pass assertion's description and add two assertions after `run_dir="$kept/runs/runner-reflect-1"`:

```bash
assert_eq "$(jq_node "$tmp/reflect" 'r.scenarios.map((s) => `${s.id}:${s.passed}/${s.runs}`).join(" ")')" \
  '"runner-reflect:1/1"' "/reflect scenario passes (Samwise asks George to apply; personal scope clean)"
```

```bash
assert_contains "$(cat "$(ls -d "$tmp/reflect"/*/)"/runner-reflect-1.reflect-apply.log)" "Applied items 1,2" \
  "the runner applied the pending proposal, as George would"
[[ ! -e "$run_dir/home/reflect/pending.json" ]] || fail "the proposal is still pending after the run"
pass "no proposal left pending"
```

The existing assertions (`leaky lesson landed in the thanx scope`, `general lesson landed in the personal copy`, the `Reflect-Run:` commit) stay: they now prove the runner's apply.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash test/eval-runner.test.sh` (slow, several minutes, starts `pi` against a local stub; run it in the background and do not edit files meanwhile — the runner's isolation guard fails the run if repo files change)
Expected: FAIL at the `runner-reflect:1/1` assertion (the fixture now expects `tool_not_called` for the apply the old script still makes) or at the missing `reflect-apply.log`.

- [ ] **Step 3: Implement** the runner change and the fixture edits.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash test/eval-runner.test.sh` (background; no edits meanwhile)
Expected: all `ok`.

- [ ] **Step 5: Commit**

```bash
git add eval/lib/sandbox.mjs eval/run.mjs test/fixtures/runner-script.json test/fixtures/golden/scope-leak/runner-reflect.md test/eval-runner.test.sh
git commit -m "Eval: the runner applies pending /reflect proposals for George (#12)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9"
```

---

### Task 6: README and the full suite

**Files:**
- Modify: `README.md`

**Content** (keep the README's tone: short, factual; wrap at ~80 columns; straight quotes):

- `## Sandbox`: add a short "Policy" paragraph or list after the existing paragraphs: home is unreadable from bash except listed places (`~/dev`, the memory dir read-only, toolchains, git identity); bash may write the project dir, temp dirs, `/reflect` proposals and the npm cache; project `.pi/`, git hooks and config, Pi's agent dirs and qmd's models are hard-denied; bash reaches only package registries and GitHub (model calls come from Pi itself, not bash). Every entry's reason is in the file's `_why` map; a new entry needs one before the tests pass.
- Add "Adding a host (Q5)": on the first legitimate prompt for a Thanx host, choose "Allow for all projects"; it lands in `pi/sandbox.json`; add its `_why`, review the diff, commit. Thanx hosts start empty.
- Add: Samwise commits on branches but cannot read git credentials, so you push (`!git push`). Your own `!` commands run outside the sandbox.
- `## /reflect`: step 3 becomes: George approves by running `!samwise-reflect apply` (or `--skip`/`--only`, or `!samwise-reflect discard`) himself; `apply` prints each item it commits. Keep the rest of the section's facts; drop "Samwise runs" for apply/discard.

- [ ] **Step 1: Update the README** as above.

- [ ] **Step 2: Run the full suite**

Run: `test/run.sh` (background; several minutes; no edits meanwhile)
Expected: last line `all tests passed`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: sandbox policy, adding hosts, George applies and pushes (#12)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sgetz7MVLyfhYa5XRBWjK9"
```

---

## Manual check for George (on the Mac, after merge)

Via `bin/samwise` in a project under `~/dev`:

1. Ask Samwise to write `~/foo`, to `cat ~/.ssh/id_*`, and to `curl https://example.com`: each is blocked or prompted (answer Abort).
2. Ask it to create a file in the project, run `npm view zod version`, and `git ls-remote https://github.com/carderne/pi-sandbox`: each works without a prompt.
3. `/sandbox` shows this policy.
4. Run `/reflect` on a day with logs; approve with `!samwise-reflect apply`.
