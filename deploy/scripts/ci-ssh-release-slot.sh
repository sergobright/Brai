#!/usr/bin/env bash
set -euo pipefail

: "${BRIGHT_DEPLOY_HOST:?BRIGHT_DEPLOY_HOST is required}"
: "${BRIGHT_DEPLOY_USER:?BRIGHT_DEPLOY_USER is required}"
: "${BRIGHT_DEPLOY_SSH_KEY:?BRIGHT_DEPLOY_SSH_KEY is required}"
: "${BRIGHT_OS_BRANCH:?BRIGHT_OS_BRANCH is required}"

DEPLOY_REPO="${BRIGHT_DEPLOY_REPO:-/srv/projects/bright-os}"
SSH_PORT="${BRIGHT_DEPLOY_SSH_PORT:-22}"
ENVS_ROOT="${BRIGHT_OS_ENVS_ROOT:-/srv/projects/bright-os-envs}"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/bright-deploy-key.XXXXXX")"
cleanup() {
  rm -f "$KEY_FILE"
}
trap cleanup EXIT

printf '%s\n' "$BRIGHT_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRIGHT_DEPLOY_USER@$BRIGHT_DEPLOY_HOST" \
  bash -s -- "$DEPLOY_REPO" "$ENVS_ROOT" "$BRIGHT_OS_BRANCH" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
ENVS_ROOT="$2"
BRIGHT_OS_BRANCH="$3"
NODE_PREFIX="${BRIGHT_OS_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ -d "$NODE_PREFIX" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
fi

RELEASE_ROOT="$DEPLOY_REPO"
REGISTRY="${BRIGHT_OS_PREVIEW_REGISTRY:-$ENVS_ROOT/preview-slots.json}"
if [[ -f "$REGISTRY" ]]; then
  SLOT_SOURCE="$(node - "$REGISTRY" "$BRIGHT_OS_BRANCH" <<'NODE' || true
const fs = require("node:fs");
const [registryPath, branch] = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
for (const [slot, entry] of Object.entries(registry)) {
  if (entry?.branch === branch) {
    console.log(`preview-${slot.toLowerCase()}/source`);
    process.exit(0);
  }
}
process.exit(1);
NODE
)"
  if [[ -n "$SLOT_SOURCE" && -r "$ENVS_ROOT/$SLOT_SOURCE/deploy/scripts/preview-slots.mjs" ]]; then
    RELEASE_ROOT="$ENVS_ROOT/$SLOT_SOURCE"
  elif [[ -r "$ENVS_ROOT/dev/source/deploy/scripts/preview-slots.mjs" ]]; then
    RELEASE_ROOT="$ENVS_ROOT/dev/source"
  fi
fi

if [[ ! -r "$RELEASE_ROOT/deploy/scripts/preview-slots.mjs" ]]; then
  echo "Cannot read preview slot tooling from $RELEASE_ROOT" >&2
  exit 1
fi

cd "$RELEASE_ROOT"
bash deploy/scripts/preview-slots.sh release "$BRIGHT_OS_BRANCH"
REMOTE
