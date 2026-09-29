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

# --- repo settings: npm packages pinned exactly (sandbox D1) -----------------

unpinned="$(node -e '
const { packages = [] } = require(process.argv[1]);
for (const p of packages) {
	const s = typeof p === "string" ? p : p.source;
	if (s.startsWith("npm:") && !/^npm:(@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+$/.test(s)) console.log(s);
}' "$REPO/pi/settings.json")"
assert_eq "$unpinned" "" "every npm package in pi/settings.json is pinned to an exact version"
assert_contains "$(cat "$REPO/pi/settings.json")" '"npm:pi-sandbox@0.6.8"' "pi-sandbox is pinned (sandbox D1)"
