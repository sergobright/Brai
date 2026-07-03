#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
repo_parent="$(dirname "$repo_root")"
if [ "$(basename "$repo_parent")" = ".codex-worktrees" ]; then
  root="$(dirname "$repo_parent")"
elif [ "$(basename "$repo_parent")" = "brai-worktrees" ] && [ -d "$(dirname "$repo_parent")/brai/.git" ]; then
  root="$(dirname "$repo_parent")/brai"
else
  root="$repo_root"
fi
worktrees="$root/.codex-worktrees"
current_worktree="$repo_root"
runtime_paths=(
  "$root/data"
  "$root/deploy/site"
  "$root/deploy/web"
  "$root/deploy/mobile-update"
  "$root/deploy/releases"
)
source_group="${BRAI_MAIN_SOURCE_GROUP:-mark}"
if ! getent group "$source_group" >/dev/null 2>&1; then
  source_group="mark"
fi

restore_task_state_access() {
  local task_state="$1/.brai-task"
  if [ ! -d "$task_state" ] || [ -L "$task_state" ]; then
    return
  fi
  sudo chown mark:mark "$task_state"
  sudo chmod 0770 "$task_state"
  sudo find "$task_state" -maxdepth 1 -type f -name '*.json' -exec chown mark:mark {} +
  sudo find "$task_state" -maxdepth 1 -type f -name '*.json' -exec chmod 0640 {} +
}

mkdir -p "$worktrees"

sudo chown "root:$source_group" "$root"
sudo chmod 0751 "$root"

sudo chown -R mark:mark "$root/.git"
sudo chown mark:mark "$worktrees"
sudo chmod 0700 "$worktrees"

if ! git config --global --get-all safe.directory | grep -Fxq "$root"; then
  git config --global --add safe.directory "$root"
fi

sudo find "$root" \
  -path "$root/.git" -prune -o \
  -path "$worktrees" -prune -o \
  -path "$root/data" -prune -o \
  -path "$root/deploy/site" -prune -o \
  -path "$root/deploy/web" -prune -o \
  -path "$root/deploy/mobile-update" -prune -o \
  -path "$root/deploy/releases" -prune -o \
  -exec chown "root:$source_group" {} +

sudo find "$root" \
  -path "$root/.git" -prune -o \
  -path "$worktrees" -prune -o \
  -path "$root/data" -prune -o \
  -path "$root/deploy/site" -prune -o \
  -path "$root/deploy/web" -prune -o \
  -path "$root/deploy/mobile-update" -prune -o \
  -path "$root/deploy/releases" -prune -o \
  -exec chmod u=rwX,g=rX,o= {} +

sudo chmod 0751 "$root"
if [ -d "$root/deploy" ]; then
  sudo chmod u=rwx,g=rx,o=x "$root/deploy"
fi

if getent group brai-deploy >/dev/null 2>&1; then
  for runtime_path in "${runtime_paths[@]}"; do
    if [ -d "$runtime_path" ]; then
      sudo chgrp -R brai-deploy "$runtime_path"
      sudo chmod -R u=rwX,g=rwX,o=rX "$runtime_path"
      sudo find "$runtime_path" -type d -exec chmod g+s {} +
    fi
  done
  maintenance_tool="$root/deploy/scripts/production-sqlite-maintenance.sh"
  if [ -f "$maintenance_tool" ]; then
    sudo chmod u=rwx,g=rx,o=x "$root/deploy/scripts"
    sudo chgrp brai-deploy "$maintenance_tool"
    sudo chmod u=rwx,g=rx,o= "$maintenance_tool"
  fi
fi

if [ "${BRAI_LOCK_STALE_WORKTREES:-1}" = "1" ]; then
while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      worktree_path="${line#worktree }"
      if [ "$worktree_path" = "$root" ]; then
        continue
      fi
      if [ "${BRAI_LOCK_CURRENT_WORKTREE:-0}" != "1" ] && [ "$worktree_path" = "$current_worktree" ]; then
        continue
      fi
      if [ -d "$worktree_path" ]; then
        sudo chown -R root:mark "$worktree_path"
        sudo chmod -R u=rwX,g=rX,o= "$worktree_path"
        restore_task_state_access "$worktree_path"
      fi
      ;;
  esac
done < <(git -C "$root" worktree list --porcelain)
fi

echo "Locked $root source files read-only for non-root writes."
echo "Writable task worktree parent: $worktrees"
