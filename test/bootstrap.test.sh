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
  env -u SAMWISE_HOME -u SAMWISE_UNSANDBOXED -u PI_CODING_AGENT_DIR -u PI_MEMORY_DIR -u PI_MEMORY_SNAPSHOT \
    -u QMD_CONFIG_DIR -u INDEX_PATH \
    HOME="$tmp" XDG_CACHE_HOME="$real_cache" npm_config_cache="$real_npm_cache" "$@"
}
# Run a shell snippet with the Samwise environment loaded.
in_samwise() { as_clean bash -c "source '$REPO/lib/env.sh'; $1"; }

home="$tmp/.pi/samwise"
settings="$home/agent/settings.json"
index_yml="$home/qmd/index.yml"
scope="$home/memory"

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
assert_contains "$(cat "$tmp/first.log")" "==> Fetching qmd models" "bootstrap fetches qmd's models"
for model in embeddinggemma-300M-Q8_0.gguf qwen3-reranker-0.6b-q8_0.gguf qmd-query-expansion-1.7B-q4_k_m.gguf; do
  [[ -e "$real_cache/qmd/models/$model.etag" ]] || fail "qmd model $model not pulled"
done
pass "all three qmd models are pulled, so Samwise never downloads at run time"

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

# --- thanx scope: local-only git repo with skeleton (D3, D12) -----------------
[[ -d "$scope/.git" ]] || fail "thanx scope is not a git repo"
pass "thanx scope is a git repo"
assert_eq "$(git -C "$scope" remote)" "" "thanx scope has no remote"
assert_eq "$(git -C "$scope" ls-files | tr '\n' ' ')" \
  "MEMORY.md SCRATCHPAD.md daily/.gitkeep skills/.gitkeep " "skeleton committed"
assert_eq "$(git -C "$scope" status --porcelain)" "" "thanx scope working tree is clean"
assert_contains "$(cat "$settings")" '"../memory/skills"' "thanx-scope skills wired into Pi settings"

# --- context files: contract and personal wisdom are symlinked in (T3) --------
assert_eq "$(readlink "$home/agent/AGENTS.md")" "$REPO/pi/AGENTS.md" "AGENTS.md links to the memory contract"
assert_eq "$(readlink "$home/agent/APPEND_SYSTEM.md")" "$REPO/WORKING-WITH-GEORGE.md" \
  "APPEND_SYSTEM.md links to WORKING-WITH-GEORGE.md"
assert_eq "$(readlink "$home/agent/prompts")" "$REPO/pi/prompts" "prompt templates (/reflect) linked in"
assert_eq "$(readlink "$home/agent/extensions")" "$REPO/pi/extensions" "extensions (reflect nudge) linked in"

# --- execution fence (sandbox T1) ---------------------------------------------
assert_eq "$(readlink "$home/agent/sandbox.json")" "$REPO/pi/sandbox.json" \
  "sandbox.json links to the config repo's policy (sandbox D3)"
assert_contains "$(in_samwise 'pi list')" "npm:pi-sandbox@0.6.8" "pi list reports pi-sandbox"
[[ -e "$home/agent/npm/node_modules/pi-sandbox/package.json" ]] || fail "pi-sandbox not installed in the agent dir"
pass "pi-sandbox is installed in the agent dir"
assert_contains "$(cat "$tmp/first.log")" "==> Checking sandbox dependencies" "bootstrap checks sandbox dependencies"
if [[ "$(uname -s)" != Darwin ]]; then
  assert_contains "$(cat "$tmp/first.log")" "Sandbox unsupported on $(uname -s)" "non-macOS: bootstrap says the fence is unsupported"
fi
assert_contains "$(cat "$tmp/first.log")" "==> Checking sandbox policy" "bootstrap checks for policy drift"

# A real file in the way is never overwritten.
other="$tmp/other-home"
mkdir -p "$other/agent"
echo "keep me" >"$other/agent/AGENTS.md"
if out="$(as_clean env SAMWISE_HOME="$other" "$REPO/bootstrap.sh" 2>&1)"; then
  fail "bootstrap replaced a regular AGENTS.md"
fi
assert_contains "$out" "is not a symlink" "bootstrap refuses to replace a regular AGENTS.md"
assert_eq "$(cat "$other/agent/AGENTS.md")" "keep me" "the regular AGENTS.md is left intact"

# --- re-running is safe -------------------------------------------------------
settings_sum="$(cksum <"$settings")"
index_sum="$(cksum <"$index_yml")"
scope_head="$(git -C "$scope" rev-parse HEAD)"
ln -sfn /nonexistent/old-checkout/WORKING-WITH-GEORGE.md "$home/agent/APPEND_SYSTEM.md" # stale link
as_clean "$REPO/bootstrap.sh" >"$tmp/second.log" 2>&1 || { cat "$tmp/second.log"; fail "second bootstrap run failed"; }
pass "second bootstrap run succeeds"
assert_eq "$(cksum <"$settings")" "$settings_sum" "settings.json unchanged by re-run"
assert_eq "$(cksum <"$index_yml")" "$index_sum" "index.yml unchanged by re-run"
assert_eq "$(git -C "$scope" rev-parse HEAD)" "$scope_head" "thanx scope HEAD unchanged by re-run"
assert_eq "$(readlink "$home/agent/APPEND_SYSTEM.md")" "$REPO/WORKING-WITH-GEORGE.md" \
  "re-run repoints a stale APPEND_SYSTEM.md link"
assert_eq "$(readlink "$home/agent/AGENTS.md")" "$REPO/pi/AGENTS.md" "re-run keeps the AGENTS.md link"
assert_eq "$(readlink "$home/agent/sandbox.json")" "$REPO/pi/sandbox.json" "re-run keeps the sandbox.json link"

# --- guard: thanx scope may not live inside the config repo (D5) --------------
probe="$REPO/.guard-probe-home"
if out="$(as_clean env SAMWISE_HOME="$probe" "$REPO/bootstrap.sh" 2>&1)"; then
  rm -rf "$probe"
  fail "bootstrap accepted a thanx scope inside the config repo"
fi
assert_contains "$out" "inside the config repo" "bootstrap refuses a thanx scope inside the config repo"
[[ ! -e "$probe" ]] || { rm -rf "$probe"; fail "guard ran after creating files in the config repo"; }
pass "guard fails before creating anything"
assert_not_contains "$(cat "$tmp/second.log")" "Installing npm:" "re-run skips pi install"
assert_not_contains "$(cat "$tmp/second.log")" "added " "re-run skips npm install of qmd"
assert_not_contains "$(cat "$tmp/second.log")" "Pulling models" "re-run skips pulling models (offline-safe)"

# --- search over a seeded file returns a hit ----------------------------------
mkdir -p "$home/memory/daily"
echo "#lesson [[zebra-cache]] Flushing the zebracache fixed the stale widget bug." \
  >"$home/memory/daily/2026-01-01.md"
out="$(in_samwise 'qmd update >/dev/null && qmd search zebracache -c pi-memory')"
assert_contains "$out" "qmd://pi-memory/daily/2026-01-01.md" "search over a seeded file returns a hit"

# --- end-to-end: a real pi-memory write lands in the thanx scope --------------
mkdir -p "$scope/skills/probe"
printf -- '---\nname: probe-skill-zq7\ndescription: Probe skill for the Samwise bootstrap test.\n---\n\nProbe.\n' \
  >"$scope/skills/probe/SKILL.md"
repo_status="$(git -C "$REPO" status --porcelain)"

node "$REPO/test/fixtures/stub-llm.mjs" "#lesson e2e-probe-note" "$tmp/requests.log" >"$tmp/port" &
stub_pid=$!
trap 'kill "$stub_pid" 2>/dev/null; rm -rf "$tmp"' EXIT
for _ in $(seq 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
[[ -s "$tmp/port" ]] || fail "stub LLM did not start"

cat >"$home/agent/models.json" <<EOF
{ "providers": { "stub": {
  "baseUrl": "http://127.0.0.1:$(cat "$tmp/port")/v1",
  "api": "openai-completions",
  "apiKey": "stub",
  "models": [{ "id": "stub-model" }]
} } }
EOF

# The fence is macOS-only; elsewhere the launcher runs only with the opt-in.
unsandboxed=()
[[ "$(uname -s)" == Darwin ]] || unsandboxed=(SAMWISE_UNSANDBOXED=1)
(cd "$tmp" && as_clean ${unsandboxed[@]+"${unsandboxed[@]}"} PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=0 \
  timeout 60 "$REPO/bin/samwise" -p --model stub/stub-model "remember this" </dev/null) \
  >"$tmp/pi.log" 2>&1 || { cat "$tmp/pi.log"; fail "Samwise session against the stub failed"; }
pass "Samwise session runs against the stub LLM"

note_file="$(grep -l "e2e-probe-note" "$scope"/daily/*.md || true)"
[[ -n "$note_file" ]] || fail "memory_write did not land in the thanx scope's daily log"
pass "memory_write landed in the thanx scope's daily log"
assert_contains "$(git -C "$scope" status --porcelain)" "daily/$(basename "$note_file")" \
  "the write shows up as a change in the thanx-scope repo"
assert_eq "$(git -C "$REPO" status --porcelain)" "$repo_status" "config repo untouched by the write"
assert_contains "$(cat "$tmp/requests.log")" "probe-skill-zq7" "thanx-scope skills reach Samwise's prompt"
assert_contains "$(cat "$tmp/requests.log")" "Keystone wins" "memory contract reaches Samwise's prompt"
assert_contains "$(cat "$tmp/requests.log")" "# Working with George" "personal wisdom reaches Samwise's prompt"
