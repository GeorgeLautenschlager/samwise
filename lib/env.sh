# shellcheck shell=bash
# Samwise environment: the single source of truth for paths and memory-stack
# settings. Sourced by bin/samwise and bootstrap.sh; never executed directly.

export SAMWISE_HOME="${SAMWISE_HOME:-$HOME/.pi/samwise}"

# Pi: a dedicated agent dir, so Samwise never touches the personal ~/.pi/agent.
export PI_CODING_AGENT_DIR="$SAMWISE_HOME/agent"

# pi-memory: data dir (the thanx scope; T2 repoints it at the thanx-scope repo)
# and per-turn snapshots, which enable qmd selective injection. Trade-off:
# per-turn rebuilds the injected memory block every turn, defeating prompt caching.
export PI_MEMORY_DIR="$SAMWISE_HOME/memory"
export PI_MEMORY_SNAPSHOT="per-turn"

# qmd: keep config and index (which holds memory content) out of ~/.cache/qmd.
export QMD_CONFIG_DIR="$SAMWISE_HOME/qmd"
export INDEX_PATH="$SAMWISE_HOME/qmd/index.sqlite"

# D2: qmd must use its default local models. Drop any override inherited from
# the caller's shell rather than trusting it.
unset QMD_EMBED_MODEL QMD_RERANK_MODEL QMD_GENERATE_MODEL

# Samwise-owned tools (qmd) come first. Guarded so re-sourcing is harmless.
case ":$PATH:" in
  *":$SAMWISE_HOME/tools/bin:"*) ;;
  *) export PATH="$SAMWISE_HOME/tools/bin:$PATH" ;;
esac
