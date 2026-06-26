#!/usr/bin/env bash
set -euo pipefail

: "${BRIGHT_DEPLOY_HOST:?BRIGHT_DEPLOY_HOST is required}"
: "${BRIGHT_DEPLOY_USER:?BRIGHT_DEPLOY_USER is required}"
: "${BRIGHT_DEPLOY_SSH_KEY:?BRIGHT_DEPLOY_SSH_KEY is required}"
: "${BRIGHT_OS_SOURCE_BRANCH:?BRIGHT_OS_SOURCE_BRANCH is required}"
: "${BRIGHT_OS_TARGET_ENVIRONMENT:?BRIGHT_OS_TARGET_ENVIRONMENT is required}"
: "${BRIGHT_OS_TARGET_BRANCH:?BRIGHT_OS_TARGET_BRANCH is required}"
: "${BRIGHT_OS_TARGET_COMMIT:?BRIGHT_OS_TARGET_COMMIT is required}"

DEPLOY_REPO="${BRIGHT_DEPLOY_REPO:-/srv/projects/bright-os}"
SSH_PORT="${BRIGHT_DEPLOY_SSH_PORT:-22}"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/bright-deploy-key.XXXXXX")"
cleanup() {
  rm -f "$KEY_FILE"
}
trap cleanup EXIT

printf '%s\n' "$BRIGHT_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

SOURCE_SHORT_CHANGES="${BRIGHT_OS_SOURCE_SHORT_CHANGES:-}"
SOURCE_DETAILED_CHANGES="${BRIGHT_OS_SOURCE_DETAILED_CHANGES:-}"
if [[ "$BRIGHT_OS_TARGET_ENVIRONMENT" == "dev" && ( -z "$SOURCE_SHORT_CHANGES" || -z "$SOURCE_DETAILED_CHANGES" ) ]]; then
  NOTES_COMMIT=""
  if git fetch --depth=20 origin "$BRIGHT_OS_SOURCE_BRANCH" >/dev/null 2>&1; then
    NOTES_COMMIT="$(git rev-parse FETCH_HEAD 2>/dev/null || true)"
  fi
  if [[ -n "$NOTES_COMMIT" ]]; then
    for _ in 1 2 3 4 5; do
      GIT_SUBJECT="$(git log -1 --format=%s "$NOTES_COMMIT" 2>/dev/null || true)"
      if [[ "$GIT_SUBJECT" == Merge\ branch\ *\ into\ codex/* || "$GIT_SUBJECT" == Merge\ remote-tracking\ branch\ *\ into\ codex/* ]]; then
        PARENT_COMMIT="$(git rev-parse "$NOTES_COMMIT^1" 2>/dev/null || true)"
        if [[ -n "$PARENT_COMMIT" ]]; then
          NOTES_COMMIT="$PARENT_COMMIT"
          continue
        fi
      fi
      break
    done
    GIT_BODY="$(git log -1 --format=%b "$NOTES_COMMIT" 2>/dev/null || true)"
    if [[ "$GIT_SUBJECT" == Merge\ pull\ request* && -n "$GIT_BODY" ]]; then
      while IFS= read -r line; do
        if [[ -n "${line//[[:space:]]/}" ]]; then
          GIT_SUBJECT="$line"
        fi
      done <<<"$GIT_BODY"
      GIT_BODY=""
    fi
    SOURCE_SHORT_CHANGES="${SOURCE_SHORT_CHANGES:-$GIT_SUBJECT}"
    if [[ -z "$SOURCE_DETAILED_CHANGES" ]]; then
      if [[ -n "$GIT_BODY" ]]; then
        SOURCE_DETAILED_CHANGES="$GIT_SUBJECT"$'\n\n'"$GIT_BODY"
      else
        SOURCE_DETAILED_CHANGES="$GIT_SUBJECT"
      fi
    fi
  fi
fi

SOURCE_SHORT_CHANGES_B64="$(printf '%s' "$SOURCE_SHORT_CHANGES" | base64 -w0)"
SOURCE_DETAILED_CHANGES_B64="$(printf '%s' "$SOURCE_DETAILED_CHANGES" | base64 -w0)"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRIGHT_DEPLOY_USER@$BRIGHT_DEPLOY_HOST" \
  bash -s -- "$DEPLOY_REPO" "$BRIGHT_OS_SOURCE_BRANCH" "$BRIGHT_OS_TARGET_ENVIRONMENT" "$BRIGHT_OS_TARGET_BRANCH" "$BRIGHT_OS_TARGET_COMMIT" "${SOURCE_SHORT_CHANGES_B64:-.}" "${SOURCE_DETAILED_CHANGES_B64:-.}" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
BRIGHT_OS_SOURCE_BRANCH="$2"
BRIGHT_OS_TARGET_ENVIRONMENT="$3"
BRIGHT_OS_TARGET_BRANCH="$4"
BRIGHT_OS_TARGET_COMMIT="$5"
BRIGHT_OS_SOURCE_SHORT_CHANGES="$([[ "$6" == "." ]] || printf '%s' "$6" | base64 -d)"
BRIGHT_OS_SOURCE_DETAILED_CHANGES="$([[ "$7" == "." ]] || printf '%s' "$7" | base64 -d)"
ENVS_ROOT="${BRIGHT_OS_ENVS_ROOT:-/srv/projects/bright-os-envs}"
NODE_PREFIX="${BRIGHT_OS_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ -d "$NODE_PREFIX" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
fi

RUN_ROOT="$DEPLOY_REPO"
if [[ "$BRIGHT_OS_TARGET_ENVIRONMENT" == "dev" ]]; then
  if ! SLOT="$(node -e '
const fs = require("node:fs");
const path = process.env.BRIGHT_OS_PREVIEW_REGISTRY || `${process.env.BRIGHT_OS_ENVS_ROOT || "/srv/projects/bright-os-envs"}/preview-slots.json`;
const branch = process.argv[1];
const registry = JSON.parse(fs.readFileSync(path, "utf8"));
for (const slot of ["A", "B", "C", "D", "E"]) {
  if (registry[slot]?.branch === branch) {
    console.log(slot.toLowerCase());
    process.exit(0);
  }
}
process.exit(1);
' "$BRIGHT_OS_SOURCE_BRANCH")"; then
    echo "No preview slot found for $BRIGHT_OS_SOURCE_BRANCH; skipping metadata promotion."
    exit 0
  fi
  if [[ -r "$ENVS_ROOT/dev/source/deploy/scripts/promote-accepted-deployment.sh" ]]; then
    RUN_ROOT="$ENVS_ROOT/dev/source"
  else
    RUN_ROOT="$ENVS_ROOT/preview-$SLOT/source"
  fi
elif [[ "$BRIGHT_OS_TARGET_ENVIRONMENT" == "prod" ]]; then
  RUN_ROOT="$ENVS_ROOT/dev/source"
  export BRIGHT_OS_DB="$DEPLOY_REPO/data/bright_os.sqlite"
fi

cd "$RUN_ROOT"
if [[ -d "$DEPLOY_REPO/.git" ]]; then
  export BRIGHT_OS_GIT_NOTES_ROOT="$DEPLOY_REPO"
fi
BRIGHT_OS_SOURCE_BRANCH="$BRIGHT_OS_SOURCE_BRANCH" \
BRIGHT_OS_TARGET_ENVIRONMENT="$BRIGHT_OS_TARGET_ENVIRONMENT" \
BRIGHT_OS_TARGET_BRANCH="$BRIGHT_OS_TARGET_BRANCH" \
BRIGHT_OS_TARGET_COMMIT="$BRIGHT_OS_TARGET_COMMIT" \
BRIGHT_OS_SOURCE_SHORT_CHANGES="$BRIGHT_OS_SOURCE_SHORT_CHANGES" \
BRIGHT_OS_SOURCE_DETAILED_CHANGES="$BRIGHT_OS_SOURCE_DETAILED_CHANGES" \
  deploy/scripts/promote-accepted-deployment.sh
REMOTE
