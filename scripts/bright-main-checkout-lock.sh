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

mkdir -p "$worktrees"

sudo chown root:mark "$root"
sudo chmod 0750 "$root"

sudo chown -R mark:mark "$root/.git" "$worktrees"
sudo chmod 0700 "$worktrees"

if ! git config --global --get-all safe.directory | grep -Fxq "$root"; then
  git config --global --add safe.directory "$root"
fi

sudo find "$root" \
  -path "$root/.git" -prune -o \
  -path "$worktrees" -prune -o \
  -exec chown root:mark {} +

sudo find "$root" \
  -path "$root/.git" -prune -o \
  -path "$worktrees" -prune -o \
  -exec chmod u=rwX,g=rX,o= {} +

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

echo "Locked $root read-only for non-root writes; stale registered worktrees are read-only too."
echo "Writable task worktree parent: $worktrees"
