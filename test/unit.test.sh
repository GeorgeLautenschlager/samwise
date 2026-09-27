#!/usr/bin/env bash
# Runs the node:test unit tests: eval/test/*.test.mjs and lib/reflect/test/*.test.mjs.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

[[ -d "$REPO/eval/node_modules" ]] || npm ci --prefix "$REPO/eval" --silent

for t in "$REPO"/eval/test/*.test.mjs "$REPO"/lib/reflect/test/*.test.mjs; do
  [[ -e "$t" ]] || continue
  name="${t#"$REPO"/}"
  out="$(node --test --test-reporter=tap "$t" 2>&1)" || { echo "$out"; fail "$name"; }
  pass "$name ($(grep -m1 '^# pass' <<<"$out" | sed 's/^# //'))"
done
