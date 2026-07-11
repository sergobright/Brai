#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
SERVICE_USER="${BRAI_SERVICE_USER:-brai}"
DEPLOY_USER="${BRAI_DEPLOY_USER:-brai-deploy}"
DEPLOY_HOST="${BRAI_DEPLOY_HOST:-localhost}"
DEPLOY_REPO="${BRAI_OPERATION_HELPER_REPO:-${BRAI_DEPLOY_REPO:-/srv/projects/brai-envs/prod/source}}"
SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
SSH_KEY_FILE="${BRAI_DEPLOY_SSH_KEY_FILE:-${HOME:-}/.ssh/brai_deploy_ed25519}"
API_ENV_FILE="${BRAI_API_ENV_FILE:-/etc/brai/brai-api.env}"
MODE="remote"
CHECK_ACCESS=0

usage() {
  cat >&2 <<USAGE
Usage:
  $0 <operation-activity-id>...
  $0 --host-local <operation-activity-id>...
  $0 --local <operation-activity-id>...
  $0 --check-access
  $0 --host-local --check-access

Completes Codex operation activities in the current Supabase runtime database.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

while [[ "${1:-}" == "--local" || "${1:-}" == "--host-local" || "${1:-}" == "--check-access" ]]; do
  case "$1" in
    --local) MODE="local" ;;
    --host-local) MODE="host-local" ;;
    --check-access) CHECK_ACCESS=1 ;;
  esac
  shift
done

if [[ "$CHECK_ACCESS" -eq 0 && "$#" -eq 0 ]]; then
  usage
  exit 1
fi
if [[ "$CHECK_ACCESS" -eq 1 && "$#" -ne 0 ]]; then
  usage
  exit 1
fi

validate_ids() {
  local id
  declare -A seen=()
  for id in "$@"; do
    if [[ ! "$id" =~ ^(operation[:._-]|activity:operation:)[A-Za-z0-9._:-]+$ ]]; then
      echo "Invalid operation activity id: $id" >&2
      exit 1
    fi
    if [[ -n "${seen[$id]:-}" ]]; then
      echo "Duplicate operation activity id: $id" >&2
      exit 1
    fi
    seen[$id]=1
  done
}

if [[ "$CHECK_ACCESS" -eq 0 ]]; then
  validate_ids "$@"
fi

cleanup_key() {
  if [[ -n "${KEY_FILE_TMP:-}" ]]; then
    rm -f "$KEY_FILE_TMP"
  fi
}
trap cleanup_key EXIT

ssh_key() {
  if [[ -n "${BRAI_DEPLOY_SSH_KEY:-}" ]]; then
    KEY_FILE_TMP="$(mktemp "${TMPDIR:-/tmp}/brai-deploy-key.XXXXXX")"
    printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE_TMP"
    chmod 600 "$KEY_FILE_TMP"
    printf '%s\n' "$KEY_FILE_TMP"
    return
  fi
  if [[ -r "$SSH_KEY_FILE" ]]; then
    printf '%s\n' "$SSH_KEY_FILE"
    return
  fi
  echo "Set BRAI_DEPLOY_SSH_KEY or BRAI_DEPLOY_SSH_KEY_FILE for remote operation completion." >&2
  exit 1
}

complete_remote() {
  local key_file
  key_file="$(ssh_key)"
  ssh -i "$key_file" -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST" \
    bash -s -- "$DEPLOY_REPO" "$SERVICE_USER" "$@" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
SERVICE_USER="$2"
shift 2
exec sudo -n -u "$SERVICE_USER" "$DEPLOY_REPO/deploy/scripts/complete-operation-activities.sh" --local "$@"
REMOTE
}

complete_host_local() {
  exec sudo -n -u "$SERVICE_USER" "$DEPLOY_REPO/deploy/scripts/complete-operation-activities.sh" --local "$@"
}

check_remote_access() {
  local key_file
  key_file="$(ssh_key)"
  ssh -i "$key_file" -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST" \
    bash -s -- "$DEPLOY_REPO" "$SERVICE_USER" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
SERVICE_USER="$2"
HELPER="$DEPLOY_REPO/deploy/scripts/complete-operation-activities.sh"
test -x "$HELPER"
sudo -n -l -u "$SERVICE_USER" "$HELPER" --local operation:agent-task:access-contract-probe >/dev/null
sudo -n -u "$SERVICE_USER" "$HELPER" --local --check-access
REMOTE
}

check_host_local_access() {
  local helper="$DEPLOY_REPO/deploy/scripts/complete-operation-activities.sh"
  test -x "$helper"
  sudo -n -l -u "$SERVICE_USER" "$helper" --local operation:agent-task:access-contract-probe >/dev/null
  sudo -n -u "$SERVICE_USER" "$helper" --local --check-access
}

load_runtime_env() {
  if [[ -z "${BRAI_DATABASE_URL:-}" && -r "$API_ENV_FILE" ]]; then
    set -a
    # shellcheck source=/dev/null
    . "$API_ENV_FILE"
    set +a
  fi
  : "${BRAI_DATABASE_URL:?BRAI_DATABASE_URL is required}"
}

node_pg() {
  "$NODE_BIN" --input-type=module - "$ROOT" "$@"
}

check_local_access() {
  load_runtime_env
  node_pg <<'NODE'
const { createRequire } = await import("node:module");
const [root] = process.argv.slice(2);
const require = createRequire(`${root}/services/brai_api/package.json`);
const { Pool } = require("pg");
const databaseUrl = process.env.BRAI_DATABASE_URL;
const ssl = /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
const pool = new Pool({ connectionString: databaseUrl, ssl });
try {
  await pool.query("SELECT 1");
  console.log("operation-helper-access=ok postgres");
} finally {
  await pool.end();
}
NODE
}

complete_local() {
  load_runtime_env
  local ids_json
  ids_json="$("$NODE_BIN" -e 'console.log(JSON.stringify(process.argv.slice(1)))' "$@")"
  BRAI_OPERATION_IDS_JSON="$ids_json" node_pg <<'NODE'
const { createRequire } = await import("node:module");
const [root] = process.argv.slice(2);
const require = createRequire(`${root}/services/brai_api/package.json`);
const { Pool } = require("pg");
const ids = JSON.parse(process.env.BRAI_OPERATION_IDS_JSON || "[]");
const databaseUrl = process.env.BRAI_DATABASE_URL;
const ssl = /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
const pool = new Pool({ connectionString: databaseUrl, ssl });
const now = new Date().toISOString();
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const existing = await client.query(`
    SELECT id, status
    FROM activities
    WHERE activity_type_id = 'operation'
      AND author = 'Codex'
      AND deleted_at_utc IS NULL
      AND status IN ('New', 'Done')
      AND id = ANY($1::text[])
    ORDER BY id
  `, [ids]);
  if (existing.rows.length !== ids.length) throw new Error(`Expected ${ids.length} Codex operation activities, found ${existing.rows.length}.`);
  const update = await client.query(`
    UPDATE activities
    SET status = 'Done',
        completed_at_utc = COALESCE(completed_at_utc, $2),
        updated_at_utc = $2
    WHERE activity_type_id = 'operation'
      AND author = 'Codex'
      AND deleted_at_utc IS NULL
      AND status = 'New'
      AND id = ANY($1::text[])
  `, [ids, now]);
  const done = await client.query(`
    SELECT id, title, author, status, updated_at_utc, completed_at_utc
    FROM activities
    WHERE activity_type_id = 'operation'
      AND author = 'Codex'
      AND deleted_at_utc IS NULL
      AND status = 'Done'
      AND completed_at_utc IS NOT NULL
      AND id = ANY($1::text[])
    ORDER BY id
  `, [ids]);
  if (done.rows.length !== ids.length) throw new Error(`Expected ${ids.length} completed operation activities, found ${done.rows.length}.`);
  await client.query("COMMIT");
  console.log(`updated=${update.rowCount}`);
  console.table(done.rows);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
NODE
  local log_json
  if log_json="$("$NODE_BIN" -e 'const ids = JSON.parse(process.argv[1] || "[]"); console.log(JSON.stringify({ activity_ids: ids, activity_count: ids.length }));' "$ids_json")"; then
    "$NODE_BIN" "$ROOT/deploy/scripts/record-runtime-log.mjs" \
      --source deploy \
      --operation operation_activity.complete \
      --status done \
      --message "Completed Codex operation activities" \
      --json "$log_json" >/dev/null 2>&1 || true
  fi
}

if [[ "$CHECK_ACCESS" -eq 1 ]]; then
  if [[ "$MODE" == "remote" ]]; then
    check_remote_access
  elif [[ "$MODE" == "host-local" ]]; then
    check_host_local_access
  else
    check_local_access
  fi
elif [[ "$MODE" == "remote" ]]; then
  complete_remote "$@"
elif [[ "$MODE" == "host-local" ]]; then
  complete_host_local "$@"
else
  complete_local "$@"
fi
