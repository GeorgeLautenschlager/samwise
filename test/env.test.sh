#!/usr/bin/env bash
# Unit tests for lib/env.sh.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

# Source env.sh in a scrubbed environment and print the resulting env.
# Extra VAR=value arguments are added to the starting environment.
env_after_source() {
  env -i HOME=/home/test PATH=/usr/bin:/bin "$@" \
    bash -c "source '$REPO/lib/env.sh'; source '$REPO/lib/env.sh'; env"
}

get() { grep "^$1=" <<<"$out" | cut -d= -f2- || true; }

out="$(env_after_source QMD_EMBED_MODEL=hf:x/y/z.gguf QMD_RERANK_MODEL=a QMD_GENERATE_MODEL=b)"

assert_eq "$(get SAMWISE_HOME)" "/home/test/.pi/samwise" "SAMWISE_HOME defaults under ~/.pi"
assert_eq "$(get PI_CODING_AGENT_DIR)" "/home/test/.pi/samwise/agent" "dedicated Pi agent dir"
assert_eq "$(get PI_MEMORY_DIR)" "/home/test/.pi/samwise/memory" "pi-memory data dir"
assert_eq "$(get PI_MEMORY_SNAPSHOT)" "per-turn" "per-turn snapshots enable selective injection"
assert_eq "$(get QMD_CONFIG_DIR)" "/home/test/.pi/samwise/qmd" "qmd config isolated"
assert_eq "$(get INDEX_PATH)" "/home/test/.pi/samwise/qmd/index.sqlite" "qmd index isolated"
assert_eq "$(get PATH)" "/home/test/.pi/samwise/tools/bin:/usr/bin:/bin" "tools/bin prepended exactly once"
assert_eq "$(get QMD_EMBED_MODEL)" "" "inherited QMD_EMBED_MODEL is unset"
assert_eq "$(get QMD_RERANK_MODEL)" "" "inherited QMD_RERANK_MODEL is unset"
assert_eq "$(get QMD_GENERATE_MODEL)" "" "inherited QMD_GENERATE_MODEL is unset"

out="$(env_after_source SAMWISE_HOME=/srv/sam)"
assert_eq "$(get PI_CODING_AGENT_DIR)" "/srv/sam/agent" "SAMWISE_HOME override is respected"
