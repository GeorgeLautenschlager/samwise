#!/usr/bin/env bash
# Install Samwise's memory stack, pi-memory (pinned in pi/settings.json) and
# qmd (pinned below, default local models only), and its execution fence,
# pi-sandbox (pinned in pi/settings.json) with the sandbox policy link. Safe
# to re-run: every step checks current state first.
set -euo pipefail

QMD_VERSION="2.8.3"
# qmd 2.8.3's default models (embedding, re-ranking, query expansion).
QMD_MODELS=(embeddinggemma-300M-Q8_0.gguf qwen3-reranker-0.6b-q8_0.gguf qmd-query-expansion-1.7B-q4_k_m.gguf)
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

step "Checking scope separation"
if node "$repo/lib/path-inside.mjs" "$PI_MEMORY_DIR" "$repo"; then
  die "PI_MEMORY_DIR ($PI_MEMORY_DIR) is inside the config repo; the thanx scope must live outside it (D5)"
fi

step "Creating $SAMWISE_HOME"
mkdir -p "$PI_CODING_AGENT_DIR" "$PI_MEMORY_DIR" "$SAMWISE_HOME/tools" "$QMD_CONFIG_DIR"

step "Setting up thanx scope"
# The pi-memory data dir is the thanx scope: its own local-only git repo (D3).
# No remote until Thanx approves one (D12). Existing memory is never overwritten.
if [[ ! -d "$PI_MEMORY_DIR/.git" ]]; then
  git -C "$PI_MEMORY_DIR" init -q -b main
  mkdir -p "$PI_MEMORY_DIR/daily" "$PI_MEMORY_DIR/skills"
  touch "$PI_MEMORY_DIR/daily/.gitkeep" "$PI_MEMORY_DIR/skills/.gitkeep"
  if [[ ! -e "$PI_MEMORY_DIR/MEMORY.md" ]]; then
    printf '%s\n' "# Thanx memory" "" \
      "Wisdom from working at Thanx (thanx scope; stays with Thanx). Entries carry an as-of date and change only through /reflect." \
      >"$PI_MEMORY_DIR/MEMORY.md"
  fi
  if [[ ! -e "$PI_MEMORY_DIR/SCRATCHPAD.md" ]]; then
    printf '# Scratchpad\n\n' >"$PI_MEMORY_DIR/SCRATCHPAD.md"
  fi
  git -C "$PI_MEMORY_DIR" add -A
  git -C "$PI_MEMORY_DIR" -c user.name=Samwise -c user.email=samwise@localhost \
    commit -q -m "Initialize thanx scope"
fi

step "Linking Samwise context files"
# link <target> <path>: symlink <path> to <target>. A correct link is kept, a
# wrong or stale link is repointed (links hold no content), and a real file is
# never overwritten.
link() {
  if [[ -L "$2" ]]; then
    [[ "$(readlink "$2")" == "$1" ]] && return 0
    ln -sfn "$1" "$2"
  elif [[ -e "$2" ]]; then
    die "$2 is not a symlink; move it aside and re-run (it would be replaced by a link to $1)"
  else
    ln -s "$1" "$2"
  fi
}
link "$repo/pi/AGENTS.md" "$PI_CODING_AGENT_DIR/AGENTS.md"
# The eval runner points this at a per-run copy so runs never touch the real file.
link "${SAMWISE_PERSONAL_WISDOM:-$repo/WORKING-WITH-GEORGE.md}" "$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md"
link "$repo/pi/prompts" "$PI_CODING_AGENT_DIR/prompts"
link "$repo/pi/extensions" "$PI_CODING_AGENT_DIR/extensions"
# pi-sandbox writes "Allow for all projects" approvals through this link, so
# they show up as diffs in the repo (sandbox D3, D8).
link "$repo/pi/sandbox.json" "$PI_CODING_AGENT_DIR/sandbox.json"

step "Merging Pi settings"
node "$repo/lib/merge-settings.mjs" "$repo/pi/settings.json" "$PI_CODING_AGENT_DIR/settings.json"

step "Installing Pi packages"
missing="$(node "$repo/lib/missing-packages.mjs" "$repo/pi/settings.json" "$PI_CODING_AGENT_DIR")"
while IFS= read -r source; do
  if [[ -n "$source" ]]; then
    pi install "$source" </dev/null
  fi
done <<<"$missing"

step "Checking sandbox dependencies"
"$repo/lib/sandbox/deps.sh"

step "Installing qmd $QMD_VERSION"
qmd_bin="$SAMWISE_HOME/tools/bin/qmd"
if [[ "$("$qmd_bin" --version 2>/dev/null || true)" != "qmd $QMD_VERSION "* ]]; then
  npm install -g --prefix "$SAMWISE_HOME/tools" "@tobilu/qmd@$QMD_VERSION"
fi

step "Fetching qmd models"
# All of them now, so a running Samwise never downloads from HuggingFace (AC5).
# qmd pull records an .etag per model; pull only when one is missing, so
# re-runs stay offline-safe (a pull re-checks HuggingFace even when cached).
models_dir="${XDG_CACHE_HOME:-$HOME/.cache}/qmd/models"
for model in "${QMD_MODELS[@]}"; do
  if [[ ! -e "$models_dir/$model.etag" ]]; then
    qmd pull
    break
  fi
done

step "Setting up qmd collection"
collections="$(qmd collection list)"
if ! grep -q '^pi-memory ' <<<"$collections"; then
  qmd collection add "$PI_MEMORY_DIR" --name pi-memory
fi
# qmd:// paths: pi-memory's own "/daily" and "/" fail or set a global context.
qmd context add qmd://pi-memory/daily "Daily append-only work logs organized by date"
qmd context add qmd://pi-memory "Curated long-term memory: decisions, preferences, facts, lessons"
qmd update
qmd embed

step "Checking sandbox policy"
"$repo/lib/sandbox/drift.sh" "$repo"

step "Done"
cat <<EOF
  Samwise home: $SAMWISE_HOME
  Memory dir:   $PI_MEMORY_DIR
  Sandbox:      $repo/pi/sandbox.json
  qmd:          $(qmd --version)
  Launch with:  $repo/bin/samwise
EOF
