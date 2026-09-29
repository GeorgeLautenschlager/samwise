#!/usr/bin/env bash
# Sandbox D8: approvals land in pi/sandbox.json through the agent-dir symlink; report only.
set -euo pipefail

repo="$1"
status="$(git -C "$repo" status --porcelain -- pi/sandbox.json)"
[[ -n "$status" ]] || exit 0

printf '    WARNING: uncommitted sandbox policy changes (commit or revert them):\n'
printf '%s\n' "$status" | sed 's/^/    /'
git -C "$repo" --no-pager diff HEAD -- pi/sandbox.json | sed 's/^/    /'
