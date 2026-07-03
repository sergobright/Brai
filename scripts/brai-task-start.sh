#!/usr/bin/env bash
set -euo pipefail

TASK="${1:-}"

/srv/opt/node-v22.16.0/bin/node /srv/opt/brai-codex-plugins/plugins/brai-guard/hooks/brai-guard.mjs start "$@"

if [ -n "$TASK" ] && [ "${TASK#-}" = "$TASK" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
  WORKTREES="${BRAI_WORKTREE_ROOT:-$ROOT/.codex-worktrees}"
  case "$TASK" in
    /*) TARGET="$TASK" ;;
    *) TARGET="$WORKTREES/$TASK" ;;
  esac

  "$SCRIPT_DIR/brai-task-repair-permissions.sh" "$TASK"
  cd "$TARGET"
  /srv/opt/node-v22.16.0/bin/node "$SCRIPT_DIR/brai-task.mjs" preflight --strict
fi
