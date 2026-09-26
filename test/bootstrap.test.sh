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
