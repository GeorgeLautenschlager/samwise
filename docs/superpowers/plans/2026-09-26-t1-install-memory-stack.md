# T1: Install Memory Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use steward:steward-local-sdd (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An idempotent `bootstrap.sh` that installs pinned pi-memory and qmd into a Samwise-owned Pi agent dir and initialises the qmd collection, plus a `bin/samwise` launcher that runs Pi with the matching environment.

**Architecture:** `lib/env.sh` is the single source of Samwise's environment (paths under `SAMWISE_HOME`, pi-memory and qmd variables); both the launcher and bootstrap source it. Two small Node helpers handle JSON: `lib/merge-settings.mjs` merges the repo's declarative `pi/settings.json` into the agent dir, and `lib/missing-packages.mjs` lists packages not yet installed at their pinned version. `bootstrap.sh` checks state before every step so re-runs are no-ops.

**Tech Stack:** Bash, Node ≥ 22.19 (ES modules, no dependencies), Pi CLI (`pi install`, `pi list`), `@tobilu/qmd@2.8.3` CLI, `pi-memory@0.4.2`. Tests are plain bash scripts with a tiny assertion helper (no bats/shellcheck on this machine).

**Spec:** `docs/superpowers/specs/2026-09-26-t1-install-memory-stack-design.md`

## Verified facts (checked 2026-09-26 in a sandbox; do not re-derive)

- `PI_CODING_AGENT_DIR=<dir> pi install npm:pi-memory@0.4.2` installs into `<dir>/npm/node_modules/pi-memory` and adds the source to `<dir>/settings.json`. Re-running it leaves `settings.json` byte-identical. `pi update --extensions` does **not** install a missing pinned package.
- `pi list` prints `  npm:pi-memory@0.4.2` under `User packages:`.
- Pi writes `settings.json` with 2-space indent and **no trailing newline**.
- `qmd --version` prints `qmd 2.8.3 (facd35e)`.
- `qmd collection list` prints plain text; the collection line starts with `pi-memory (qmd://pi-memory/)`. `--json` is ignored. With no collections it prints `No collections found...` and exits 0.
- `qmd collection add <dir> --name pi-memory` exits **1** if the collection already exists.
- `qmd context add qmd://pi-memory/daily "<desc>"` and `qmd context add qmd://pi-memory "<desc>"` set per-collection contexts; repeating them leaves `index.yml` byte-identical.
- qmd writes its default models into `$QMD_CONFIG_DIR/index.yml` itself: `embed: hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`, plus `generate:` and `rerank:` `hf:` URIs.
- `qmd search <term> -c pi-memory` exits 0 whether or not anything matched; a hit prints `qmd://pi-memory/<path>:<line> ...`; a miss prints `No results found.`
- `qmd update` and `qmd embed` both exit 0 on an empty collection.
- `qmd embed` downloads the embedding model into `$XDG_CACHE_HOME/qmd/models` (default `~/.cache/qmd/models`, already populated on this machine). A second run prints `All content hashes already have embeddings.`
- `npm install -g --prefix <dir> @tobilu/qmd@2.8.3` takes ~1 minute and creates `<dir>/bin/qmd`.

## File structure

| File | Responsibility |
|---|---|
| `test/lib.sh` | Assertion helpers shared by all tests |
| `lib/env.sh` | Samwise environment (sourced, never executed) |
| `bin/samwise` | Launcher: source env, exec `pi` |
| `pi/settings.json` | Declarative Pi settings for Samwise (pi-memory pin) |
| `lib/merge-settings.mjs` | Merge repo settings into agent settings; write only on change |
| `lib/missing-packages.mjs` | Print package sources not installed at their pinned version |
| `bootstrap.sh` | Idempotent installer |
| `test/env.test.sh` | Unit tests for `lib/env.sh` |
| `test/launcher.test.sh` | Unit tests for `bin/samwise` (stub `pi`) |
| `test/settings.test.sh` | Unit tests for the two Node helpers |
| `test/bootstrap.test.sh` | Clean-account integration test (slow, needs network) |
| `test/run.sh` | Runs all tests; `SKIP_INTEGRATION=1` skips the slow one |
| `README.md` | How to bootstrap, launch and test |

Every test script starts the same way and must be executable (`chmod +x`).

---

### Task 1: Test helpers and `lib/env.sh`

**Files:**
- Create: `test/lib.sh`
- Create: `test/env.test.sh`
- Create: `lib/env.sh`

- [ ] **Step 1: Write the test helpers**

Create `test/lib.sh`:

```bash
# shellcheck shell=bash
# Minimal assertion helpers for the bash test scripts. Source, don't execute.

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$*"; }

# assert_eq <actual> <expected> <description>
assert_eq() {
  [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"
  pass "$3"
}

# assert_contains <haystack> <needle> <description>
assert_contains() {
  [[ "$1" == *"$2"* ]] || fail "$3: '$2' not found in: $1"
  pass "$3"
}

# assert_not_contains <haystack> <needle> <description>
assert_not_contains() {
  [[ "$1" != *"$2"* ]] || fail "$3: unexpected '$2' in: $1"
  pass "$3"
}
```

- [ ] **Step 2: Write the failing test**

Create `test/env.test.sh`:

```bash
#!/usr/bin/env bash
# Unit tests for lib/env.sh.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

# Source env.sh in a scrubbed environment and print the resulting env.
# Extra VAR=value arguments are added to the starting environment.
env_after_source() {
  env -i HOME=/home/test PATH=/usr/bin:/bin "$@" \
    bash -c "source '$REPO/lib/env.sh'; source '$REPO/lib/env.sh'; env"
}

get() { grep "^$1=" <<<"$out" | cut -d= -f2- || true; }

out="$(env_after_source QMD_EMBED_MODEL=hf:x/y/z.gguf QMD_RERANK_MODEL=a QMD_GENERATE_MODEL=b)"

assert_eq "$(get SAMWISE_HOME)" "/home/test/.pi/samwise" "SAMWISE_HOME defaults under ~/.pi"
assert_eq "$(get PI_CODING_AGENT_DIR)" "/home/test/.pi/samwise/agent" "dedicated Pi agent dir"
assert_eq "$(get PI_MEMORY_DIR)" "/home/test/.pi/samwise/memory" "pi-memory data dir"
assert_eq "$(get PI_MEMORY_SNAPSHOT)" "per-turn" "per-turn snapshots enable selective injection"
assert_eq "$(get QMD_CONFIG_DIR)" "/home/test/.pi/samwise/qmd" "qmd config isolated"
assert_eq "$(get INDEX_PATH)" "/home/test/.pi/samwise/qmd/index.sqlite" "qmd index isolated"
assert_eq "$(get PATH)" "/home/test/.pi/samwise/tools/bin:/usr/bin:/bin" "tools/bin prepended exactly once"
assert_eq "$(get QMD_EMBED_MODEL)" "" "inherited QMD_EMBED_MODEL is unset"
assert_eq "$(get QMD_RERANK_MODEL)" "" "inherited QMD_RERANK_MODEL is unset"
assert_eq "$(get QMD_GENERATE_MODEL)" "" "inherited QMD_GENERATE_MODEL is unset"

out="$(env_after_source SAMWISE_HOME=/srv/sam)"
assert_eq "$(get PI_CODING_AGENT_DIR)" "/srv/sam/agent" "SAMWISE_HOME override is respected"
```

Then `chmod +x test/env.test.sh`.

- [ ] **Step 3: Run test to verify it fails**

Run: `bash test/env.test.sh`
Expected: exits non-zero; bash reports `lib/env.sh: No such file or directory` and the first assertion prints `FAIL: SAMWISE_HOME defaults under ~/.pi: expected '/home/test/.pi/samwise', got ''`.

- [ ] **Step 4: Write `lib/env.sh`**

```bash
# shellcheck shell=bash
# Samwise environment: the single source of truth for paths and memory-stack
# settings. Sourced by bin/samwise and bootstrap.sh; never executed directly.

export SAMWISE_HOME="${SAMWISE_HOME:-$HOME/.pi/samwise}"

# Pi: a dedicated agent dir, so Samwise never touches the personal ~/.pi/agent.
export PI_CODING_AGENT_DIR="$SAMWISE_HOME/agent"

# pi-memory: data dir (the thanx scope; T2 repoints it at the thanx-scope repo)
# and per-turn snapshots, which enable qmd selective injection. Trade-off:
# per-turn rebuilds the injected memory block every turn, defeating prompt caching.
export PI_MEMORY_DIR="$SAMWISE_HOME/memory"
export PI_MEMORY_SNAPSHOT="per-turn"

# qmd: keep config and index (which holds memory content) out of ~/.cache/qmd.
export QMD_CONFIG_DIR="$SAMWISE_HOME/qmd"
export INDEX_PATH="$SAMWISE_HOME/qmd/index.sqlite"

# D2: qmd must use its default local models. Drop any override inherited from
# the caller's shell rather than trusting it.
unset QMD_EMBED_MODEL QMD_RERANK_MODEL QMD_GENERATE_MODEL

# Samwise-owned tools (qmd) come first. Guarded so re-sourcing is harmless.
case ":$PATH:" in
  *":$SAMWISE_HOME/tools/bin:"*) ;;
  *) export PATH="$SAMWISE_HOME/tools/bin:$PATH" ;;
esac
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bash test/env.test.sh`
Expected: 11 lines starting `ok - `, exit 0.

- [ ] **Step 6: Commit**

```bash
git add test/lib.sh test/env.test.sh lib/env.sh
git commit -m "Add Samwise environment (lib/env.sh) with tests (#2)"
```

---

### Task 2: `bin/samwise` launcher

**Files:**
- Create: `test/launcher.test.sh`
- Create: `bin/samwise`

- [ ] **Step 1: Write the failing test**

Create `test/launcher.test.sh`:

```bash
#!/usr/bin/env bash
# Unit tests for bin/samwise, using a stub `pi` that echoes its environment.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/stub" "$tmp/links"
cat >"$tmp/stub/pi" <<'EOF'
#!/usr/bin/env bash
echo "$PI_CODING_AGENT_DIR|$PI_MEMORY_SNAPSHOT|$*"
EOF
chmod +x "$tmp/stub/pi"

out="$(SAMWISE_HOME="$tmp/home" PATH="$tmp/stub:$PATH" "$REPO/bin/samwise" --model x "hello world")"
assert_eq "$out" "$tmp/home/agent|per-turn|--model x hello world" "launcher exports env and passes args to pi"

# Launching through a symlink (e.g. ~/bin/samwise) must still find lib/env.sh.
ln -s "$REPO/bin/samwise" "$tmp/links/samwise"
out="$(SAMWISE_HOME="$tmp/home" PATH="$tmp/stub:$PATH" "$tmp/links/samwise")"
assert_eq "$out" "$tmp/home/agent|per-turn|" "launcher works through a symlink"
```

Then `chmod +x test/launcher.test.sh`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash test/launcher.test.sh`
Expected: exits non-zero with `bin/samwise: No such file or directory`.

- [ ] **Step 3: Write `bin/samwise`**

```bash
#!/usr/bin/env bash
# Launch Pi as Samwise, with the environment from lib/env.sh.
set -euo pipefail

repo="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=../lib/env.sh
source "$repo/lib/env.sh"

exec pi "$@"
```

Then `chmod +x bin/samwise`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash test/launcher.test.sh`
Expected: 2 lines starting `ok - `, exit 0.

- [ ] **Step 5: Commit**

```bash
git add test/launcher.test.sh bin/samwise
git commit -m "Add bin/samwise launcher (#2)"
```

---

### Task 3: Declarative Pi settings and the Node helpers

**Files:**
- Create: `pi/settings.json`
- Create: `test/settings.test.sh`
- Create: `lib/merge-settings.mjs`
- Create: `lib/missing-packages.mjs`

- [ ] **Step 1: Create `pi/settings.json`**

The pin must be an exact version (D1). No trailing-newline requirement.

```json
{
  "packages": [
    "npm:pi-memory@0.4.2"
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `test/settings.test.sh`:

```bash
#!/usr/bin/env bash
# Unit tests for lib/merge-settings.mjs and lib/missing-packages.mjs.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

merge() { node "$REPO/lib/merge-settings.mjs" "$@"; }
missing() { node "$REPO/lib/missing-packages.mjs" "$@"; }
sum() { cksum <"$1"; }

# --- merge-settings ---------------------------------------------------------

printf '{"packages":["npm:pi-memory@0.4.2"]}' >"$tmp/repo.json"

merge "$tmp/repo.json" "$tmp/new.json" >/dev/null
assert_eq "$(node -p 'JSON.stringify(require(process.argv[1]))' "$tmp/new.json")" \
  '{"packages":["npm:pi-memory@0.4.2"]}' "creates agent settings when absent"

printf '{\n  "lastChangelogVersion": "0.87.1",\n  "packages": [\n    "npm:old@1.0.0"\n  ]\n}' >"$tmp/agent.json"
out="$(merge "$tmp/repo.json" "$tmp/agent.json")"
assert_contains "$out" "updated" "reports when it rewrites"
assert_eq "$(node -p 'JSON.stringify(require(process.argv[1]))' "$tmp/agent.json")" \
  '{"lastChangelogVersion":"0.87.1","packages":["npm:pi-memory@0.4.2"]}' \
  "repo keys win, Pi-written keys are kept"

before="$(sum "$tmp/agent.json")"
out="$(merge "$tmp/repo.json" "$tmp/agent.json")"
assert_eq "$out" "" "second merge is silent"
assert_eq "$(sum "$tmp/agent.json")" "$before" "second merge leaves the file byte-identical"

# Pi writes settings.json without a trailing newline; equal content must not
# trigger a rewrite just because of formatting.
printf '{\n  "packages": [\n    "npm:pi-memory@0.4.2"\n  ]\n}' >"$tmp/pi-written.json"
before="$(sum "$tmp/pi-written.json")"
out="$(merge "$tmp/repo.json" "$tmp/pi-written.json")"
assert_eq "$out" "" "formatting-only difference is not a change"
assert_eq "$(sum "$tmp/pi-written.json")" "$before" "Pi-formatted file is left untouched"

# --- missing-packages -------------------------------------------------------

cat >"$tmp/repo-many.json" <<'EOF'
{ "packages": [
  "npm:pi-memory@0.4.2",
  "npm:@scope/tool@1.2.3",
  { "source": "npm:obj-form@2.0.0" },
  "git:github.com/example/pi-tools@v1"
] }
EOF

agent="$tmp/agent-dir"
install_fake() { # <name> <version>
  mkdir -p "$agent/npm/node_modules/$1"
  printf '{"name":"%s","version":"%s"}' "$1" "$2" >"$agent/npm/node_modules/$1/package.json"
}

out="$(missing "$tmp/repo-many.json" "$agent")"
assert_eq "$out" $'npm:pi-memory@0.4.2\nnpm:@scope/tool@1.2.3\nnpm:obj-form@2.0.0\ngit:github.com/example/pi-tools@v1' \
  "nothing installed: every source is missing"

install_fake pi-memory 0.4.2
install_fake @scope/tool 1.2.3
install_fake obj-form 1.9.9
out="$(missing "$tmp/repo-many.json" "$agent")"
assert_eq "$out" $'npm:obj-form@2.0.0\ngit:github.com/example/pi-tools@v1' \
  "installed at pin: skipped; wrong version and non-npm: listed"
```

Then `chmod +x test/settings.test.sh`.

- [ ] **Step 3: Run test to verify it fails**

Run: `bash test/settings.test.sh`
Expected: exits non-zero with `Cannot find module '.../lib/merge-settings.mjs'`.

- [ ] **Step 4: Write `lib/merge-settings.mjs`**

```js
// Merge the repo's declarative Pi settings into the agent's settings.json.
// Repo keys win; keys Pi wrote itself (e.g. lastChangelogVersion) are kept.
// Compares parsed JSON, not bytes, and writes only when the merged result
// differs, so re-runs are no-ops even though Pi formats the file itself.
// Usage: node lib/merge-settings.mjs <repo-settings.json> <agent-settings.json>
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [repoPath, agentPath] = process.argv.slice(2);
if (!repoPath || !agentPath) {
	console.error("usage: merge-settings.mjs <repo-settings.json> <agent-settings.json>");
	process.exit(2);
}

const repo = JSON.parse(readFileSync(repoPath, "utf8"));
const current = existsSync(agentPath) ? JSON.parse(readFileSync(agentPath, "utf8")) : null;
const merged = { ...current, ...repo };

if (JSON.stringify(merged) !== JSON.stringify(current)) {
	writeFileSync(agentPath, JSON.stringify(merged, null, 2));
	console.log(`updated ${agentPath}`);
}
```

- [ ] **Step 5: Write `lib/missing-packages.mjs`**

```js
// Print each package source from the repo settings that is not installed in
// the agent dir at its pinned version, one per line. Non-npm sources are
// always printed, since `pi install` is idempotent for them.
// Usage: node lib/missing-packages.mjs <repo-settings.json> <agent-dir>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [repoPath, agentDir] = process.argv.slice(2);
if (!repoPath || !agentDir) {
	console.error("usage: missing-packages.mjs <repo-settings.json> <agent-dir>");
	process.exit(2);
}

const { packages = [] } = JSON.parse(readFileSync(repoPath, "utf8"));

function installedVersion(name) {
	const pkgJson = join(agentDir, "npm", "node_modules", name, "package.json");
	return existsSync(pkgJson) ? JSON.parse(readFileSync(pkgJson, "utf8")).version : null;
}

for (const entry of packages) {
	const source = typeof entry === "string" ? entry : entry.source;
	const npm = /^npm:(@?[^@]+)@(.+)$/.exec(source);
	if (npm && installedVersion(npm[1]) === npm[2]) continue;
	console.log(source);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bash test/settings.test.sh`
Expected: 9 lines starting `ok - `, exit 0.

- [ ] **Step 7: Commit**

```bash
git add pi/settings.json test/settings.test.sh lib/merge-settings.mjs lib/missing-packages.mjs
git commit -m "Add pinned Pi settings and settings helpers (#2)"
```

---

### Task 4: `bootstrap.sh` with the clean-account integration test

**Files:**
- Create: `test/bootstrap.test.sh`
- Create: `bootstrap.sh`

This test is slow (~2 minutes on first run: npm installs qmd) and needs network. It runs against a fresh `HOME` to simulate a clean account, but shares the real npm and qmd model caches so nothing large is downloaded twice.

- [ ] **Step 1: Write the failing test**

Create `test/bootstrap.test.sh`:

```bash
#!/usr/bin/env bash
# Integration test: bootstrap.sh on a clean account (fresh HOME). Needs network;
# shares the real npm and qmd model caches so large downloads happen once.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

real_cache="${XDG_CACHE_HOME:-$HOME/.cache}"
real_npm_cache="$(npm config get cache)"

# Run a command as the "clean account": fresh HOME, no inherited Samwise env.
as_clean() {
  env -u SAMWISE_HOME -u PI_CODING_AGENT_DIR -u PI_MEMORY_DIR -u PI_MEMORY_SNAPSHOT \
    -u QMD_CONFIG_DIR -u INDEX_PATH \
    HOME="$tmp" XDG_CACHE_HOME="$real_cache" npm_config_cache="$real_npm_cache" "$@"
}
# Run a shell snippet with the Samwise environment loaded.
in_samwise() { as_clean bash -c "source '$REPO/lib/env.sh'; $1"; }

home="$tmp/.pi/samwise"
settings="$home/agent/settings.json"
index_yml="$home/qmd/index.yml"

# --- first run on a clean account --------------------------------------------
as_clean "$REPO/bootstrap.sh" >"$tmp/first.log" 2>&1 || { cat "$tmp/first.log"; fail "first bootstrap run failed"; }
pass "bootstrap succeeds on a clean account"

# --- pi-memory pinned exactly and installed -----------------------------------
pinned="$(node -p 'require(process.argv[1]).packages.find((p) => p.startsWith("npm:pi-memory@")) ?? ""' "$settings")"
[[ "$pinned" =~ ^npm:pi-memory@[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "pi-memory not pinned to an exact version: '$pinned'"
pass "pi-memory pinned exactly ($pinned)"
assert_contains "$(in_samwise 'pi list')" "$pinned" "pi list reports pi-memory"

# --- qmd installed and collection initialised ---------------------------------
assert_contains "$(in_samwise 'qmd --version')" "qmd 2.8.3" "qmd 2.8.3 installed in Samwise tools"
assert_contains "$(in_samwise 'qmd collection list')" "pi-memory (qmd://pi-memory/)" "pi-memory collection exists"
assert_contains "$(cat "$index_yml")" "daily: Daily append-only work logs organized by date" "daily context set"

# --- no hosted embedding endpoint configured (D2) -----------------------------
if hits="$(grep -EiH 'https?://|api[_-]?key|QMD_(EMBED|RERANK|GENERATE)_MODEL=' \
  "$REPO/lib/env.sh" "$REPO/pi/settings.json" "$settings" "$index_yml")"; then
  fail "embedding endpoint or key configured: $hits"
fi
pass "no embedding URLs, API keys or model overrides in config"
if bad="$(grep -E '^[[:space:]]+(embed|rerank|generate):' "$index_yml" | grep -v ' hf:')"; then
  fail "non-local qmd model configured: $bad"
fi
assert_contains "$(cat "$index_yml")" \
  "embed: hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf" \
  "qmd uses its default local embedding model"

# --- re-running is safe -------------------------------------------------------
settings_sum="$(cksum <"$settings")"
index_sum="$(cksum <"$index_yml")"
as_clean "$REPO/bootstrap.sh" >"$tmp/second.log" 2>&1 || { cat "$tmp/second.log"; fail "second bootstrap run failed"; }
pass "second bootstrap run succeeds"
assert_eq "$(cksum <"$settings")" "$settings_sum" "settings.json unchanged by re-run"
assert_eq "$(cksum <"$index_yml")" "$index_sum" "index.yml unchanged by re-run"
assert_not_contains "$(cat "$tmp/second.log")" "Installing npm:" "re-run skips pi install"
assert_not_contains "$(cat "$tmp/second.log")" "added " "re-run skips npm install of qmd"

# --- search over a seeded file returns a hit ----------------------------------
mkdir -p "$home/memory/daily"
echo "#lesson [[zebra-cache]] Flushing the zebracache fixed the stale widget bug." \
  >"$home/memory/daily/2026-01-01.md"
out="$(in_samwise 'qmd update >/dev/null && qmd search zebracache -c pi-memory')"
assert_contains "$out" "qmd://pi-memory/daily/2026-01-01.md" "search over a seeded file returns a hit"
```

Then `chmod +x test/bootstrap.test.sh`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash test/bootstrap.test.sh`
Expected: prints `bootstrap.sh: No such file or directory` from the log, then `FAIL: first bootstrap run failed`, exit non-zero.

- [ ] **Step 3: Write `bootstrap.sh`**

```bash
#!/usr/bin/env bash
# Install Samwise's memory stack: pi-memory (pinned in pi/settings.json) and
# qmd (pinned below, default local models only). Safe to re-run: every step
# checks current state first.
set -euo pipefail

QMD_VERSION="2.8.3"
MIN_NODE="22.19" # pi-memory's engines floor

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/env.sh
source "$repo/lib/env.sh"

step() { printf '==> %s\n' "$*"; }
die() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }

step "Checking prerequisites"
for cmd in node npm pi; do
  command -v "$cmd" >/dev/null || die "$cmd not found on PATH (install it first)"
done
node -e '
  const [maj, min] = process.versions.node.split(".").map(Number);
  const [wantMaj, wantMin] = process.argv[1].split(".").map(Number);
  process.exit(maj > wantMaj || (maj === wantMaj && min >= wantMin) ? 0 : 1);
' "$MIN_NODE" || die "node >= $MIN_NODE required (found $(node --version))"

step "Creating $SAMWISE_HOME"
mkdir -p "$PI_CODING_AGENT_DIR" "$PI_MEMORY_DIR" "$SAMWISE_HOME/tools" "$QMD_CONFIG_DIR"

step "Merging Pi settings"
node "$repo/lib/merge-settings.mjs" "$repo/pi/settings.json" "$PI_CODING_AGENT_DIR/settings.json"

step "Installing Pi packages"
missing="$(node "$repo/lib/missing-packages.mjs" "$repo/pi/settings.json" "$PI_CODING_AGENT_DIR")"
while IFS= read -r source; do
  if [[ -n "$source" ]]; then
    pi install "$source" </dev/null
  fi
done <<<"$missing"

step "Installing qmd $QMD_VERSION"
qmd_bin="$SAMWISE_HOME/tools/bin/qmd"
if [[ "$("$qmd_bin" --version 2>/dev/null || true)" != "qmd $QMD_VERSION "* ]]; then
  npm install -g --prefix "$SAMWISE_HOME/tools" "@tobilu/qmd@$QMD_VERSION"
fi

step "Setting up qmd collection"
collections="$(qmd collection list)"
if ! grep -q '^pi-memory ' <<<"$collections"; then
  qmd collection add "$PI_MEMORY_DIR" --name pi-memory
fi
# qmd:// paths: pi-memory's own "/daily" and "/" fail or set a global context.
qmd context add qmd://pi-memory/daily "Daily append-only work logs organized by date"
qmd context add qmd://pi-memory "Curated long-term memory: decisions, preferences, facts, lessons"
qmd update
qmd embed # first run downloads qmd's default local embedding model

step "Done"
cat <<EOF
  Samwise home: $SAMWISE_HOME
  Memory dir:   $PI_MEMORY_DIR
  qmd:          $(qmd --version)
  Launch with:  $repo/bin/samwise
EOF
```

Then `chmod +x bootstrap.sh`.

Note: `pi install` prints `Installing npm:pi-memory@0.4.2...`, which the test's `assert_not_contains ... "Installing npm:"` relies on; the bootstrap's own step line says `Installing Pi packages`, which does not contain `Installing npm:`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash test/bootstrap.test.sh`
Expected: 14 lines starting `ok - `, exit 0 (takes ~1–3 minutes).

- [ ] **Step 5: Commit**

```bash
git add test/bootstrap.test.sh bootstrap.sh
git commit -m "Add idempotent bootstrap for pi-memory + qmd (#2)"
```

---

### Task 5: Test runner and README

**Files:**
- Create: `test/run.sh`
- Modify: `README.md` (currently the single line `# samwise`)

- [ ] **Step 1: Write `test/run.sh`**

```bash
#!/usr/bin/env bash
# Run every test/*.test.sh. SKIP_INTEGRATION=1 skips the slow bootstrap test.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for t in "$REPO"/test/*.test.sh; do
  if [[ "${SKIP_INTEGRATION:-}" == 1 && "$(basename "$t")" == bootstrap.test.sh ]]; then
    echo "--- skipping $(basename "$t")"
    continue
  fi
  echo "--- $(basename "$t")"
  bash "$t"
done
echo "all tests passed"
```

Then `chmod +x test/run.sh`.

- [ ] **Step 2: Run it**

Run: `SKIP_INTEGRATION=1 bash test/run.sh`
Expected: runs env, launcher and settings tests, prints `--- skipping bootstrap.test.sh`, ends with `all tests passed`, exit 0.

- [ ] **Step 3: Replace `README.md`**

````markdown
# samwise

Configuration for Samwise, George's Pi agent at Thanx.

## Requirements

- Node.js ≥ 22.19 with npm
- [Pi](https://pi.dev) on `PATH`

## Install

```bash
./bootstrap.sh
```

Safe to re-run. It installs into `~/.pi/samwise` (override with `SAMWISE_HOME`)
and never touches your personal `~/.pi/agent`:

| Path | Contents |
|---|---|
| `agent/` | Pi agent dir (`PI_CODING_AGENT_DIR`); settings merged from `pi/settings.json` |
| `memory/` | pi-memory data: `MEMORY.md`, daily logs, scratchpad |
| `tools/` | qmd, pinned |
| `qmd/` | qmd config and index for the `pi-memory` collection |

The first run downloads qmd's default local embedding model into
`~/.cache/qmd/models`. No hosted embedding API is used.

## Run

```bash
bin/samwise            # Pi with Samwise's environment (see lib/env.sh)
```

Symlink `bin/samwise` onto your `PATH` if you like; it resolves the repo
through the link.

## Memory stack

- **pi-memory**, pinned in `pi/settings.json`: long-term `MEMORY.md`, daily
  logs and scratchpad as plain markdown.
- **qmd**, pinned in `bootstrap.sh`: local keyword, semantic and hybrid search
  over the memory dir. `PI_MEMORY_SNAPSHOT=per-turn` turns on per-turn
  selective injection, at the cost of provider prompt caching.

## Test

```bash
test/run.sh                      # everything (bootstrap test needs network, ~2 min)
SKIP_INTEGRATION=1 test/run.sh   # fast unit tests only
```
````

- [ ] **Step 4: Commit**

```bash
git add test/run.sh README.md
git commit -m "Add test runner and README for the memory stack (#2)"
```

---

## Final verification (supervisor, after all tasks)

- `bash test/run.sh` — all four test files pass, including the clean-account bootstrap test.
- Map each issue #2 "Done when" item to a passing assertion in `test/bootstrap.test.sh`:
  clean-account install, exact pin, collection + seeded search hit, no hosted embedding config, safe re-run.
