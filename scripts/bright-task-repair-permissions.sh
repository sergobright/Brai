#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
usage: scripts/bright-task-repair-permissions.sh <task-slug-or-worktree-path>

Repairs ownership on one Bright OS task worktree and its matching git metadata.
USAGE
}

TASK="${1:-}"
if [ -z "$TASK" ] || [ "$TASK" = "-h" ] || [ "$TASK" = "--help" ]; then
  usage
  exit 0
fi

ROOT="${BRIGHT_OS_ROOT:-/srv/projects/bright-os}"
WORKTREES="${BRIGHT_OS_WORKTREE_ROOT:-$ROOT/.codex-worktrees}"
OWNER="${BRIGHT_OS_TASK_OWNER:-mark:mark}"

if [ ! -d "$ROOT/.git/worktrees" ]; then
  echo "Bright OS git worktree metadata directory is missing: $ROOT/.git/worktrees" >&2
  exit 1
fi
if [ ! -d "$WORKTREES" ]; then
  echo "Bright OS task worktree root is missing: $WORKTREES" >&2
  exit 1
fi

case "$TASK" in
  /*) TARGET="$TASK" ;;
  *) TARGET="$WORKTREES/$TASK" ;;
esac

if [ -L "$TARGET" ] || [ ! -d "$TARGET" ]; then
  echo "Task worktree must be an existing non-symlink directory: $TARGET" >&2
  exit 1
fi

WORKTREES_REAL="$(cd "$WORKTREES" && pwd -P)"
TARGET_REAL="$(cd "$TARGET" && pwd -P)"
case "$TARGET_REAL" in
  "$WORKTREES_REAL"/*) ;;
  *)
    echo "Refusing to repair path outside $WORKTREES_REAL: $TARGET_REAL" >&2
    exit 1
    ;;
esac

GIT_FILE="$TARGET_REAL/.git"
if [ -L "$GIT_FILE" ] || [ ! -f "$GIT_FILE" ]; then
  echo "Task worktree .git file is missing or unsafe: $GIT_FILE" >&2
  exit 1
fi

GIT_DIR="$(sed -n 's/^gitdir: //p' "$GIT_FILE" | head -n 1)"
if [ -z "$GIT_DIR" ]; then
  echo "Cannot read gitdir from $GIT_FILE" >&2
  exit 1
fi
case "$GIT_DIR" in
  /*) ;;
  *) GIT_DIR="$TARGET_REAL/$GIT_DIR" ;;
esac
if [ -L "$GIT_DIR" ] || [ ! -d "$GIT_DIR" ]; then
  echo "Task git metadata must be an existing non-symlink directory: $GIT_DIR" >&2
  exit 1
fi

GIT_WORKTREES_REAL="$(cd "$ROOT/.git/worktrees" && pwd -P)"
GIT_DIR_REAL="$(cd "$GIT_DIR" && pwd -P)"
case "$GIT_DIR_REAL" in
  "$GIT_WORKTREES_REAL"/*) ;;
  *)
    echo "Refusing to repair git metadata outside $GIT_WORKTREES_REAL: $GIT_DIR_REAL" >&2
    exit 1
    ;;
esac

sudo chown -R "$OWNER" "$TARGET_REAL" "$GIT_DIR_REAL"
sudo chmod -R u=rwX,g=rwX,o= "$TARGET_REAL" "$GIT_DIR_REAL"

TASK_STATE="$TARGET_REAL/.bright-task"
if [ -d "$TASK_STATE" ] && [ ! -L "$TASK_STATE" ]; then
  sudo chmod 0770 "$TASK_STATE"
  sudo find "$TASK_STATE" -maxdepth 1 -type f -name '*.json' -exec chmod 0640 {} +
fi

echo "Repaired task worktree permissions: $TARGET_REAL"
