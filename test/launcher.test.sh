#!/usr/bin/env bash
# Unit tests for bin/samwise, using a stub `pi` that echoes its environment.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/stub" "$tmp/links"
cat >"$tmp/stub/pi" <<'EOF'
#!/usr/bin/env bash
echo "$PI_CODING_AGENT_DIR|$PI_MEMORY_SNAPSHOT|$*"
EOF
chmod +x "$tmp/stub/pi"

out="$(SAMWISE_HOME="$tmp/home" PATH="$tmp/stub:$PATH" "$REPO/bin/samwise" --model x "hello world")"
assert_eq "$out" "$tmp/home/agent|per-turn|--model x hello world" "launcher exports env and passes args to pi"

# Launching through a symlink (e.g. ~/bin/samwise) must still find lib/env.sh.
ln -s "$REPO/bin/samwise" "$tmp/links/samwise"
out="$(SAMWISE_HOME="$tmp/home" PATH="$tmp/stub:$PATH" "$tmp/links/samwise")"
assert_eq "$out" "$tmp/home/agent|per-turn|" "launcher works through a symlink"

# The launcher puts the repo's bin/ on PATH, so Samwise can run samwise-reflect.
mkdir -p "$tmp/stub2"
cat >"$tmp/stub2/pi" <<'EOF'
#!/usr/bin/env bash
command -v samwise-reflect
EOF
chmod +x "$tmp/stub2/pi"
out="$(SAMWISE_HOME="$tmp/home" PATH="$tmp/stub2:$PATH" "$REPO/bin/samwise")"
assert_eq "$out" "$REPO/bin/samwise-reflect" "launcher puts samwise-reflect on PATH"
