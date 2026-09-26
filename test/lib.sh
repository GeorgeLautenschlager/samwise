# shellcheck shell=bash
# Minimal assertion helpers for the bash test scripts. Source, don't execute.

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$*"; }

# assert_eq <actual> <expected> <description>
assert_eq() {
  [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"
  pass "$3"
}

# assert_contains <haystack> <needle> <description>
assert_contains() {
  [[ "$1" == *"$2"* ]] || fail "$3: '$2' not found in: $1"
  pass "$3"
}

# assert_not_contains <haystack> <needle> <description>
assert_not_contains() {
  [[ "$1" != *"$2"* ]] || fail "$3: unexpected '$2' in: $1"
  pass "$3"
}
