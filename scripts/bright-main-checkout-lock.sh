#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
repo_parent="$(dirname "$repo_root")"
if [ "$(basename "$repo_parent")" = ".codex-worktrees" ]; then
  root="$(dirname "$repo_parent")"
else
  root="$repo_root"
fi
worktrees="$root/.codex-worktrees"

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

echo "Locked $root read-only for non-root writes; task worktrees stay writable under $worktrees."
