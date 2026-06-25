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
ACCEPTED_PR_NUMBER="${BRIGHT_OS_ACCEPTED_PR_NUMBER:-}"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/bright-deploy-key.XXXXXX")"
cleanup() {
  rm -f "$KEY_FILE"
}
trap cleanup EXIT

printf '%s\n' "$BRIGHT_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRIGHT_DEPLOY_USER@$BRIGHT_DEPLOY_HOST" \
  bash -s -- "$DEPLOY_REPO" "$BRIGHT_OS_SOURCE_BRANCH" "$BRIGHT_OS_TARGET_ENVIRONMENT" "$BRIGHT_OS_TARGET_BRANCH" "$BRIGHT_OS_TARGET_COMMIT" "$ACCEPTED_PR_NUMBER" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
BRIGHT_OS_SOURCE_BRANCH="$2"
BRIGHT_OS_TARGET_ENVIRONMENT="$3"
BRIGHT_OS_TARGET_BRANCH="$4"
BRIGHT_OS_TARGET_COMMIT="$5"
BRIGHT_OS_ACCEPTED_PR_NUMBER="${6:-}"
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
  RUN_ROOT="$ENVS_ROOT/preview-$SLOT/source"
elif [[ "$BRIGHT_OS_TARGET_ENVIRONMENT" == "prod" ]]; then
  RUN_ROOT="$ENVS_ROOT/dev/source"
  export BRIGHT_OS_DB="$DEPLOY_REPO/data/bright_os.sqlite"
fi

cd "$RUN_ROOT"
BRIGHT_OS_SOURCE_BRANCH="$BRIGHT_OS_SOURCE_BRANCH" \
BRIGHT_OS_ACCEPTED_PR_NUMBER="$BRIGHT_OS_ACCEPTED_PR_NUMBER" \
BRIGHT_OS_TARGET_ENVIRONMENT="$BRIGHT_OS_TARGET_ENVIRONMENT" \
BRIGHT_OS_TARGET_BRANCH="$BRIGHT_OS_TARGET_BRANCH" \
BRIGHT_OS_TARGET_COMMIT="$BRIGHT_OS_TARGET_COMMIT" \
  deploy/scripts/promote-accepted-deployment.sh
REMOTE
