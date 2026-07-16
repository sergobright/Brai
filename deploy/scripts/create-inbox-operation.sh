#!/usr/bin/env bash
set -euo pipefail

NODE_BIN="${NODE_BIN:-node}"
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
STDIN_JSON=0
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
  printf '%s\n' '<json>' | $0 --local --stdin-json
  $0 --check-access
  $0 --host-local --check-access

Creates agent operations through the authenticated Brai Inbox API.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

while [[ "${1:-}" == "--local" || "${1:-}" == "--host-local" || "${1:-}" == "--check-access" || "${1:-}" == "--stdin-json" ]]; do
  case "$1" in
    --local) MODE="local" ;;
    --host-local) MODE="host-local" ;;
    --check-access) CHECK_ACCESS=1 ;;
    --stdin-json) STDIN_JSON=1 ;;
  esac
  shift
done

if [[ "$STDIN_JSON" -eq 1 ]]; then
  IFS= read -r payload_json
  mapfile -d '' -t payload_fields < <("$NODE_BIN" -e '
    const value = JSON.parse(process.argv[1]);
    for (const key of ["id", "title", "reason", "description"]) process.stdout.write(String(value[key] ?? "") + "\0");
  ' "$payload_json")
  OPERATION_ID="${payload_fields[0]:-}"
  TITLE="${payload_fields[1]:-}"
  REASON="${payload_fields[2]:-}"
  DESCRIPTION="${payload_fields[3]:-}"
fi

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --id) OPERATION_ID="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --reason) REASON="${2:-}"; shift 2 ;;
    --description) DESCRIPTION="${2:-}"; shift 2 ;;
    *) usage; exit 1 ;;
  esac
done

trim() {
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

validate_payload() {
  if [[ ! "$OPERATION_ID" =~ ^operation[:._-][A-Za-z0-9._:-]+$ ]]; then
    echo "Invalid Inbox operation id: $OPERATION_ID" >&2
    exit 1
  fi
  TITLE="$(printf '%s' "$TITLE" | trim)"
  REASON="$(printf '%s' "$REASON" | trim)"
  DESCRIPTION="$(printf '%s' "$DESCRIPTION" | trim)"
  if [[ -z "$TITLE" ]]; then echo "Operation title is required" >&2; exit 1; fi
  if [[ "${#TITLE}" -lt 8 ]]; then echo "Operation title is too short" >&2; exit 1; fi
  if [[ -z "$REASON" ]]; then echo "Operation reason is required" >&2; exit 1; fi
  if [[ "${#REASON}" -lt 12 ]]; then echo "Operation reason is too short" >&2; exit 1; fi
  if [[ -z "$DESCRIPTION" ]]; then echo "Operation description is required" >&2; exit 1; fi
  if [[ "${#DESCRIPTION}" -lt 20 ]]; then echo "Operation description is too short" >&2; exit 1; fi
}

if [[ "$CHECK_ACCESS" -eq 0 ]]; then validate_payload; fi

cleanup_key() {
  if [[ -n "${KEY_FILE_TMP:-}" ]]; then rm -f "$KEY_FILE_TMP"; fi
}
trap cleanup_key EXIT

ssh_key() {
  if [[ -n "${BRAI_DEPLOY_SSH_KEY:-}" ]]; then
    KEY_FILE_TMP="$(mktemp "${TMPDIR:-/tmp}/brai-deploy-key.XXXXXX")"
    printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE_TMP"
    chmod 600 "$KEY_FILE_TMP"
    RESOLVED_SSH_KEY_FILE="$KEY_FILE_TMP"
  elif [[ -r "$SSH_KEY_FILE" ]]; then
    RESOLVED_SSH_KEY_FILE="$SSH_KEY_FILE"
  else
    echo "Set BRAI_DEPLOY_SSH_KEY or BRAI_DEPLOY_SSH_KEY_FILE for remote Inbox operation creation." >&2
    exit 1
  fi
}

payload_json() {
  "$NODE_BIN" -e 'console.log(JSON.stringify({ id: process.argv[1], title: process.argv[2], reason: process.argv[3], description: process.argv[4] }))' \
    "$OPERATION_ID" "$TITLE" "$REASON" "$DESCRIPTION"
}

run_remote() {
  local key_file
  ssh_key
  key_file="$RESOLVED_SSH_KEY_FILE"
  if [[ "$CHECK_ACCESS" -eq 1 ]]; then
    ssh -i "$key_file" -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST" \
      sudo -n -u "$SERVICE_USER" "$DEPLOY_REPO/deploy/scripts/create-inbox-operation.sh" --local --check-access
    return
  fi
  payload_json | ssh -i "$key_file" -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST" \
    sudo -n -u "$SERVICE_USER" "$DEPLOY_REPO/deploy/scripts/create-inbox-operation.sh" --local --stdin-json
}

run_host_local() {
  if [[ "$CHECK_ACCESS" -eq 1 ]]; then
    exec sudo -n -u "$SERVICE_USER" "$DEPLOY_REPO/deploy/scripts/create-inbox-operation.sh" --local --check-access
  fi
  exec sudo -n -u "$SERVICE_USER" "$DEPLOY_REPO/deploy/scripts/create-inbox-operation.sh" --local \
    --id "$OPERATION_ID" --title "$TITLE" --reason "$REASON" --description "$DESCRIPTION"
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
  if [[ "$CHECK_ACCESS" -eq 1 ]]; then
    # shellcheck disable=SC2016
    BRAI_API_BASE_URL="$API_BASE_URL" "$NODE_BIN" --input-type=module -e '
      const response = await fetch(`${process.env.BRAI_API_BASE_URL}/v1/`, {
        headers: { "x-brai-api-key": process.env.BRAI_INBOX_API_KEY },
      });
      if (!response.ok) throw new Error(`Inbox API access check failed: HTTP ${response.status}`);
      console.log("create-inbox-operation-helper-access=ok api");
    '
    return
  fi

  # shellcheck disable=SC2016
  BRAI_OPERATION_PAYLOAD_JSON="$(payload_json)" BRAI_API_BASE_URL="$API_BASE_URL" "$NODE_BIN" --input-type=module -e '
    const input = JSON.parse(process.env.BRAI_OPERATION_PAYLOAD_JSON);
    const key = input.id;
    const response = await fetch(`${process.env.BRAI_API_BASE_URL}/v1/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-brai-api-key": process.env.BRAI_INBOX_API_KEY,
      },
      body: JSON.stringify({
        target: "inbox",
        record_type_id: 2,
        source: "codex",
        idempotency_key: key,
        preliminary_section: "operation",
        text: input.title,
        description: `${input.description}\n\n## Почему задача появилась\n\n${input.reason}`,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Inbox operation ${key} failed: HTTP ${response.status}`);
    if (typeof result.inbox_id !== "string" || typeof result.created !== "boolean") {
      throw new Error(`Inbox operation ${key} returned an invalid success response`);
    }
    console.log(JSON.stringify({ key, inbox_id: result.inbox_id, status: "New", created: result.created }));
  '
}

case "$MODE" in
  remote) run_remote ;;
  host-local) run_host_local ;;
  local) run_local ;;
esac
