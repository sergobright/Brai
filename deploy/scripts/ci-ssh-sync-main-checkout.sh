#!/usr/bin/env bash
set -euo pipefail

: "${BRAI_DEPLOY_HOST:?BRAI_DEPLOY_HOST is required}"
: "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
: "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"
: "${BRAI_COMMIT:?BRAI_COMMIT is required}"

SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-deploy-key.XXXXXX")"
cleanup() {
  rm -f "$KEY_FILE"
}
trap cleanup EXIT

printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
  sudo -n /srv/opt/brai-main-sync.sh "$BRAI_COMMIT"

if [[ "${BRAI_RESTART_TEMPORAL_WORKER:-false}" == "true" ]]; then
  ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
    bash -s -- "${BRAI_TEMPORAL_WORKER_RESTART_DELAY:-15}" "${BRAI_INSTALL_TEMPORAL_DEPENDENCIES:-false}" <<'REMOTE'
set -euo pipefail
DELAY="$1"
INSTALL_DEPENDENCIES="$2"
NODE_PREFIX="${BRAI_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ "$INSTALL_DEPENDENCIES" == "true" && -x "$NODE_PREFIX/npm" ]]; then
  sudo -n -u brai "$NODE_PREFIX/npm" --prefix /srv/projects/brai/services/brai_temporal ci
fi
if command -v systemd-run >/dev/null 2>&1; then
  sudo -n systemd-run \
    --unit=brai-temporal-worker-delayed-restart \
    --on-active="${DELAY}s" \
    --collect \
    /bin/systemctl restart brai-temporal-worker.service
else
  ( sleep "$DELAY"; sudo -n /bin/systemctl restart brai-temporal-worker.service ) >/dev/null 2>&1 &
fi
REMOTE
fi
