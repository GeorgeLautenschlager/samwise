#!/usr/bin/env bash
# Sandbox D8: approvals land in pi/sandbox.json through the agent-dir symlink; report only.
set -euo pipefail

repo="$1"
if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '    NOTE: cannot check sandbox policy drift (%s is not a git checkout)\n' "$repo"
  exit 0
fi
status="$(git -C "$repo" status --porcelain -- pi/sandbox.json)"
[[ -n "$status" ]] || exit 0

printf '    WARNING: uncommitted sandbox policy changes (commit or revert them):\n'
printf '%s\n' "$status" | sed 's/^/    /'
git -C "$repo" --no-pager diff HEAD -- pi/sandbox.json | sed 's/^/    /'
