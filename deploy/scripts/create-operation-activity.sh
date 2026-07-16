#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Deprecated: create-operation-activity.sh now creates an Inbox operation; use create-inbox-operation.sh." >&2
exec "$SCRIPT_DIR/create-inbox-operation.sh" "$@"
