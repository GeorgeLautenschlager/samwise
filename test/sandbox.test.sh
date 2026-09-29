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
