#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_TOOL_DIR="$ROOT/tools/log4brains"
TOOL_DIR="$SOURCE_TOOL_DIR"
if [[ ! -w "$TOOL_DIR" || ( -e "$TOOL_DIR/node_modules" && ! -w "$TOOL_DIR/node_modules" ) ]]; then
  TOOL_DIR="${XDG_CACHE_HOME:-${TMPDIR:-/tmp}}/brai-log4brains-tool-${UID}"
  mkdir -p "$TOOL_DIR"
  cp "$SOURCE_TOOL_DIR/package.json" "$SOURCE_TOOL_DIR/package-lock.json" "$TOOL_DIR/"
fi
BIN="$TOOL_DIR/node_modules/.bin/log4brains"

if [[ ! -x "$BIN" || "$TOOL_DIR/package-lock.json" -nt "$TOOL_DIR/node_modules/.package-lock.json" ]]; then
  "$ROOT/scripts/use-node22.sh" npm --prefix "$TOOL_DIR" ci
fi

exec "$ROOT/scripts/use-node22.sh" npm --prefix "$TOOL_DIR" exec -- log4brains "$@"
