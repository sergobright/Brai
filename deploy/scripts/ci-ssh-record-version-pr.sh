#!/usr/bin/env bash
set -euo pipefail

: "${BRAI_DEPLOY_HOST:?BRAI_DEPLOY_HOST is required}"
: "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
: "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"
: "${BRAI_PR_JSON:?BRAI_PR_JSON is required}"

DEPLOY_REPO="${BRAI_DEPLOY_REPO:-/srv/projects/brai}"
SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-pr-key.XXXXXX")"
trap 'rm -f "$KEY_FILE"' EXIT
printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"
PR_JSON_B64="$(printf '%s' "$BRAI_PR_JSON" | base64 -w0)"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
  bash -s -- "$DEPLOY_REPO" "$PR_JSON_B64" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
BRAI_PR_JSON="$(printf '%s' "$2" | base64 -d)"
RUN_ROOT="$DEPLOY_REPO"
if [[ -r /srv/projects/brai-envs/prod/source/deploy/scripts/record-version-pr.mjs ]]; then
  RUN_ROOT=/srv/projects/brai-envs/prod/source
fi
if [[ ! -r "$RUN_ROOT/deploy/scripts/record-version-pr.mjs" ]]; then
  echo "Version-history PR recorder is not deployed yet; skipped."
  exit 0
fi
set -a
# shellcheck source=/dev/null
. /etc/brai/brai-api.env
set +a
export BRAI_PR_JSON
node "$RUN_ROOT/deploy/scripts/record-version-pr.mjs"
REMOTE
