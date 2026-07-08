#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
SERVICE_USER="${BRAI_SERVICE_USER:-brai}"
DEPLOY_USER="${BRAI_DEPLOY_USER:-brai-deploy}"
DEPLOY_HOST="${BRAI_DEPLOY_HOST:-localhost}"
DEPLOY_REPO="${BRAI_DEPLOY_REPO:-/srv/projects/brai-envs/prod/source}"
SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
SSH_KEY_FILE="${BRAI_DEPLOY_SSH_KEY_FILE:-${HOME:-}/.ssh/brai_deploy_ed25519}"
API_ENV_FILE="${BRAI_API_ENV_FILE:-/etc/brai/brai-api.env}"
MODE="remote"
CHECK_ACCESS=0
OPERATION_ID=""
TITLE=""
REASON=""
DESCRIPTION=""

usage() {
  cat >&2 <<USAGE
Usage:
  $0 --id <operation-id> --title <title> --reason <reason> --description <description>
  $0 --host-local --id <operation-id> --title <title> --reason <reason> --description <description>
  $0 --local --id <operation-id> --title <title> --reason <reason> --description <description>
  $0 --check-access
  $0 --host-local --check-access

Creates Codex operation activities in the current Supabase runtime database.
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

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --id)
      OPERATION_ID="${2:-}"
      shift 2
      ;;
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --reason)
      REASON="${2:-}"
      shift 2
      ;;
    --description)
      DESCRIPTION="${2:-}"
      shift 2
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

trim() {
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

validate_payload() {
  if [[ ! "$OPERATION_ID" =~ ^operation[:._-][A-Za-z0-9._:-]+$ ]]; then
    echo "Invalid operation activity id: $OPERATION_ID" >&2
    exit 1
  fi
  TITLE="$(printf '%s' "$TITLE" | trim)"
  REASON="$(printf '%s' "$REASON" | trim)"
  DESCRIPTION="$(printf '%s' "$DESCRIPTION" | trim)"
  if [[ -z "$TITLE" ]]; then
    echo "Operation title is required" >&2
    exit 1
  fi
  if [[ -z "$REASON" ]]; then
    echo "Operation reason is required" >&2
    exit 1
  fi
  if [[ -z "$DESCRIPTION" ]]; then
    echo "Operation description is required" >&2
    exit 1
  fi
}

if [[ "$CHECK_ACCESS" -eq 0 ]]; then
  validate_payload
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
  echo "Set BRAI_DEPLOY_SSH_KEY or BRAI_DEPLOY_SSH_KEY_FILE for remote operation creation." >&2
  exit 1
}

create_remote() {
  local key_file
  key_file="$(ssh_key)"
  ssh -i "$key_file" -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST" \
    bash -s -- "$DEPLOY_REPO" "$SERVICE_USER" "$OPERATION_ID" "$TITLE" "$REASON" "$DESCRIPTION" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
SERVICE_USER="$2"
ID="$3"
TITLE="$4"
REASON="$5"
DESCRIPTION="$6"
exec sudo -n -u "$SERVICE_USER" "$DEPLOY_REPO/deploy/scripts/create-operation-activity.sh" --local \
  --id "$ID" \
  --title "$TITLE" \
  --reason "$REASON" \
  --description "$DESCRIPTION"
REMOTE
}

create_host_local() {
  exec sudo -n -u "$SERVICE_USER" "$DEPLOY_REPO/deploy/scripts/create-operation-activity.sh" --local \
    --id "$OPERATION_ID" \
    --title "$TITLE" \
    --reason "$REASON" \
    --description "$DESCRIPTION"
}

check_remote_access() {
  local key_file
  key_file="$(ssh_key)"
  ssh -i "$key_file" -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST" \
    bash -s -- "$DEPLOY_REPO" "$SERVICE_USER" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
SERVICE_USER="$2"
HELPER="$DEPLOY_REPO/deploy/scripts/create-operation-activity.sh"
test -x "$HELPER"
sudo -n -l -u "$SERVICE_USER" "$HELPER" --local --id operation:agent-task:access-contract-probe --title x --reason x --description x >/dev/null
sudo -n -u "$SERVICE_USER" "$HELPER" --local --check-access
REMOTE
}

check_host_local_access() {
  local helper="$DEPLOY_REPO/deploy/scripts/create-operation-activity.sh"
  test -x "$helper"
  sudo -n -l -u "$SERVICE_USER" "$helper" --local --id operation:agent-task:access-contract-probe --title x --reason x --description x >/dev/null
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
  console.log("create-operation-helper-access=ok postgres");
} finally {
  await pool.end();
}
NODE
}

create_local() {
  load_runtime_env
  local payload_json
  payload_json="$("$NODE_BIN" -e 'console.log(JSON.stringify({ id: process.argv[1], title: process.argv[2], reason: process.argv[3], description: process.argv[4] }))' "$OPERATION_ID" "$TITLE" "$REASON" "$DESCRIPTION")"
  BRAI_OPERATION_PAYLOAD_JSON="$payload_json" node_pg <<'NODE'
const { createRequire } = await import("node:module");
const [root] = process.argv.slice(2);
const require = createRequire(`${root}/services/brai_api/package.json`);
const { Pool } = require("pg");
const payload = JSON.parse(process.env.BRAI_OPERATION_PAYLOAD_JSON || "{}");
const databaseUrl = process.env.BRAI_DATABASE_URL;
const ssl = /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
const pool = new Pool({ connectionString: databaseUrl, ssl });
const now = new Date().toISOString();
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const existing = await client.query(`
    SELECT id, title, author, status, created_at_utc, updated_at_utc, completed_at_utc
    FROM activities
    WHERE id = $1
    FOR UPDATE
  `, [payload.id]);
  let created = 0;
  if (existing.rows.length === 0) {
    const insert = await client.query(`
      INSERT INTO activities (
        id,
        activity_type_id,
        title,
        description_md,
        author,
        reason,
        status,
        created_at_utc,
        updated_at_utc
      ) VALUES ($1, 'operation', $2, $3, 'Codex', $4, 'New', $5, $5)
      ON CONFLICT (id) DO NOTHING
    `, [payload.id, payload.title, payload.description, payload.reason, now]);
    created = insert.rowCount;
  } else {
    const row = existing.rows[0];
    const typeCheck = await client.query(`
      SELECT 1
      FROM activities
      WHERE id = $1
        AND activity_type_id = 'operation'
        AND author = 'Codex'
        AND deleted_at_utc IS NULL
    `, [payload.id]);
    if (typeCheck.rows.length !== 1) throw new Error(`Existing activity ${payload.id} is not an active Codex operation row.`);
  }
  const createdRow = await client.query(`
    SELECT id, title, author, status, created_at_utc, updated_at_utc, completed_at_utc
    FROM activities
    WHERE id = $1
      AND activity_type_id = 'operation'
      AND author = 'Codex'
      AND deleted_at_utc IS NULL
  `, [payload.id]);
  if (createdRow.rows.length !== 1) throw new Error(`Expected one active Codex operation activity for ${payload.id}.`);
  await client.query("COMMIT");
  console.log(`created=${created}`);
  console.table(createdRow.rows);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
NODE
  local log_json
  if log_json="$("$NODE_BIN" -e 'const payload = JSON.parse(process.argv[1] || "{}"); console.log(JSON.stringify({ activity_id: payload.id, title: payload.title }));' "$payload_json")"; then
    "$NODE_BIN" "$ROOT/deploy/scripts/record-runtime-log.mjs" \
      --source deploy \
      --operation operation_activity.create \
      --status done \
      --message "Created Codex operation activity" \
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
  create_remote
elif [[ "$MODE" == "host-local" ]]; then
  create_host_local
else
  create_local
fi
