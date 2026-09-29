#!/usr/bin/env bash
# samwise-reflect end to end against temp scopes: status, context, propose,
# a rejected run (no changes), the stale-proposal guard, partial apply with
# commits and trailers, retirement, and the once-a-day nudge.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

home="$tmp/home"
memory="$home/memory"
config="$tmp/config"
mkdir -p "$memory/daily" "$home/agent" "$config"
g() { git -c user.name=Setup -c user.email=setup@test "$@"; }

printf '# Thanx memory\n\nWisdom from working at Thanx.\n' >"$memory/MEMORY.md"
for d in 2026-09-25 2026-09-26 2026-09-27; do
  printf '<!-- %s 10:00:00 [a1b2c3d4] -->\n#problem [[p-%s]] Skiffline hiccup on %s.\n' "$d" "$d" "$d" >"$memory/daily/$d.md"
done
g -C "$memory" init -q && g -C "$memory" add -A && g -C "$memory" commit -qm init
cp "$REPO/WORKING-WITH-GEORGE.md" "$config/" && echo x >"$config/other.txt"
g -C "$config" init -q && g -C "$config" add -A && g -C "$config" commit -qm init
echo staged >"$config/other.txt" && git -C "$config" add other.txt
ln -s "$config/WORKING-WITH-GEORGE.md" "$home/agent/APPEND_SYSTEM.md"

# HOME=$tmp: no global git identity, so commits use the Samwise fallback.
reflect() {
  env -u PI_MEMORY_DIR -u PI_CODING_AGENT_DIR HOME="$tmp" SAMWISE_HOME="$home" SAMWISE_REFLECT_TODAY=2026-09-27 \
    "$REPO/bin/samwise-reflect" "$@"
}
snapshot() {
  cat "$memory/MEMORY.md" "$config/WORKING-WITH-GEORGE.md" | cksum
  git -C "$memory" rev-parse HEAD
  git -C "$config" rev-parse HEAD
}

PROPOSAL='{"items": [
  {"op": "add", "scope": "personal", "title": "Breakers", "body": "Prefer circuit breakers to longer timeouts."},
  {"op": "add", "scope": "personal", "title": "Incident order", "body": "After INC-2291, restart consumers first."},
  {"op": "add", "scope": "thanx", "title": "Deploys", "body": "Skiffline deploys through Argo CD."}
], "vocabulary": ["Skiffline"]}'

# --- status and context ---------------------------------------------------------
assert_eq "$(reflect status --json)" '{"reflectedThrough":null,"unreflectedDays":["2026-09-25","2026-09-26"],"pending":false}' \
  "status: days before today are unreflected"
ctx="$(reflect context)"
assert_contains "$ctx" "## 2026-09-27" "context: includes today's log"
assert_contains "$ctx" "## Personal scope (WORKING-WITH-GEORGE.md)" "context: lists the personal scope"

# --- propose ----------------------------------------------------------------------
if out="$(reflect propose <<<'not json' 2>&1)"; then fail "invalid JSON accepted"; fi
assert_contains "$out" "proposal is not valid JSON" "propose: rejects invalid JSON"
[[ ! -e "$home/reflect/pending.json" ]] || fail "an invalid proposal was stored"
pass "propose: nothing stored on error"

before="$(snapshot)"
diff_out="$(reflect propose <<<"$PROPOSAL")"
assert_contains "$diff_out" '[2] add  thanx  MEMORY.md  ↪ rerouted from personal: contains an ID ("INC-2291")' \
  "propose: leaky personal item rerouted to thanx"
assert_eq "$(snapshot)" "$before" "propose: writes nothing"
assert_contains "$(reflect status)" "a proposal is pending" "status: reports the pending proposal"

# --- nudge ------------------------------------------------------------------------
assert_eq "$(reflect nudge)" "A /reflect proposal is waiting for your approval." "nudge: reminds"
assert_eq "$(reflect nudge)" "" "nudge: at most once a day"

# --- a rejected run changes nothing ---------------------------------------------
reflect discard >/dev/null
assert_eq "$(snapshot)" "$before" "discard: no file changes, no commits"
[[ ! -e "$home/reflect/pending.json" ]] || fail "pending proposal not removed"
pass "discard: proposal dropped"
if out="$(reflect apply 2>&1)"; then fail "apply without a proposal succeeded"; fi
assert_contains "$out" "nothing pending" "apply: needs a pending proposal"

# --- stale-proposal guard -----------------------------------------------------------
reflect propose <<<"$PROPOSAL" >/dev/null
echo "hand edit" >>"$memory/MEMORY.md"
if out="$(reflect apply 2>&1)"; then fail "apply after a hand edit succeeded"; fi
assert_contains "$out" "changed since the proposal" "apply: refuses a stale proposal"
git -C "$memory" checkout -q MEMORY.md

# --- partial apply ------------------------------------------------------------------
reflect propose <<<"$PROPOSAL" >/dev/null
applied="$(reflect apply --skip 3)"
assert_contains "$applied" "Applied items 1,2" "apply: partial approval"
assert_contains "$applied" "Applying [1] add personal: Breakers" "apply: shows each item it commits"
assert_contains "$applied" "Applying [2] add thanx: Incident order" "apply: shows rerouted items with their scope"
assert_contains "$applied" "    + Prefer circuit breakers to longer timeouts." "apply: shows the text it commits"
assert_not_contains "$applied" "Deploys" "apply: skipped items are not shown"
wwg="$(cat "$config/WORKING-WITH-GEORGE.md")"
assert_contains "$wwg" $'### Breakers\nas-of: 2026-09-27\n\nPrefer circuit breakers to longer timeouts.' \
  "personal entry written with an as-of date"
assert_not_contains "$wwg" "INC-2291" "leaky item kept out of the personal scope"
mem="$(cat "$memory/MEMORY.md")"
assert_contains "$mem" "### Incident order" "rerouted item written to the thanx scope"
assert_not_contains "$mem" "Argo CD" "skipped item not written"
assert_contains "$(cat "$memory/VOCABULARY.md")" "- Skiffline" "vocabulary recorded in the thanx scope"
msg="$(git -C "$memory" log -1 --format=%B)"
for line in "reflect: approved run 2026-09-27" "Reflect-Run: 20260927-" "Reflected-Through: 2026-09-27" "Approved-Items: 1,2"; do
  assert_contains "$msg" "$line" "thanx commit: $line"
done
assert_eq "$(git -C "$config" log -1 --format='%s|%an')" "reflect: approved run 2026-09-27|Samwise" \
  "personal commit: /reflect subject, fallback identity"
assert_eq "$(git -C "$config" show --name-only --format= HEAD)" "WORKING-WITH-GEORGE.md" "personal commit contains only the wisdom file"
assert_eq "$(git -C "$config" diff --cached --name-only)" "other.txt" "George's staged work is left staged"
assert_eq "$(reflect status --json)" '{"reflectedThrough":"2026-09-27","unreflectedDays":[],"pending":false}' \
  "status: reflected through the latest log"

# --- personal-only apply still records Reflected-Through; retire deletes ------------
count="$(git -C "$memory" rev-list --count HEAD)"
reflect propose <<<'{"items": [{"op": "retire", "target": "P1", "reason": "George marked it wrong"}]}' >/dev/null
reflect apply >/dev/null
assert_eq "$(git -C "$memory" rev-list --count HEAD)" "$((count + 1))" "thanx scope gets a commit even when unchanged"
assert_not_contains "$(cat "$config/WORKING-WITH-GEORGE.md")" "### Breakers" "retire deletes the entry"

# --- the /reflect prompt leaves apply to George -------------------------------------
prompt="$(cat "$REPO/pi/prompts/reflect.md")"
assert_contains "$prompt" '!samwise-reflect apply' "prompt: George applies with a ! command"
assert_contains "$prompt" '!samwise-reflect discard' "prompt: George discards with a ! command"
assert_contains "$prompt" 'never runs `apply`' "prompt: Samwise never applies"
