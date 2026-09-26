#!/usr/bin/env bash
# Run every test/*.test.sh. SKIP_INTEGRATION=1 skips the slow bootstrap test.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for t in "$REPO"/test/*.test.sh; do
  if [[ "${SKIP_INTEGRATION:-}" == 1 && "$(basename "$t")" == bootstrap.test.sh ]]; then
    echo "--- skipping $(basename "$t")"
    continue
  fi
  echo "--- $(basename "$t")"
  bash "$t"
done
echo "all tests passed"
