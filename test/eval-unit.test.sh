#!/usr/bin/env bash
# Runs the eval's node:test unit tests (eval/test/*.test.mjs).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

[[ -d "$REPO/eval/node_modules" ]] || npm ci --prefix "$REPO/eval" --silent

for t in "$REPO"/eval/test/*.test.mjs; do
  out="$(node --test --test-reporter=tap "$t" 2>&1)" || { echo "$out"; fail "$(basename "$t")"; }
  pass "$(basename "$t") ($(grep -m1 '^# pass' <<<"$out" | sed 's/^# //'))"
done
