#!/usr/bin/env bash
# Unit tests for bin/samwise, using a stub `pi` that echoes its environment
# and a stub `uname` to simulate Linux or macOS.
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
printf '#!/usr/bin/env bash\necho Linux\n' >"$tmp/stub/uname"
chmod +x "$tmp/stub/uname"

# Every launch here is on Linux, where the fence is unsupported: opt in.
export SAMWISE_UNSANDBOXED=1

out="$(SAMWISE_HOME="$tmp/home" PATH="$tmp/stub:$PATH" "$REPO/bin/samwise" --model x "hello world" 2>/dev/null)"
assert_eq "$out" "$tmp/home/agent|per-turn|--no-sandbox --model x hello world" \
  "launcher exports env and passes args to pi"

# Launching through a symlink (e.g. ~/bin/samwise) must still find lib/env.sh.
ln -s "$REPO/bin/samwise" "$tmp/links/samwise"
out="$(SAMWISE_HOME="$tmp/home" PATH="$tmp/stub:$PATH" "$tmp/links/samwise" 2>/dev/null)"
assert_eq "$out" "$tmp/home/agent|per-turn|--no-sandbox" "launcher works through a symlink"

# The launcher puts the repo's bin/ on PATH, so Samwise can run samwise-reflect.
mkdir -p "$tmp/stub2"
printf '#!/usr/bin/env bash\necho Linux\n' >"$tmp/stub2/uname"
chmod +x "$tmp/stub2/uname"
cat >"$tmp/stub2/pi" <<'EOF'
#!/usr/bin/env bash
command -v samwise-reflect
EOF
chmod +x "$tmp/stub2/pi"
out="$(SAMWISE_HOME="$tmp/home" PATH="$tmp/stub2:$PATH" "$REPO/bin/samwise" 2>/dev/null)"
assert_eq "$out" "$REPO/bin/samwise-reflect" "launcher puts samwise-reflect on PATH"

# --- execution fence (sandbox D7) --------------------------------------------

# launch <expected-exit|any> <env...> -- <args...>: run the launcher with the
# echo stub; sets $out (stdout+stderr) and fails if the exit code differs.
launch() {
  local want="$1" envs=() code=0
  shift
  while [[ "$1" != -- ]]; do envs+=("$1"); shift; done
  shift
  out="$(env ${envs[@]+"${envs[@]}"} SAMWISE_HOME="$tmp/home" PATH="$tmp/stub:$PATH" "$REPO/bin/samwise" "$@" 2>&1)" || code=$?
  [[ "$want" == any || "$code" == "$want" ]] || fail "expected exit $want, got $code: $out"
}

launch 2 -- --model x --no-sandbox "hi"
assert_contains "$out" "--no-sandbox is not allowed" "--no-sandbox is refused (AC3)"
assert_not_contains "$out" "per-turn" "pi is not started when --no-sandbox is passed"

launch 2 -- --no-sandbox=false "hi"
assert_contains "$out" "--no-sandbox is not allowed" "--no-sandbox=<value> is refused too (pi treats it as --no-sandbox)"
assert_not_contains "$out" "per-turn" "pi is not started when --no-sandbox=<value> is passed"

launch 2 -u SAMWISE_UNSANDBOXED -- "hi"
assert_contains "$out" "only runs on macOS" "non-macOS without the opt-in is refused"
assert_not_contains "$out" "per-turn" "pi is not started without the opt-in"

launch 0 -- "hi"
assert_contains "$out" "WARNING: running WITHOUT the sandbox" "the opt-in warns loudly"
assert_contains "$out" "|per-turn|--no-sandbox hi" "the opt-in starts pi with the sandbox off"

# macOS, simulated with a uname stub first on PATH.
mkdir -p "$tmp/darwin"
printf '#!/usr/bin/env bash\necho Darwin\n' >"$tmp/darwin/uname"
chmod +x "$tmp/darwin/uname"

# launch_darwin <expected-exit> <args...>: launch as macOS with home $tmp/mac
# from the current directory; SAMWISE_UNSANDBOXED stays as the caller set it.
launch_darwin() {
  local want="$1" code=0
  shift
  out="$(SAMWISE_HOME="$tmp/mac" PATH="$tmp/darwin:$tmp/stub:$PATH" "$REPO/bin/samwise" "$@" 2>&1)" || code=$?
  [[ "$code" == "$want" ]] || fail "expected exit $want, got $code: $out"
}

launch_darwin 2 "hi" # SAMWISE_UNSANDBOXED=1 is still exported
assert_contains "$out" "SAMWISE_UNSANDBOXED is not honoured on macOS" "macOS refuses the opt-out"
assert_not_contains "$out" "per-turn" "pi is not started on macOS with the opt-out set"

unset SAMWISE_UNSANDBOXED

launch_darwin 2 "hi"
assert_contains "$out" "sandbox preflight failed" "macOS with a failing preflight is refused"
assert_contains "$out" "sandbox.json is missing" "the preflight's problems are shown"
assert_not_contains "$out" "per-turn" "pi is not started when the preflight fails"

# A home that passes the preflight: linked policy, pinned pi-sandbox, a
# runtime reporting no missing dependencies.
pin="$(node -p 'require(process.argv[1]).packages.find((p) => p.startsWith("npm:pi-sandbox@")).split("@")[1]' "$REPO/pi/settings.json")"
mods="$tmp/mac/agent/npm/node_modules"
mkdir -p "$mods/pi-sandbox" "$mods/@carderne/sandbox-runtime"
ln -s "$REPO/pi/sandbox.json" "$tmp/mac/agent/sandbox.json"
printf '{"name":"pi-sandbox","version":"%s"}' "$pin" >"$mods/pi-sandbox/package.json"
printf '{"name":"@carderne/sandbox-runtime","version":"0.0.72","type":"module","main":"./index.js"}' \
  >"$mods/@carderne/sandbox-runtime/package.json"
echo 'export const SandboxManager = { checkDependencies: () => ({ errors: [], warnings: [] }) };' \
  >"$mods/@carderne/sandbox-runtime/index.js"

pushd "$tmp" >/dev/null # a launch dir without .pi/sandbox.json
launch_darwin 0 --model x "hi"
popd >/dev/null
assert_eq "$out" "$tmp/mac/agent|per-turn|--model x hi" "macOS with a passing preflight starts pi with the sandbox on"

mkdir -p "$tmp/project/.pi"
echo '{"enabled": false}' >"$tmp/project/.pi/sandbox.json"
pushd "$tmp/project" >/dev/null
launch_darwin 2 "hi"
popd >/dev/null
assert_contains "$out" ".pi/sandbox.json exists" "a project .pi/sandbox.json stops the launch"
