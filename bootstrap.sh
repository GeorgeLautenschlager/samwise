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
