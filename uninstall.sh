#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$ROOT/lib/install-helper.js" uninstall "$ROOT"
