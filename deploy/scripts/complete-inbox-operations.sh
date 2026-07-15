#!/usr/bin/env bash
set -euo pipefail

SERVICE_USER="${BRAI_SERVICE_USER:-brai}"
DEPLOY_USER="${BRAI_DEPLOY_USER:-brai-deploy}"
DEPLOY_HOST="${BRAI_DEPLOY_HOST:-localhost}"
DEPLOY_REPO="${BRAI_OPERATION_HELPER_REPO:-${BRAI_DEPLOY_REPO:-/srv/projects/brai-envs/prod/source}}"
SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
SSH_KEY_FILE="${BRAI_DEPLOY_SSH_KEY_FILE:-${HOME:-}/.ssh/brai_deploy_ed25519}"
API_ENV_FILE="${BRAI_API_ENV_FILE:-/etc/brai/brai-api.env}"
API_BASE_URL="${BRAI_API_BASE_URL:-http://127.0.0.1:${PORT:-3020}}"
MODE="remote"
CHECK_ACCESS=0

usage() {
  cat >&2 <<USAGE
Usage:
  $0 <operation-idempotency-key>...
  $0 --host-local <operation-idempotency-key>...
  $0 --local <operation-idempotency-key>...
  $0 --check-access
  $0 --host-local --check-access

Completes Inbox operations through the authenticated Brai Inbox status API.
USAGE
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --local) MODE="local"; shift ;;
    --host-local) MODE="host-local"; shift ;;
    --check-access) CHECK_ACCESS=1; shift ;;
    --help|-h) usage; exit 0 ;;
    --*) usage; exit 1 ;;
    *) break ;;
  esac
done

if [[ "$CHECK_ACCESS" -eq 0 && "$#" -eq 0 ]] || [[ "$CHECK_ACCESS" -eq 1 && "$#" -ne 0 ]]; then
  usage
  exit 1
fi

validate_keys() {
  local key
  declare -A seen=()
  for key in "$@"; do
    if [[ ! "$key" =~ ^operation:[A-Za-z0-9._:-]+$ ]]; then
      echo "Invalid Inbox operation key: $key" >&2
      exit 1
    fi
    if [[ -n "${seen[$key]:-}" ]]; then
      echo "Duplicate Inbox operation key: $key" >&2
      exit 1
    fi
    seen[$key]=1
  done
}

if [[ "$CHECK_ACCESS" -eq 0 ]]; then
  validate_keys "$@"
fi

cleanup_key() {
  if [[ -n "${KEY_FILE_TMP:-}" ]]; then rm -f "$KEY_FILE_TMP"; fi
}
trap cleanup_key EXIT

ssh_key() {
  if [[ -n "${BRAI_DEPLOY_SSH_KEY:-}" ]]; then
    KEY_FILE_TMP="$(mktemp "${TMPDIR:-/tmp}/brai-deploy-key.XXXXXX")"
    printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE_TMP"
    chmod 600 "$KEY_FILE_TMP"
    printf '%s\n' "$KEY_FILE_TMP"
  elif [[ -r "$SSH_KEY_FILE" ]]; then
    printf '%s\n' "$SSH_KEY_FILE"
  else
    echo "Set BRAI_DEPLOY_SSH_KEY or BRAI_DEPLOY_SSH_KEY_FILE for remote Inbox completion." >&2
    exit 1
  fi
}

run_remote() {
  local key_file
  key_file="$(ssh_key)"
  ssh -i "$key_file" -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST" \
    bash -s -- "$DEPLOY_REPO" "$SERVICE_USER" "$CHECK_ACCESS" "$@" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
SERVICE_USER="$2"
CHECK_ACCESS="$3"
shift 3
args=(--local)
if [[ "$CHECK_ACCESS" == "1" ]]; then args+=(--check-access); else args+=("$@"); fi
exec sudo -n -u "$SERVICE_USER" "$DEPLOY_REPO/deploy/scripts/complete-inbox-operations.sh" "${args[@]}"
REMOTE
}

run_host_local() {
  local args=(--local)
  if [[ "$CHECK_ACCESS" -eq 1 ]]; then args+=(--check-access); else args+=("$@"); fi
  exec sudo -n -u "$SERVICE_USER" "$DEPLOY_REPO/deploy/scripts/complete-inbox-operations.sh" "${args[@]}"
}

load_runtime_env() {
  if [[ -z "${BRAI_INBOX_API_KEY:-}" && -r "$API_ENV_FILE" ]]; then
    set -a
    # shellcheck source=/dev/null
    . "$API_ENV_FILE"
    set +a
  fi
  : "${BRAI_INBOX_API_KEY:?BRAI_INBOX_API_KEY is required}"
}

run_local() {
  load_runtime_env
  BRAI_INBOX_KEYS_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$@")" \
    BRAI_INBOX_CHECK_ACCESS="$CHECK_ACCESS" \
    BRAI_API_BASE_URL="$API_BASE_URL" \
    node --input-type=module <<'NODE'
const base = process.env.BRAI_API_BASE_URL;
const headers = { 'x-brai-api-key': process.env.BRAI_INBOX_API_KEY };
if (process.env.BRAI_INBOX_CHECK_ACCESS === '1') {
  const response = await fetch(`${base}/v1/`, { headers });
  if (!response.ok) throw new Error(`Inbox API access check failed: HTTP ${response.status}`);
  console.log('inbox-operation-helper-access=ok api');
  process.exit(0);
}
for (const key of JSON.parse(process.env.BRAI_INBOX_KEYS_JSON || '[]')) {
  const response = await fetch(`${base}/v1/inbox/status`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ idempotency_key: key, status: 'Done' }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Inbox operation ${key} failed: HTTP ${response.status} ${result.error || ''}`.trim());
  console.log(JSON.stringify({ key, inbox_id: result.inbox_id, status: result.status, changed: result.changed }));
}
NODE
}

case "$MODE" in
  remote) run_remote "$@" ;;
  host-local) run_host_local "$@" ;;
  local) run_local "$@" ;;
esac
