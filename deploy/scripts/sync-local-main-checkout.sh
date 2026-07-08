#!/usr/bin/env bash
set -euo pipefail

BRANCH="${BRAI_MAIN_BRANCH:-main}"
EXPECTED_COMMIT="${1:-${BRAI_COMMIT:-}}"
REPO="/srv/projects/brai"
REMOTE_URL="${BRAI_MAIN_REMOTE_URL:-git@github.com:sergobright/Brai.git}"
NODE_BIN="${NODE_BIN:-node}"
GIT_USER="${BRAI_MAIN_GIT_USER:-mark}"
SOURCE_GROUP="${BRAI_MAIN_SOURCE_GROUP:-mark}"
RESCUE_ROOT="${BRAI_MAIN_RESCUE_ROOT:-/srv/projects/brai-rescue}"
LOCK_FILE="${BRAI_MAIN_SYNC_LOCK:-/tmp/brai-main-checkout-sync.lock}"
API_ENV_FILE="${BRAI_API_ENV_FILE:-/etc/brai/brai-api.env}"

PRUNE_MODE=0
PRUNE_ACCEPTED_BRANCHES=()
if [ "${1:-}" = "--prune-accepted-branches" ]; then
  PRUNE_MODE=1
  shift
  PRUNE_ACCEPTED_BRANCHES=("$@")
  EXPECTED_COMMIT=""
elif [ "$#" -gt 1 ]; then
  echo "Usage: $0 [expected-main-commit] | $0 --prune-accepted-branches codex/<branch>..." >&2
  exit 1
fi

case "$EXPECTED_COMMIT" in
  "" | [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *)
    echo "Expected commit must be a full 40-char lowercase sha, got: $EXPECTED_COMMIT" >&2
    exit 1
    ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "Brai main sync must run as root." >&2
  exit 1
fi

if ! id "$GIT_USER" >/dev/null 2>&1; then
  echo "Git user does not exist: $GIT_USER" >&2
  exit 1
fi
if ! getent group "$SOURCE_GROUP" >/dev/null 2>&1; then
  SOURCE_GROUP="mark"
fi

git_cmd() {
  runuser -u "$GIT_USER" -- env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git \
    -C "$REPO" \
    -c safe.directory="$REPO" \
    -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false \
    -c protocol.file.allow=never \
    -c protocol.ext.allow=never \
    "$@"
}

git_root_cmd() {
  git \
    -C "$REPO" \
    -c safe.directory="$REPO" \
    -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false \
    -c protocol.file.allow=never \
    -c protocol.ext.allow=never \
    "$@"
}

git_root_at() {
  local path="$1"
  shift
  git \
    -C "$path" \
    -c safe.directory="$path" \
    -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false \
    -c protocol.file.allow=never \
    -c protocol.ext.allow=never \
    "$@"
}

record_runtime_log() {
  local source="$1"
  local operation="$2"
  local status="$3"
  local message="$4"
  local json="$5"
  command -v "$NODE_BIN" >/dev/null 2>&1 || return 0
  if [ -z "${BRAI_DATABASE_URL:-}" ] && [ -r "$API_ENV_FILE" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$API_ENV_FILE"
    set +a
  fi
  "$NODE_BIN" "$REPO/deploy/scripts/record-runtime-log.mjs" \
    --source "$source" \
    --operation "$operation" \
    --status "$status" \
    --message "$message" \
    --json "$json" >/dev/null 2>&1 || true
}

prune_accepted_branches() {
  local branch line worktree_path current_path current_branch status
  for branch in "$@"; do
    if [[ ! "$branch" =~ ^codex/[A-Za-z0-9._-]+$ ]]; then
      echo "Skipping invalid accepted branch cleanup target: $branch" >&2
      continue
    fi
    worktree_path=""
    current_path=""
    current_branch=""
    while IFS= read -r line; do
      case "$line" in
        "worktree "*)
          if [ "$current_branch" = "$branch" ]; then
            worktree_path="$current_path"
            break
          fi
          current_path="${line#worktree }"
          current_branch=""
          ;;
        "branch refs/heads/"*)
          current_branch="${line#branch refs/heads/}"
          ;;
      esac
    done < <(git_root_cmd worktree list --porcelain)
    if [ -z "$worktree_path" ] && [ "$current_branch" = "$branch" ]; then
      worktree_path="$current_path"
    fi

    if [ -z "$worktree_path" ]; then
      echo "Skipping $branch: no registered local worktree."
      continue
    fi
    case "$worktree_path" in
      "$REPO/.codex-worktrees/"*) ;;
      *)
        echo "Skipping $branch: worktree path is outside .codex-worktrees: $worktree_path" >&2
        continue
        ;;
    esac
    if [ ! -d "$worktree_path" ]; then
      echo "Skipping $branch: worktree path is missing: $worktree_path" >&2
      continue
    fi
    status="$(git_root_at "$worktree_path" status --porcelain)"
    if [ -n "$status" ]; then
      echo "Skipping $branch: local worktree is dirty." >&2
      continue
    fi

    git_root_cmd worktree remove --force "$worktree_path"
    if git_root_cmd show-ref --verify --quiet "refs/heads/$branch"; then
      git_root_cmd branch -D "$branch"
    fi
    chown -R "$GIT_USER:mark" .git
    chown "$GIT_USER:mark" .codex-worktrees 2>/dev/null || true
    echo "Pruned accepted branch worktree: $branch"
  done
}

restore_task_state_access() {
  local task_state="$1/.brai-task"
  if [ ! -d "$task_state" ] || [ -L "$task_state" ]; then
    return
  fi
  chown "$GIT_USER:mark" "$task_state"
  chmod 0770 "$task_state"
  find "$task_state" -maxdepth 1 -type f -name '*.json' -exec chown "$GIT_USER:mark" {} +
  find "$task_state" -maxdepth 1 -type f -name '*.json' -exec chmod 0640 {} +
}

preserve_agent_dependency_paths() {
  for dependency_path in \
    node_modules \
    apps/brai_app/node_modules \
    services/brai_api/node_modules \
    services/brai_temporal/node_modules
  do
    if [ -L "$dependency_path" ] && [ ! -e "$dependency_path" ]; then
      rm -f "$dependency_path"
      continue
    fi
    if [ -d "$dependency_path" ] && [ ! -L "$dependency_path" ]; then
      chown -R "$GIT_USER:$SOURCE_GROUP" "$dependency_path"
      chmod -R u=rwX,g=rwX,o= "$dependency_path"
    fi
  done
}

exec 9>"$LOCK_FILE"
flock 9

cd "$REPO"

if [ "$PRUNE_MODE" -eq 1 ]; then
  prune_accepted_branches "${PRUNE_ACCEPTED_BRANCHES[@]}"
  if command -v "$NODE_BIN" >/dev/null 2>&1; then
    if prune_json="$("$NODE_BIN" -e 'const branches = process.argv.slice(1); console.log(JSON.stringify({ branch_count: branches.length, branches }));' "${PRUNE_ACCEPTED_BRANCHES[@]}")"; then
      record_runtime_log deploy accepted_worktree.prune done "Pruned accepted branch worktrees" "$prune_json"
    fi
  fi
  exit 0
fi

for exclude_pattern in /.agents/ /data/ /deploy/site/ /deploy/web/ /deploy/mobile-update/ /deploy/releases/; do
  grep -Fxq "$exclude_pattern" .git/info/exclude || printf '%s\n' "$exclude_pattern" >>.git/info/exclude
done

git_cmd fetch "$REMOTE_URL" "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
TARGET_COMMIT="$(git_cmd rev-parse "origin/$BRANCH")"
if [ -n "$EXPECTED_COMMIT" ] && [ "$TARGET_COMMIT" != "$EXPECTED_COMMIT" ]; then
  echo "origin/$BRANCH is $TARGET_COMMIT, expected $EXPECTED_COMMIT" >&2
  exit 1
fi

if [ -n "$(git_cmd status --porcelain)" ]; then
  CURRENT_BRANCH="$(git_cmd branch --show-current || echo detached)"
  SAFE_CURRENT_BRANCH="$(printf '%s' "$CURRENT_BRANCH" | tr -c 'A-Za-z0-9._-' '-')"
  RESCUE_DIR="$RESCUE_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$SAFE_CURRENT_BRANCH-$(git_cmd rev-parse --short HEAD)"
  mkdir -p "$RESCUE_DIR"
  git_cmd status --short >"$RESCUE_DIR/status.txt"
  git_cmd diff --binary >"$RESCUE_DIR/tracked.patch"
  git_cmd ls-files --others --exclude-standard -z >"$RESCUE_DIR/untracked.zlist"
  if [ -s "$RESCUE_DIR/untracked.zlist" ]; then
    tar --null -czf "$RESCUE_DIR/untracked.tar.gz" --files-from "$RESCUE_DIR/untracked.zlist"
  fi
  echo "Rescued dirty local checkout state to $RESCUE_DIR"
  if command -v "$NODE_BIN" >/dev/null 2>&1; then
    if rescue_json="$("$NODE_BIN" -e 'console.log(JSON.stringify({ branch: process.argv[1], commit: process.argv[2], untracked_present: process.argv[3] === "1" }));' "$CURRENT_BRANCH" "$(git_cmd rev-parse --short HEAD)" "$([ -s "$RESCUE_DIR/untracked.zlist" ] && printf 1 || printf 0)")"; then
      record_runtime_log deploy main_checkout.dirty_rescue done "Rescued dirty local checkout before sync" "$rescue_json"
    fi
  fi
fi

find "$REPO" \
  -path "$REPO/.git" -prune -o \
  -path "$REPO/.codex-worktrees" -prune -o \
  -path "$REPO/data" -prune -o \
  -path "$REPO/deploy/site" -prune -o \
  -path "$REPO/deploy/web" -prune -o \
  -path "$REPO/deploy/mobile-update" -prune -o \
  -path "$REPO/deploy/releases" -prune -o \
  -path "$REPO/node_modules" -prune -o \
  -path "$REPO/apps/brai_app/node_modules" -prune -o \
  -path "$REPO/services/brai_api/node_modules" -prune -o \
  -path "$REPO/services/brai_temporal/node_modules" -prune -o \
  -type l -prune -o \
  -exec chown "$GIT_USER:$SOURCE_GROUP" {} +

find "$REPO" \
  -path "$REPO/.git" -prune -o \
  -path "$REPO/.codex-worktrees" -prune -o \
  -path "$REPO/data" -prune -o \
  -path "$REPO/deploy/site" -prune -o \
  -path "$REPO/deploy/web" -prune -o \
  -path "$REPO/deploy/mobile-update" -prune -o \
  -path "$REPO/deploy/releases" -prune -o \
  -path "$REPO/node_modules" -prune -o \
  -path "$REPO/apps/brai_app/node_modules" -prune -o \
  -path "$REPO/services/brai_api/node_modules" -prune -o \
  -path "$REPO/services/brai_temporal/node_modules" -prune -o \
  -type l -prune -o \
  -exec chmod u=rwX,g=rX,o= {} +

git_cmd checkout -f -B "$BRANCH" "origin/$BRANCH"
git_cmd reset --hard "origin/$BRANCH"
git_cmd clean -fd \
  -e .agents/ \
  -e data/ \
  -e deploy/site/ \
  -e deploy/web/ \
  -e deploy/mobile-update/ \
  -e deploy/releases/ \
  -e node_modules/ \
  -e apps/brai_app/node_modules/ \
  -e services/brai_api/node_modules/ \
  -e services/brai_temporal/node_modules/
git_cmd config core.hooksPath .githooks

if [ "${BRAI_MAIN_SYNC_LOCK_CHECKOUT:-1}" = "1" ]; then
  mkdir -p .codex-worktrees
  chown "root:$SOURCE_GROUP" "$REPO"
  chmod 0751 "$REPO"
  chown -R mark:mark .git
  chown mark:mark .codex-worktrees
  chmod 0700 .codex-worktrees

  find "$REPO" \
    -path "$REPO/.git" -prune -o \
    -path "$REPO/.codex-worktrees" -prune -o \
    -path "$REPO/data" -prune -o \
    -path "$REPO/deploy/site" -prune -o \
    -path "$REPO/deploy/web" -prune -o \
    -path "$REPO/deploy/mobile-update" -prune -o \
    -path "$REPO/deploy/releases" -prune -o \
    -path "$REPO/node_modules" -prune -o \
    -path "$REPO/apps/brai_app/node_modules" -prune -o \
    -path "$REPO/services/brai_api/node_modules" -prune -o \
    -path "$REPO/services/brai_temporal/node_modules" -prune -o \
    -type l -prune -o \
    -exec chown "root:$SOURCE_GROUP" {} +

  find "$REPO" \
    -path "$REPO/.git" -prune -o \
    -path "$REPO/.codex-worktrees" -prune -o \
    -path "$REPO/data" -prune -o \
    -path "$REPO/deploy/site" -prune -o \
    -path "$REPO/deploy/web" -prune -o \
    -path "$REPO/deploy/mobile-update" -prune -o \
    -path "$REPO/deploy/releases" -prune -o \
    -path "$REPO/node_modules" -prune -o \
    -path "$REPO/apps/brai_app/node_modules" -prune -o \
    -path "$REPO/services/brai_api/node_modules" -prune -o \
    -path "$REPO/services/brai_temporal/node_modules" -prune -o \
    -type l -prune -o \
    -exec chmod u=rwX,g=rX,o= {} +

  chmod 0751 "$REPO"
  if [ -d deploy ]; then
    chmod u=rwx,g=rx,o=x deploy
  fi

  if getent group brai-deploy >/dev/null 2>&1; then
    for runtime_path in data deploy/site deploy/web deploy/mobile-update deploy/releases; do
      if [ -d "$runtime_path" ]; then
        chgrp -R brai-deploy "$runtime_path"
        chmod -R u=rwX,g=rwX,o=rX "$runtime_path"
        find "$runtime_path" -type d -exec chmod g+s {} +
      fi
    done
    for deploy_tool in \
      deploy/scripts/complete-operation-activities.sh \
      deploy/scripts/record-runtime-log.mjs \
      deploy/scripts/sync-occupied-preview-ota-manifests.sh
    do
      if [ -f "$deploy_tool" ]; then
        chmod u=rwx,g=rx,o=x deploy/scripts
        chgrp brai-deploy "$deploy_tool"
        chmod u=rwx,g=rx,o=rx "$deploy_tool"
      fi
    done
  fi

  preserve_agent_dependency_paths

  if [ "${BRAI_LOCK_STALE_WORKTREES:-0}" = "1" ]; then
    while IFS= read -r line; do
      case "$line" in
        "worktree "*)
          worktree_path="${line#worktree }"
          if [ "$worktree_path" = "$REPO" ]; then
            continue
          fi
          if [ -d "$worktree_path" ]; then
            chown -R root:mark "$worktree_path"
            chmod -R u=rwX,g=rX,o= "$worktree_path"
            restore_task_state_access "$worktree_path"
          fi
          ;;
      esac
    done < <(git_cmd worktree list --porcelain)
  fi
fi

if command -v "$NODE_BIN" >/dev/null 2>&1; then
  if sync_json="$("$NODE_BIN" -e 'console.log(JSON.stringify({ branch: process.argv[1], commit: process.argv[2].slice(0, 12) }));' "$BRANCH" "$TARGET_COMMIT")"; then
    record_runtime_log deploy main_checkout.sync done "Synced main checkout" "$sync_json"
  fi
fi
echo "Synced $REPO to origin/$BRANCH@$TARGET_COMMIT"
