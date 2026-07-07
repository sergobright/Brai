#!/usr/bin/env bash
set -euo pipefail

: "${BRAI_DEPLOY_HOST:?BRAI_DEPLOY_HOST is required}"
: "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
: "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"

if [[ "$#" -eq 0 ]]; then
  exit 0
fi
for branch in "$@"; do
  if [[ ! "$branch" =~ ^codex/[A-Za-z0-9._-]+$ ]]; then
    echo "Invalid accepted branch cleanup target: $branch" >&2
    exit 1
  fi
done

SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-deploy-key.XXXXXX")"
cleanup() {
  rm -f "$KEY_FILE"
}
trap cleanup EXIT

printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
  bash -s -- "$@" <<'REMOTE'
set -euo pipefail
exec sudo -n /srv/opt/brai-main-sync.sh --prune-accepted-branches "$@"
REMOTE
