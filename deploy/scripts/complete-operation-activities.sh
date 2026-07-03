#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${BRAI_DB:-/srv/projects/brai/data/brai.sqlite}"
BACKUP_DIR="${BRAI_SQLITE_BACKUP_DIR:-/srv/projects/brai/data/backups}"
SQLITE_BIN="${BRAI_SQLITE_BIN:-/srv/opt/android-sdk/platform-tools/sqlite3}"
SERVICE_USER="${BRAI_SQLITE_SERVICE_USER:-brai}"
DEPLOY_USER="${BRAI_DEPLOY_USER:-brai-deploy}"
DEPLOY_GROUP="${BRAI_DEPLOY_GROUP:-brai-deploy}"
DEPLOY_HOST="${BRAI_DEPLOY_HOST:-localhost}"
DEPLOY_REPO="${BRAI_DEPLOY_REPO:-/srv/projects/brai-envs/prod/source}"
SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
SSH_KEY_FILE="${BRAI_DEPLOY_SSH_KEY_FILE:-${HOME:-}/.ssh/brai_deploy_ed25519}"
PROD_DB="/srv/projects/brai/data/brai.sqlite"
MODE="remote"

usage() {
  cat >&2 <<USAGE
Usage:
  $0 <operation-activity-id>...
  $0 --host-local <operation-activity-id>...
  $0 --local <operation-activity-id>...
  $0 --check-access
  $0 --host-local --check-access

Completes operation activities in live SQLite after creating a backup.
Default mode uses the host deploy SSH boundary and the deploy-owned prod source;
--host-local uses local sudo to enter the service user without SSH.
--local is for the host-side script invocation or tests with BRAI_DB outside $PROD_DB.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
CHECK_ACCESS=0
while [[ "${1:-}" == "--local" || "${1:-}" == "--host-local" || "${1:-}" == "--check-access" ]]; do
  case "$1" in
    --local)
      MODE="local"
      ;;
    --host-local)
      MODE="host-local"
      ;;
    --check-access)
      CHECK_ACCESS=1
      ;;
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
    if [[ ! "$id" =~ ^operation[:._-][A-Za-z0-9._:-]+$ ]]; then
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
echo "operation-helper-access=ok remote"
REMOTE
}

check_host_local_access() {
  local helper="$DEPLOY_REPO/deploy/scripts/complete-operation-activities.sh"
  if [[ ! -x "$helper" ]]; then
    echo "operation helper is not executable: $helper" >&2
    exit 1
  fi
  sudo -n -l -u "$SERVICE_USER" "$helper" --local operation:agent-task:access-contract-probe >/dev/null
  echo "operation-helper-access=ok host-local"
}

require_sqlite() {
  if [[ ! -x "$SQLITE_BIN" ]]; then
    echo "sqlite3 is not executable: $SQLITE_BIN" >&2
    exit 1
  fi
  if [[ ! -f "$DB_PATH" ]]; then
    echo "SQLite DB is missing: $DB_PATH" >&2
    exit 1
  fi
}

require_writer() {
  local user
  user="$(id -un)"
  if [[ "$DB_PATH" == "$PROD_DB" && "$user" != "$SERVICE_USER" ]]; then
    echo "Live SQLite writes must run in host service/deploy context, not $user." >&2
    echo "Use remote mode; it SSHes to $DEPLOY_USER@$DEPLOY_HOST and re-enters as $SERVICE_USER." >&2
    exit 2
  fi
  if [[ "$user" == "root" || "$user" == "$DEPLOY_USER" || ("$DB_PATH" == "$PROD_DB" && "$user" == "mark") ]]; then
    echo "Refusing live SQLite write as $user." >&2
    exit 2
  fi
}

verify_prod_permissions() {
  if [[ "$DB_PATH" != "$PROD_DB" ]]; then
    return
  fi

  local path group mode
  for path in "$(dirname "$DB_PATH")" "$BACKUP_DIR" "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
    if [[ ! -e "$path" ]]; then
      continue
    fi
    group="$(stat -c '%G' "$path")"
    mode="$(stat -c '%A' "$path")"
    if [[ "$group" != "$DEPLOY_GROUP" || "${mode:5:1}" != "w" ]]; then
      echo "Unexpected live SQLite permissions: $(stat -c '%n %U:%G %a' "$path")" >&2
      echo "Fix ownership/mode through Ansible or production SQLite maintenance, not this helper." >&2
      exit 2
    fi
  done
}

sql_list() {
  local first=1 id
  for id in "$@"; do
    if [[ "$first" -eq 0 ]]; then
      printf ','
    fi
    first=0
    printf "'%s'" "$id"
  done
}

complete_local() {
  require_writer
  require_sqlite
  verify_prod_permissions

  local now stamp backup_path ids expected existing new_count changed done_count
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_path="$BACKUP_DIR/brai-before-complete-operation-activities-$stamp.sqlite"
  ids="$(sql_list "$@")"
  expected="$#"

  existing="$("$SQLITE_BIN" "file:$DB_PATH?mode=ro" "
    SELECT COUNT(*)
    FROM activities
    WHERE activity_type_id = 'operation'
      AND author = 'Codex'
      AND deleted_at_utc IS NULL
      AND status IN ('New', 'Done')
      AND id IN ($ids);
  ")"
  if [[ "$existing" != "$expected" ]]; then
    echo "Expected $expected open Codex operation activities, found $existing." >&2
    exit 1
  fi

  new_count="$("$SQLITE_BIN" "file:$DB_PATH?mode=ro" "
    SELECT COUNT(*)
    FROM activities
    WHERE activity_type_id = 'operation'
      AND author = 'Codex'
      AND deleted_at_utc IS NULL
      AND status = 'New'
      AND id IN ($ids);
  ")"

  if [[ "$new_count" != "0" ]]; then
    umask 0002
    mkdir -p "$BACKUP_DIR"
    "$SQLITE_BIN" "$DB_PATH" ".backup '$backup_path'"
    chmod 0664 "$backup_path"

    changed="$("$SQLITE_BIN" "$DB_PATH" "
      BEGIN IMMEDIATE;
      UPDATE activities
      SET status = 'Done',
          completed_at_utc = COALESCE(completed_at_utc, '$now'),
          updated_at_utc = '$now'
      WHERE activity_type_id = 'operation'
        AND author = 'Codex'
        AND deleted_at_utc IS NULL
        AND status = 'New'
        AND id IN ($ids);
      SELECT changes();
      COMMIT;
    ")"
    if [[ "$changed" != "$new_count" ]]; then
      echo "Expected to update $new_count operation activities, changed $changed." >&2
      exit 1
    fi
    verify_prod_permissions
    echo "backup=$backup_path"
  else
    changed=0
    echo "backup=not_needed"
  fi

  done_count="$("$SQLITE_BIN" "file:$DB_PATH?mode=ro" "
    SELECT COUNT(*)
    FROM activities
    WHERE activity_type_id = 'operation'
      AND author = 'Codex'
      AND deleted_at_utc IS NULL
      AND status = 'Done'
      AND completed_at_utc IS NOT NULL
      AND id IN ($ids);
  ")"
  if [[ "$done_count" != "$expected" ]]; then
    echo "Expected $expected completed operation activities, found $done_count." >&2
    exit 1
  fi

  echo "updated=$changed"
  "$SQLITE_BIN" -header -column "file:$DB_PATH?mode=ro" "
    SELECT id, title, author, status, updated_at_utc, completed_at_utc
    FROM activities
    WHERE activity_type_id = 'operation'
      AND author = 'Codex'
      AND deleted_at_utc IS NULL
      AND id IN ($ids)
    ORDER BY id;
  "
}

if [[ "$CHECK_ACCESS" -eq 1 ]]; then
  if [[ "$MODE" == "remote" ]]; then
    check_remote_access
  elif [[ "$MODE" == "host-local" ]]; then
    check_host_local_access
  else
    require_sqlite
    echo "operation-helper-access=ok local"
  fi
elif [[ "$MODE" == "remote" ]]; then
  complete_remote "$@"
elif [[ "$MODE" == "host-local" ]]; then
  complete_host_local "$@"
else
  complete_local "$@"
fi
