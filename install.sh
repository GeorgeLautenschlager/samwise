#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
npm ci --prefix "$ROOT"
node "$ROOT/lib/install-helper.js" install "$ROOT"
