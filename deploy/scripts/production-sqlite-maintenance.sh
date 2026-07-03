#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${BRAI_DB:-/srv/projects/brai/data/brai.sqlite}"
BACKUP_DIR="${BRAI_SQLITE_BACKUP_DIR:-/srv/projects/brai/data/backups}"
SQLITE_BIN="${BRAI_SQLITE_BIN:-/srv/opt/android-sdk/platform-tools/sqlite3}"
SERVICE_USER="${BRAI_SQLITE_SERVICE_USER:-brai}"

usage() {
  cat >&2 <<USAGE
Usage:
  $0 check
  $0 backup
  $0 exec-sql '<sql>'
  echo '<sql>' | $0 exec-sql
USAGE
}

require_sqlite() {
  if [[ ! -x "$SQLITE_BIN" ]]; then
    echo "sqlite3 is not executable: $SQLITE_BIN" >&2
    exit 1
  fi
}

require_db() {
  if [[ ! -f "$DB_PATH" ]]; then
    echo "SQLite DB is missing: $DB_PATH" >&2
    exit 1
  fi
}

require_writer() {
  local user
  user="$(id -un)"
  if [[ "$user" == "root" || "$user" == "mark" || "$user" != "$SERVICE_USER" ]]; then
    echo "write maintenance must run as $SERVICE_USER, not $user" >&2
    exit 2
  fi
}

stat_path() {
  local path="$1"
  if [[ -e "$path" ]]; then
    stat -c '%n %U:%G %a %F' "$path"
  else
    echo "$path missing"
  fi
}

check() {
  require_sqlite
  stat_path "$(dirname "$DB_PATH")"
  stat_path "$BACKUP_DIR"
  stat_path "$DB_PATH"
  stat_path "$DB_PATH-wal"
  stat_path "$DB_PATH-shm"
  require_db
  "$SQLITE_BIN" "file:$DB_PATH?mode=ro" 'PRAGMA journal_mode;'
}

backup() {
  require_writer
  require_sqlite
  require_db
  umask 0002
  mkdir -p "$BACKUP_DIR"
  chmod 2775 "$BACKUP_DIR"
  local stamp backup_path
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_path="$BACKUP_DIR/$(basename "$DB_PATH").$stamp.bak"
  "$SQLITE_BIN" "$DB_PATH" ".backup $backup_path"
  chmod 0664 "$backup_path"
  echo "$backup_path"
}

exec_sql() {
  require_writer
  require_sqlite
  require_db
  local sql
  if [[ "$#" -gt 0 ]]; then
    sql="$*"
  else
    sql="$(cat)"
  fi
  if [[ -z "${sql//[[:space:]]/}" ]]; then
    echo "missing SQL" >&2
    exit 1
  fi
  "$SQLITE_BIN" "$DB_PATH" "$sql"
}

command="${1:-}"
case "$command" in
  check)
    check
    ;;
  backup)
    backup
    ;;
  exec-sql)
    shift
    exec_sql "$@"
    ;;
  *)
    usage
    exit 1
    ;;
esac
