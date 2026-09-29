#!/usr/bin/env bash
# Sandbox D2: pi-sandbox needs ripgrep (rg) on PATH, and on macOS its runtime
# does not check for it, so install it here. `type -P` finds binaries only: a
# shell function named rg (as on some dev boxes) must not count.
set -euo pipefail

os="$(uname -s)"
if [[ "$os" != Darwin ]]; then
  printf '    Sandbox unsupported on %s: bin/samwise runs here only with SAMWISE_UNSANDBOXED=1 (unfenced).\n' "$os"
  exit 0
fi

type -P rg >/dev/null && exit 0
if ! type -P brew >/dev/null; then
  printf 'bootstrap: ripgrep (rg) is required by the sandbox; install it or Homebrew (https://brew.sh), then re-run\n' >&2
  exit 1
fi
brew install ripgrep
