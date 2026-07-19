#!/usr/bin/env bash
set -euo pipefail

: "${BRAI_DEPLOY_HOST:?BRAI_DEPLOY_HOST is required}"
: "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
: "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"

DEPLOY_REPO="${BRAI_DEPLOY_REPO:-/srv/projects/brai}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-version-state-key.XXXXXX")"
trap 'rm -f "$KEY_FILE"' EXIT
printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
  bash -s -- "$DEPLOY_REPO" "$ENVS_ROOT" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
ENVS_ROOT="$2"
RUN_ROOT="$ENVS_ROOT/prod/source"
[[ -r "$RUN_ROOT/services/brai_api/src/store.js" ]] || RUN_ROOT="$DEPLOY_REPO"
[[ -r /etc/brai/brai-api.env ]] || { echo "Production API environment is missing" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. /etc/brai/brai-api.env
set +a
cd "$RUN_ROOT"
node --input-type=module <<'NODE'
import { BraiStore } from "./services/brai_api/src/store.js";
const store = new BraiStore(process.env.BRAI_DATABASE_URL || "");
try {
  const latestBuildVersion = Number(store.latestVersion("build")?.version || 0);
  const finalizedWorkKeys = store.db.prepare(`
    SELECT work_key
    FROM release_works
    WHERE status = 'finalized'
    ORDER BY work_key
  `).all().map((row) => row.work_key);
  console.log(JSON.stringify({ latestBuildVersion, finalizedWorkKeys }));
} finally {
  store.close();
}
NODE
REMOTE
