#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/use-node22.sh" node "$SCRIPT_DIR/bright-task.mjs" preview "$@"
