#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_TASK="$ROOT/scripts/bright-task.mjs"
INSTALLED_TASK="${BRIGHT_OS_INSTALLED_GUARD_TASK:-/srv/opt/bright-os-codex-plugins/plugins/bright-os-guard/hooks/bright-task.mjs}"

case "${1:---check}" in
  --check)
    if cmp -s "$REPO_TASK" "$INSTALLED_TASK"; then
      echo "Bright OS installed guard is in sync."
      exit 0
    fi
    echo "Bright OS installed guard is out of sync: $INSTALLED_TASK" >&2
    echo "Run with escalation: scripts/bright-guard-sync-check.sh --install" >&2
    exit 1
    ;;
  --install)
    install -m 0755 "$REPO_TASK" "$INSTALLED_TASK"
    echo "Synced Bright OS installed guard: $INSTALLED_TASK"
    ;;
  *)
    echo "usage: scripts/bright-guard-sync-check.sh [--check|--install]" >&2
    exit 2
    ;;
esac
