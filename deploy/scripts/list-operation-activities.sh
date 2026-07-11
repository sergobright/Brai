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
STATUS="New"
LIMIT="50"
JSON_OUTPUT=0

usage() {
  cat >&2 <<USAGE
Usage:
  $0 [--status New|Done|all] [--limit <N>] [--json]
  $0 --host-local [--status New|Done|all] [--limit <N>] [--json]
  $0 --local [--status New|Done|all] [--limit <N>] [--json]
  $0 --check-access
  $0 --host-local --check-access

Lists Codex operation activities from the current Supabase runtime database.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --local)
      MODE="local"
      shift
      ;;
    --host-local)
      MODE="host-local"
      shift
      ;;
    --check-access)
      CHECK_ACCESS=1
      shift
      ;;
    --status)
      STATUS="${2:-}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

validate_options() {
  if [[ ! "$STATUS" =~ ^(New|Done|all)$ ]]; then
    echo "Invalid status: $STATUS" >&2
    exit 1
  fi
  if [[ ! "$LIMIT" =~ ^[0-9]+$ || "$LIMIT" -lt 1 || "$LIMIT" -gt 500 ]]; then
    echo "Invalid limit: $LIMIT" >&2
    exit 1
  fi
}

validate_options

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
  echo "Set BRAI_DEPLOY_SSH_KEY or BRAI_DEPLOY_SSH_KEY_FILE for remote operation listing." >&2
  exit 1
}

json_arg() {
  if [[ "$JSON_OUTPUT" -eq 1 ]]; then
    printf '%s\n' "--json"
  fi
}

list_remote() {
  local key_file json_flag
  key_file="$(ssh_key)"
  json_flag="$(json_arg)"
  ssh -i "$key_file" -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST" \
    bash -s -- "$DEPLOY_REPO" "$SERVICE_USER" "$STATUS" "$LIMIT" "$json_flag" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
SERVICE_USER="$2"
STATUS="$3"
LIMIT="$4"
JSON_FLAG="$5"
exec sudo -n -u "$SERVICE_USER" "$DEPLOY_REPO/deploy/scripts/list-operation-activities.sh" --local \
  --status "$STATUS" \
  --limit "$LIMIT" \
  $JSON_FLAG
REMOTE
}

list_host_local() {
  local json_flag
  json_flag="$(json_arg)"
  exec sudo -n -u "$SERVICE_USER" "$DEPLOY_REPO/deploy/scripts/list-operation-activities.sh" --local \
    --status "$STATUS" \
    --limit "$LIMIT" \
    $json_flag
}

check_remote_access() {
  local key_file
  key_file="$(ssh_key)"
  ssh -i "$key_file" -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST" \
    bash -s -- "$DEPLOY_REPO" "$SERVICE_USER" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
SERVICE_USER="$2"
HELPER="$DEPLOY_REPO/deploy/scripts/list-operation-activities.sh"
test -x "$HELPER"
sudo -n -l -u "$SERVICE_USER" "$HELPER" --local --status New --limit 1 >/dev/null
sudo -n -u "$SERVICE_USER" "$HELPER" --local --check-access
REMOTE
}

check_host_local_access() {
  local helper="$DEPLOY_REPO/deploy/scripts/list-operation-activities.sh"
  test -x "$helper"
  sudo -n -l -u "$SERVICE_USER" "$helper" --local --status New --limit 1 >/dev/null
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
  console.log("list-operation-helper-access=ok postgres");
} finally {
  await pool.end();
}
NODE
}

list_local() {
  load_runtime_env
  BRAI_OPERATION_LIST_STATUS="$STATUS" BRAI_OPERATION_LIST_LIMIT="$LIMIT" BRAI_OPERATION_LIST_JSON="$JSON_OUTPUT" node_pg <<'NODE'
const { createRequire } = await import("node:module");
const [root] = process.argv.slice(2);
const require = createRequire(`${root}/services/brai_api/package.json`);
const { Pool } = require("pg");
const status = process.env.BRAI_OPERATION_LIST_STATUS || "New";
const limit = Number.parseInt(process.env.BRAI_OPERATION_LIST_LIMIT || "50", 10);
const json = process.env.BRAI_OPERATION_LIST_JSON === "1";
const databaseUrl = process.env.BRAI_DATABASE_URL;
const ssl = /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
const pool = new Pool({ connectionString: databaseUrl, ssl });
try {
  const whereStatus = status === "all" ? "" : "AND status = $2";
  const params = status === "all" ? [limit] : [limit, status];
  const rows = (await pool.query(`
    SELECT
      id,
      title,
      status,
      created_at_utc,
      updated_at_utc,
      left(coalesce(reason, ''), 160) AS reason,
      left(coalesce(description_md, ''), 240) AS description_md
    FROM activities
    WHERE activity_type_id = 'operation'
      AND author = 'Codex'
      AND deleted_at_utc IS NULL
      ${whereStatus}
    ORDER BY created_at_utc DESC, id ASC
    LIMIT $1
  `, params)).rows;
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.table(rows);
  }
} finally {
  await pool.end();
}
NODE
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
  list_remote
elif [[ "$MODE" == "host-local" ]]; then
  list_host_local
else
  list_local
fi
