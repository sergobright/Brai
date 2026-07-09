#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_PREFIX="${BRAI_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
NODE_BIN="$NODE_PREFIX/node"

if [[ -x "$NODE_BIN" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
elif [[ "${CI:-}" == "true" ]] && command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  echo "Missing Brai Node runtime at $NODE_PREFIX/node" >&2
  exit 1
fi

"$NODE_BIN" "$ROOT/scripts/require-node22.mjs"
exec "$@"
