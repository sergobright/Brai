#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-/srv/opt/node-v22.16.0/bin/node}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
REGISTRY="${BRAI_PREVIEW_REGISTRY:-$ENVS_ROOT/preview-slots.json}"
LOCK="${BRAI_PREVIEW_LOCK:-$ENVS_ROOT/preview-slots.lock}"
COMMAND="${1:-}"

if [ "$COMMAND" = "status" ]; then
  if [ -e "$LOCK" ]; then
    exec 9<"$LOCK"
    flock -s 9
  fi
else
  mkdir -p "$(dirname "$REGISTRY")" "$(dirname "$LOCK")"
  exec 9>"$LOCK"
  flock 9
fi

BRAI_ROOT="$ROOT" "$NODE_BIN" "$SCRIPT_DIR/preview-slots.mjs" "$@"
