#!/usr/bin/env bash
set -euo pipefail

REPO_TASK="${BRAI_GUARD_SOURCE_TASK:-/srv/projects/brai/scripts/brai-task.mjs}"
INSTALLED_TASK="${BRAI_INSTALLED_GUARD_TASK:-/srv/opt/brai-codex-plugins/plugins/brai-guard/hooks/brai-task.mjs}"

if [[ ! -f "$REPO_TASK" ]]; then
  echo "Canonical Brai guard source is missing: $REPO_TASK" >&2
  exit 1
fi

case "${1:---check}" in
  --check)
    if cmp -s "$REPO_TASK" "$INSTALLED_TASK"; then
      echo "Brai installed guard is in sync."
      exit 0
    fi
    echo "Brai installed guard is out of sync: $INSTALLED_TASK" >&2
    echo "Run with escalation: scripts/brai-guard-sync-check.sh --install" >&2
    exit 1
    ;;
  --install)
    install -m 0755 "$REPO_TASK" "$INSTALLED_TASK"
    echo "Synced Brai installed guard: $INSTALLED_TASK"
    ;;
  *)
    echo "usage: scripts/brai-guard-sync-check.sh [--check|--install]" >&2
    exit 2
    ;;
esac
