#!/usr/bin/env bash
# Checks the memory contract (pi/AGENTS.md) covers issue #4 items 1-6, has no
# filesystem paths, and stays within its size budget (it loads every session).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

contract="$REPO/pi/AGENTS.md"
c="$(cat "$contract")"

# 1. Layer routing and precedence
for phrase in "Keystone (MCP)" "memory_search" 'mode `semantic`' "memory_read" "WORKING-WITH-GEORGE.md" "Skills" "Keystone first" "Keystone wins"; do
  assert_contains "$c" "$phrase" "routing: $phrase"
done

# 2. Keystone pointer rule (D6)
for phrase in "keystone:<id or URL>" "more than one line"; do
  assert_contains "$c" "$phrase" "pointer rule: $phrase"
done

# 3. Scope rules (D5)
for phrase in "internal system" "customers" "people" "incidents" "code" "metrics" "When unsure"; do
  assert_contains "$c" "$phrase" "scope rule: $phrase"
done

# 4. Daily-log entry format (D7)
for phrase in "#problem [[" "- Tried:" "- Worked:" "- Pointers:" 'target `daily`'; do
  assert_contains "$c" "$phrase" "daily-log template: $phrase"
done

# 5. Wisdom write rule (D8)
for phrase in "long_term" "/reflect"; do
  assert_contains "$c" "$phrase" "wisdom rule: $phrase"
done

# 6. No filesystem paths: memory is reached through tools, so gondolin (T8) can't break it
for path in "~/" "/memory" ".pi/" '$HOME'; do
  assert_not_contains "$c" "$path" "no path: $path"
done

size="$(wc -c <"$contract")"
(( size <= 4000 )) || fail "contract is $size bytes; budget is 4000"
pass "contract within the 4000-byte budget ($((size)) bytes)"
