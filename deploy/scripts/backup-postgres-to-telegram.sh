#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${BRAI_POSTGRES_CONTAINER:-supabase-db}"
DATABASE="${BRAI_POSTGRES_DATABASE:-postgres}"
PGUSER="${BRAI_POSTGRES_USER:-postgres}"
TMPDIR="${BRAI_BACKUP_TMPDIR:-/tmp}"
MAX_BYTES="${TELEGRAM_MAX_DOCUMENT_BYTES:-52428800}"
SCHEMAS="${BRAI_BACKUP_SCHEMAS:-public auth storage realtime _realtime supabase_functions net vault}"
ENCRYPTION_KEY_FILE="${BRAI_BACKUP_ENCRYPTION_KEY_FILE:-/etc/brai/brai-db-telegram-backup.key}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
HOSTNAME_VALUE="$(hostname -f 2>/dev/null || hostname)"
BACKUP_FILE="$(mktemp "$TMPDIR/brai-postgres-$TIMESTAMP.XXXXXX.dump")"
ENCRYPTED_FILE="$(mktemp "$TMPDIR/brai-postgres-$TIMESTAMP.XXXXXX.dump.enc")"
LOCK_FILE="${BRAI_BACKUP_LOCK_FILE:-/tmp/brai-postgres-telegram-backup.lock}"

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID is required}"
[[ -r "$ENCRYPTION_KEY_FILE" ]] || { echo "backup encryption key file is not readable: $ENCRYPTION_KEY_FILE" >&2; exit 1; }

cleanup() {
  rm -f "$BACKUP_FILE" "$ENCRYPTED_FILE"
}
trap cleanup EXIT

send_status() {
  local status="$1"
  local message="$2"
  if [[ -n "${BRAI_DATABASE_URL:-}" && -x /srv/opt/node-v22.16.0/bin/node && -f /srv/projects/brai/deploy/scripts/record-runtime-log.mjs ]]; then
    /srv/opt/node-v22.16.0/bin/node /srv/projects/brai/deploy/scripts/record-runtime-log.mjs \
      --service brai-ops \
      --source systemd \
      --operation postgres_telegram_backup \
      --status "$status" \
      --message "$message" \
      --json "{\"plain_dump_bytes\":${BACKUP_BYTES:-0},\"encrypted_file_bytes\":${ENCRYPTED_BYTES:-0},\"telegram_limit_bytes\":$MAX_BYTES}" \
      >/dev/null 2>&1 || true
  fi
}

schema_args=()
for schema in $SCHEMAS; do
  schema_args+=(--schema="$schema")
done

(
  flock -n 9 || { echo "backup already running" >&2; exit 75; }

  docker exec "$CONTAINER" pg_dump \
    -U "$PGUSER" \
    -d "$DATABASE" \
    --format=custom \
    --compress=gzip:9 \
    "${schema_args[@]}" \
    > "$BACKUP_FILE"

  BACKUP_BYTES="$(wc -c < "$BACKUP_FILE")"
  export BACKUP_BYTES
  if (( BACKUP_BYTES <= 0 )); then
    send_status failed "Postgres backup dump is empty"
    echo "backup dump is empty" >&2
    exit 1
  fi
  if (( BACKUP_BYTES > MAX_BYTES )); then
    send_status failed "Postgres backup is larger than Telegram document limit"
    echo "backup is $BACKUP_BYTES bytes, Telegram limit is $MAX_BYTES bytes" >&2
    exit 1
  fi

  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
    -in "$BACKUP_FILE" \
    -out "$ENCRYPTED_FILE" \
    -pass "file:$ENCRYPTION_KEY_FILE"
  rm -f "$BACKUP_FILE"

  ENCRYPTED_BYTES="$(wc -c < "$ENCRYPTED_FILE")"
  export ENCRYPTED_BYTES
  if (( ENCRYPTED_BYTES <= 0 )); then
    send_status failed "Encrypted Postgres backup is empty"
    echo "encrypted backup is empty" >&2
    exit 1
  fi
  if (( ENCRYPTED_BYTES > MAX_BYTES )); then
    send_status failed "Encrypted Postgres backup is larger than Telegram document limit"
    echo "encrypted backup is $ENCRYPTED_BYTES bytes, Telegram limit is $MAX_BYTES bytes" >&2
    exit 1
  fi

  {
    printf 'url = "%s"\n' "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument"
    printf 'form = "chat_id=%s"\n' "$TELEGRAM_CHAT_ID"
    if [[ -n "${TELEGRAM_MESSAGE_THREAD_ID:-}" ]]; then
      printf 'form = "message_thread_id=%s"\n' "$TELEGRAM_MESSAGE_THREAD_ID"
    fi
    printf 'form = "caption=Brai Postgres production backup %s UTC from %s (%s bytes, encrypted)"\n' "$TIMESTAMP" "$HOSTNAME_VALUE" "$ENCRYPTED_BYTES"
    printf 'form = "document=@%s;filename=brai-postgres-prod-%s.dump.enc"\n' "$ENCRYPTED_FILE" "$TIMESTAMP"
  } | curl --fail --silent --show-error --config - >/dev/null

  send_status done "Encrypted Postgres backup sent to Telegram"
) 9>"$LOCK_FILE"
