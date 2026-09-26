#!/usr/bin/env bash
# Fast tests for scope separation: the personal-scope template, the config
# repo's D5 ignores, and lib/path-inside.mjs.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- WORKING-WITH-GEORGE.md template ------------------------------------------
wwg="$(cat "$REPO/WORKING-WITH-GEORGE.md")"
assert_contains "$wwg" "Never Thanx-specific" "template states the scope rule (D5)"
assert_contains "$wwg" "only through \`/reflect\`" "template states the /reflect rule (D8)"
assert_contains "$wwg" "deleted, not annotated" "template states the retirement rule (D9)"
assert_contains "$wwg" "as-of: YYYY-MM-DD" "template shows the dated entry format (D9)"
assert_contains "$wwg" $'\n## Entries' "template has an Entries section"

# --- config repo ignores thanx-scope file names (D5) --------------------------
for p in MEMORY.md SCRATCHPAD.md daily/x.md recovery/x.json sub/daily/x.md; do
  git -C "$REPO" check-ignore -q "$p" || fail "$p is not ignored"
  pass "config repo ignores $p"
done
if git -C "$REPO" check-ignore -q WORKING-WITH-GEORGE.md; then
  fail "WORKING-WITH-GEORGE.md must not be ignored"
fi
pass "config repo does not ignore WORKING-WITH-GEORGE.md"

# --- lib/path-inside.mjs ------------------------------------------------------
inside() { node "$REPO/lib/path-inside.mjs" "$1" "$2"; }
mkdir -p "$tmp/repo/sub" "$tmp/repo2" "$tmp/elsewhere"
ln -s "$tmp/repo/sub" "$tmp/elsewhere/link"

inside "$tmp/repo" "$tmp/repo" || fail "same dir should count as inside"
pass "path-inside: same dir"
inside "$tmp/repo/sub/new/deeper" "$tmp/repo" || fail "not-yet-existing child should count as inside"
pass "path-inside: non-existent child"
inside "$tmp/elsewhere/link/x" "$tmp/repo" || fail "symlink into repo should count as inside"
pass "path-inside: symlink resolved"
if inside "$tmp/repo2" "$tmp/repo"; then fail "sibling with shared prefix is not inside"; fi
pass "path-inside: shared-prefix sibling is outside"
if inside "$tmp/elsewhere" "$tmp/repo"; then fail "unrelated dir is not inside"; fi
pass "path-inside: unrelated dir is outside"
