#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
repo_parent="$(dirname "$repo_root")"
if [ "$(basename "$repo_parent")" = ".codex-worktrees" ]; then
  root="$(dirname "$repo_parent")"
elif [ "$(basename "$repo_parent")" = "bright-os-worktrees" ] && [ -d "$(dirname "$repo_parent")/bright-os/.git" ]; then
  root="$(dirname "$repo_parent")/bright-os"
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

mkdir -p "$worktrees"

sudo chown root:mark "$root"
sudo chmod 0751 "$root"

sudo chown -R mark:mark "$root/.git" "$worktrees"
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
  -exec chown root:mark {} +

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

if getent group bright-deploy >/dev/null 2>&1; then
  for runtime_path in "${runtime_paths[@]}"; do
    if [ -d "$runtime_path" ]; then
      sudo chgrp -R bright-deploy "$runtime_path"
      sudo chmod -R u=rwX,g=rwX,o=rX "$runtime_path"
      sudo find "$runtime_path" -type d -exec chmod g+s {} +
    fi
  done
fi

if [ "${BRIGHT_OS_LOCK_STALE_WORKTREES:-0}" = "1" ]; then
while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      worktree_path="${line#worktree }"
      if [ "$worktree_path" = "$root" ]; then
        continue
      fi
      if [ "${BRIGHT_OS_LOCK_CURRENT_WORKTREE:-0}" != "1" ] && [ "$worktree_path" = "$current_worktree" ]; then
        continue
      fi
      if [ -d "$worktree_path" ]; then
        sudo chown -R root:mark "$worktree_path"
        sudo chmod -R u=rwX,g=rX,o= "$worktree_path"
      fi
      ;;
  esac
done < <(git -C "$root" worktree list --porcelain)
fi

echo "Locked $root source files read-only for non-root writes."
echo "Writable task worktree parent: $worktrees"
