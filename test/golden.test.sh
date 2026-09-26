#!/usr/bin/env bash
# Proves each golden-set validator rule rejects a broken scenario, then
# validates the real golden set (eval/golden).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

[[ -d "$REPO/eval/node_modules" ]] || npm ci --prefix "$REPO/eval" --silent

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

validate() { node "$REPO/eval/validate.mjs" "$@"; }

lexicon=$'systems: [Skiffline]\npeople: [Priya Okafor]'

# new_golden: a fresh golden dir containing only the lexicon; prints its path.
new_golden() {
  local dir
  dir="$(mktemp -d "$tmp/golden.XXXX")"
  printf '%s\n' "$lexicon" >"$dir/lexicon.yml"
  echo "$dir"
}

# write_scenario <golden-dir> <category-dir> <slug> <front-matter>
write_scenario() {
  mkdir -p "$1/$2"
  printf -- '---\n%s\n---\nNarrative.\n' "$4" >"$1/$2/$3.md"
}

BASE=$'id: base
category: recall
description: Base scenario.
seed:
  daily:
    2026-08-01: |
      <!-- 2026-08-01 10:00:00 [a1b2c3d4] -->
      #problem [[x]] Something broke.
      - Tried: A.
      - Worked: B.
      - Pointers: PR #1.
prompt:
  - "Something broke."
expect:
  response_includes: ["B"]'

# rejects <description> <category-dir> <slug> <front-matter> <expected error substring>
rejects() {
  local dir out
  dir="$(new_golden)"
  write_scenario "$dir" "$2" "$3" "$4"
  if out="$(validate "$dir" 2>&1)"; then fail "$1: validator accepted it"; fi
  assert_contains "$out" "$5" "rejects $1"
}

# --- a valid scenario passes ----------------------------------------------------
dir="$(new_golden)"
write_scenario "$dir" recall base "$BASE"
out="$(validate "$dir")" || fail "valid base scenario rejected: $out"
assert_contains "$out" "1 valid scenarios: recall 1" "accepts a valid scenario"

# --- each rule rejects -------------------------------------------------------------
MOCK=$'\nkeystone_mock:\n  - id: KS-1\n    title: Doc\n    match: [x]\n    content: Fresh fact.'
STALE="${BASE/category: recall/category: stale-knowledge}"
LEAK="${BASE/category: recall/category: scope-leak}"

rejects "missing expect" recall base "${BASE%%$'\nexpect:'*}" "missing 'expect'"
rejects "id not matching filename" recall other "$BASE" "must equal the filename 'other'"
rejects "category not matching directory" preference base "$BASE" "must match its directory 'preference'"
rejects "unknown category" trivia base "${BASE/category: recall/category: trivia}" "must be one of"
rejects "empty prompt" recall base "${BASE/$'prompt:\n  - "Something broke."'/prompt: []}" "prompt must be a non-empty list"
rejects "requires not a list" recall base "$BASE"$'\nrequires: reflect' "requires must be a list of strings"
rejects "daily entry missing a field" recall base "${BASE/$'      - Tried: A.\n'/}" "missing '- Tried: ' line"
rejects "daily seed too recent" recall base "${BASE//2026-08-01/2026-09-20}" "no later than 2026-08-31"
rejects "memory entry without timestamp" recall base \
  "${BASE/$'seed:\n'/$'seed:\n  memory: |\n    #preference [[x]] No stamp.\n'}" "seed.memory entry 1 must start"
rejects "personal entry without as-of" recall base \
  "${BASE/$'seed:\n'/$'seed:\n  personal: |\n    ### Title\n    Body.\n'}" "'as-of: YYYY-MM-DD'"
rejects "personal seed containing a lexicon term" recall base \
  "${BASE/$'seed:\n'/$'seed:\n  personal: |\n    ### Title\n    as-of: 2026-07-01\n\n    Skiffline is slow.\n'}" \
  "must not contain lexicon term 'Skiffline'"
rejects "unknown expect key" recall base "$BASE"$'\n  response_contains: ["B"]' "unknown expect key 'response_contains'"
rejects "tool_called item without a name" recall base "$BASE"$'\n  tool_called: [{args_include: {x: 1}}]' \
  "expect.tool_called must be a list"
rejects "stale-knowledge without keystone_mock" stale-knowledge base \
  "$STALE"$'\n  tool_called: [{name: keystone_search}]' "need a non-empty keystone_mock"
rejects "stale-knowledge without a keystone_search expectation" stale-knowledge base \
  "$STALE$MOCK" "must expect a keystone_search call"
rejects "scope-leak without personal_scope_clean" scope-leak base "$LEAK" "must expect personal_scope_clean: true"
rejects "scope-leak without a lexicon term" scope-leak base \
  "$LEAK"$'\n  personal_scope_clean: true' "need a lexicon term in the prompt or seed"

dir="$(new_golden)"
mkdir -p "$dir/recall"
printf 'No front matter here.\n' >"$dir/recall/bare.md"
out="$(validate "$dir" 2>&1)" && fail "file without front matter accepted"
assert_contains "$out" "no YAML front matter" "rejects a file without front matter"

# --- judge-only scenarios are valid but reported ---------------------------------
dir="$(new_golden)"
write_scenario "$dir" recall base "${BASE/$'  response_includes: ["B"]'/$'  judge: "Mentions B."'}"
out="$(validate "$dir")" || fail "judge-only scenario rejected: $out"
assert_contains "$out" "judge-scored 1" "reports judge-scored scenarios"
