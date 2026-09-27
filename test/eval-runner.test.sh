#!/usr/bin/env bash
# End-to-end test of eval/run.mjs against a scripted stub LLM and a fixture
# golden set. Slow (real bootstrap and qmd per run), but needs no real LLM.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

[[ -d "$REPO/eval/node_modules" ]] || npm ci --prefix "$REPO/eval" --silent

tmp="$(mktemp -d)"
node "$REPO/test/fixtures/scripted-llm.mjs" "$REPO/test/fixtures/runner-script.json" "$tmp/requests.log" >"$tmp/port" &
stub_pid=$!
trap 'kill "$stub_pid" 2>/dev/null; rm -rf "$tmp"' EXIT
for _ in $(seq 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
[[ -s "$tmp/port" ]] || fail "stub LLM did not start"
port="$(cat "$tmp/port")"
cat >"$tmp/models.json" <<EOF
{ "providers": { "stub": {
  "baseUrl": "http://127.0.0.1:$port/v1", "api": "openai-completions", "apiKey": "stub",
  "models": [{ "id": "stub-model" }]
} } }
EOF

wisdom_sum="$(cksum <"$REPO/WORKING-WITH-GEORGE.md")"
repo_status="$(git -C "$REPO" status --porcelain)"

# eval <out-dir> <args...>: run the runner with the stub and the fixture golden set.
eval_run() {
  local out="$1"
  shift
  node "$REPO/eval/run.mjs" --model stub/stub-model --models-json "$tmp/models.json" --auth none \
    --golden "$REPO/test/fixtures/golden" --out "$out" --timeout 120 "$@"
}
report_json() { ls "$1"/*.json; }
jq_node() { node -e "const r = require(process.argv[1]); console.log(JSON.stringify($2))" "$(report_json "$1")"; }

# --- usage errors -------------------------------------------------------------
if out="$(eval_run "$tmp/usage" --config Z 2>&1)"; then fail "unknown config accepted"; fi
assert_contains "$out" "--config must be one of: A, B" "rejects an unknown config"

# --- config A: pass, fail, Keystone, leak, skip, network, keep ----------------
set +e
eval_run "$tmp/a" --config A --runs 2 --jobs 2 --network --keep \
  --only runner-pass,runner-fail,runner-keystone,runner-leak,runner-requires >"$tmp/a.log" 2>&1
code=$?
set -e
assert_eq "$code" "1" "a failing eval exits 1"
cat "$tmp/a.log" | grep -q "report" || { cat "$tmp/a.log"; fail "runner printed no report path"; }

assert_eq "$(jq_node "$tmp/a" 'r.scenarios.map((s) => `${s.id}:${s.passed}/${s.runs}`).join(" ")')" \
  '"runner-fail:0/2 runner-pass:2/2 runner-keystone:2/2 runner-leak:0/2"' "scenario pass counts"
assert_eq "$(jq_node "$tmp/a" '[r.ac.AC2.status, r.ac.AC3.status, r.ac.AC4.status, r.verdict]')" \
  '["not evaluated","fail","pass","FAIL"]' "AC verdicts (no preference runs, planted leak, Keystone preferred)"
assert_eq "$(jq_node "$tmp/a" 'r.leaks.map((l) => l.term + "@" + l.path)')" \
  '["Skiffline@personal/WORKING-WITH-GEORGE.md","Skiffline@personal/WORKING-WITH-GEORGE.md"]' \
  "the planted leak is detected in the run's personal-scope copy"
assert_eq "$(jq_node "$tmp/a" 'r.skipped.map((s) => s.id)')" '["runner-requires"]' "scenarios needing reflect are skipped"
assert_contains "$(jq_node "$tmp/a" 'r.network.map((d) => d.destination)')" "127.0.0.1:$port" "network capture logs the model endpoint"
assert_contains "$(cat "$tmp/a"/*.md)" "**Verdict: FAIL**" "markdown report written"

transcripts="$(ls -d "$tmp/a"/*/)"
assert_contains "$(cat "$transcripts/runner-pass-1.jsonl")" "Raised prefetch." "seeded daily log is readable in the run"
assert_contains "$(cat "$transcripts/runner-keystone-1.jsonl")" "KS-1: Skiffline deploy runbook" "Keystone mock answers keystone_search"

kept="$(sed -n 's/^eval: kept run dirs in //p' "$tmp/a.log")"
[[ -d "$kept" ]] || fail "--keep did not report a kept dir"
assert_eq "$(readlink "$kept/runs/runner-pass-1/home/agent/APPEND_SYSTEM.md")" \
  "$kept/runs/runner-pass-1/personal/WORKING-WITH-GEORGE.md" "runs link personal wisdom to their own copy"
rm -rf "$kept"

# --- config A vs B: qmd available vs hidden ------------------------------------
eval_run "$tmp/search-a" --config A --runs 1 --only runner-search >/dev/null 2>&1 || true
assert_contains "$(cat "$(ls -d "$tmp/search-a"/*/)"/runner-search-1.jsonl)" "2026-08-01.md" "config A: memory_search finds the seeded log"
eval_run "$tmp/search-b" --config B --runs 1 --only runner-search >/dev/null 2>&1 || true
b_transcript="$(cat "$(ls -d "$tmp/search-b"/*/)"/runner-search-1.jsonl)"
assert_not_contains "$b_transcript" "2026-08-01.md" "config B: memory_search finds nothing"
assert_contains "$b_transcript" "@tobilu/qmd" "config B: pi-memory reports qmd unavailable"

# --- isolation -------------------------------------------------------------------
assert_eq "$(cksum <"$REPO/WORKING-WITH-GEORGE.md")" "$wisdom_sum" "real WORKING-WITH-GEORGE.md untouched"
assert_eq "$(git -C "$REPO" status --porcelain)" "$repo_status" "config repo untouched"
