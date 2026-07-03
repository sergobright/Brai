#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
usage: scripts/brai-task-repair-permissions.sh [--workspace] <task-slug-or-worktree-path>

Repairs ownership on one Brai task worktree and its matching git metadata.
With --workspace, only repairs task state plus allowlisted ignored/cache/output dirs.
USAGE
}

WORKSPACE_ONLY=0
if [ "${1:-}" = "--workspace" ]; then
  WORKSPACE_ONLY=1
  shift
fi

TASK="${1:-}"
if [ -z "$TASK" ] || [ "$TASK" = "-h" ] || [ "$TASK" = "--help" ]; then
  usage
  exit 0
fi

ROOT="${BRAI_ROOT:-/srv/projects/brai}"
WORKTREES="${BRAI_WORKTREE_ROOT:-$ROOT/.codex-worktrees}"
OWNER="${BRAI_TASK_OWNER:-mark:mark}"

if [ ! -d "$ROOT/.git/worktrees" ]; then
  echo "Brai git worktree metadata directory is missing: $ROOT/.git/worktrees" >&2
  exit 1
fi
if [ ! -d "$WORKTREES" ]; then
  echo "Brai task worktree root is missing: $WORKTREES" >&2
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
ROOT_REAL="$(cd "$ROOT" && pwd -P)"
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

repair_workspace_dir() {
  local relative_path="$1"
  local target_path="$TARGET_REAL/$relative_path"
  local real_path

  if [ ! -e "$target_path" ] && [ ! -L "$target_path" ]; then
    return 0
  fi
  if [ ! -d "$target_path" ]; then
    echo "Refusing to repair non-directory workspace path: $target_path" >&2
    exit 1
  fi

  real_path="$(cd "$target_path" && pwd -P)"
  case "$real_path" in
    "$ROOT_REAL"|"$ROOT_REAL"/*) ;;
    *)
      echo "Refusing to repair workspace path outside $ROOT_REAL: $real_path" >&2
      exit 1
      ;;
  esac

  sudo chown -R "$OWNER" "$real_path"
  sudo chmod -R u=rwX,g=rwX,o= "$real_path"
}

repair_task_state() {
  local task_state="$TARGET_REAL/.brai-task"
  if [ -d "$task_state" ] && [ ! -L "$task_state" ]; then
    sudo chown -R "$OWNER" "$task_state"
    sudo chmod 0770 "$task_state"
    sudo find "$task_state" -maxdepth 1 -type f -name '*.json' -exec chmod 0640 {} +
  fi
}

if [ "$WORKSPACE_ONLY" -eq 1 ]; then
  sudo chown "$OWNER" "$TARGET_REAL" "$GIT_FILE" "$GIT_DIR_REAL"
  sudo chmod u=rwx,g=rx,o= "$TARGET_REAL"
  sudo chmod 0640 "$GIT_FILE"
  sudo chown -R "$OWNER" "$GIT_DIR_REAL"
  sudo chmod -R u=rwX,g=rwX,o= "$GIT_DIR_REAL"

  for relative_path in \
    ".brai-task" \
    "node_modules" \
    "apps/brai_app/node_modules" \
    "services/brai_api/node_modules" \
    "services/brai_temporal/node_modules" \
    ".vite-temp" \
    ".next" \
    "out" \
    "output" \
    "output/playwright" \
    "test-results" \
    "landing" \
    "apps/brai_app/.next" \
    "apps/brai_app/out" \
    "apps/brai_app/output" \
    "apps/brai_app/output/playwright" \
    "apps/brai_app/test-results" \
    "apps/brai_app/node_modules/@capacitor/android/capacitor/build" \
    "apps/brai_app/android/.gradle"
  do
    repair_workspace_dir "$relative_path"
  done

  for build_dir in "$TARGET_REAL"/apps/brai_app/android/*/build; do
    [ -d "$build_dir" ] || continue
    repair_workspace_dir "${build_dir#"$TARGET_REAL/"}"
  done

  repair_task_state
  echo "Repaired workspace permissions: $TARGET_REAL"
  exit 0
fi

sudo chown -R "$OWNER" "$TARGET_REAL" "$GIT_DIR_REAL"
sudo chmod -R u=rwX,g=rwX,o= "$TARGET_REAL" "$GIT_DIR_REAL"

repair_task_state

echo "Repaired task worktree permissions: $TARGET_REAL"
