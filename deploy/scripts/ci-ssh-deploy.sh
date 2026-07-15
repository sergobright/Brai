#!/usr/bin/env bash
# File-size exception: deploy, rollback, and cleanup traps share process-local ownership state; splitting this state machine would weaken fail-closed recovery.
set -euo pipefail

: "${BRAI_DEPLOY_HOST:?BRAI_DEPLOY_HOST is required}"
: "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
: "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"
: "${BRAI_BRANCH:?BRAI_BRANCH is required}"
: "${BRAI_COMMIT:?BRAI_COMMIT is required}"
[[ "$BRAI_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "BRAI_COMMIT must be a full lowercase SHA" >&2; exit 1; }

DEPLOY_REPO="${BRAI_DEPLOY_REPO:-/srv/projects/brai}"
SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
UPLOAD_ROOT="${BRAI_DEPLOY_UPLOAD_ROOT:-$ENVS_ROOT/ci-uploads}"
SAFE_BRANCH="$(printf '%s' "$BRAI_BRANCH" | tr -c 'A-Za-z0-9._-' '-')"
BRAI_PREVIEW_LEASE_GENERATION="${BRAI_PREVIEW_LEASE_GENERATION:-${GITHUB_RUN_ID:-}}"
ATTEMPT_ID="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${GITHUB_JOB:-deploy}-$$-$RANDOM"
SAFE_ATTEMPT_ID="$(printf '%s' "$ATTEMPT_ID" | tr -c 'A-Za-z0-9._-' '-')"
REMOTE_UPLOAD="$UPLOAD_ROOT/$SAFE_BRANCH-$BRAI_COMMIT.attempt-$SAFE_ATTEMPT_ID"
REMOTE_UPLOAD_NAME="$(basename "$REMOTE_UPLOAD")"
UPLOAD_MARKER=".brai-upload-terminal.json"
CLEANUP_TERMINAL_STATUS="failed"
REMOTE_UPLOAD_OWNED="false"
REMOTE_DEPLOY_OWNS_STAGING="false"
DEPLOY_MIN_FREE_GB="${BRAI_DEPLOY_MIN_FREE_GB:-12}"
if ! [[ "$DEPLOY_MIN_FREE_GB" =~ ^[0-9]+$ ]] || (( 10#$DEPLOY_MIN_FREE_GB < 12 )); then
  echo "BRAI_DEPLOY_MIN_FREE_GB must be an integer of at least 12 GiB, got: $DEPLOY_MIN_FREE_GB" >&2
  exit 1
fi
if [[ -z "${BRAI_NATIVE_APK_CHANGE:-}" ]]; then
  BRAI_NATIVE_APK_CHANGE="$(node deploy/scripts/detect-native-apk-change.mjs "$BRAI_BRANCH" "${BRAI_BASE_COMMIT:-}")"
fi
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-deploy-key.XXXXXX")"
cleanup_remote_upload() {
  [[ -f "$KEY_FILE" ]] || return 0
  ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
    bash -s -- "$REMOTE_UPLOAD" "$UPLOAD_ROOT" "$REMOTE_UPLOAD_NAME" "$BRAI_COMMIT" "$UPLOAD_MARKER" "$CLEANUP_TERMINAL_STATUS" <<'REMOTE' || true
set -euo pipefail
REMOTE_UPLOAD="$1"
UPLOAD_ROOT="$2"
REMOTE_UPLOAD_NAME="$3"
BRAI_COMMIT="$4"
UPLOAD_MARKER="$5"
TERMINAL_STATUS="$6"
[[ "$REMOTE_UPLOAD" == "$UPLOAD_ROOT/$REMOTE_UPLOAD_NAME" && "$REMOTE_UPLOAD_NAME" == *.attempt-* ]] || {
  echo "Refusing cleanup for non-attempt upload path: $REMOTE_UPLOAD" >&2
  exit 1
}
[[ "$BRAI_COMMIT" =~ ^[0-9a-f]{40}$ && "$REMOTE_UPLOAD_NAME" == *-"$BRAI_COMMIT".attempt-* ]] || {
  echo "Refusing cleanup for mismatched deployment commit" >&2
  exit 1
}
[[ "$TERMINAL_STATUS" == "failed" || "$TERMINAL_STATUS" == "cancelled" || "$TERMINAL_STATUS" == "succeeded" ]] || {
  echo "Refusing invalid terminal upload status: $TERMINAL_STATUS" >&2
  exit 1
}
[[ -d "$UPLOAD_ROOT" && ! -L "$UPLOAD_ROOT" ]] || exit 1
STAGING_OPERATION_LOCK="$UPLOAD_ROOT/.staging-operation.lock"
[[ -f "$STAGING_OPERATION_LOCK" && ! -L "$STAGING_OPERATION_LOCK" ]] || exit 1
exec 7<>"$STAGING_OPERATION_LOCK"
flock 7
if [[ -e "$REMOTE_UPLOAD" || -L "$REMOTE_UPLOAD" ]]; then
  if [[ -d "$REMOTE_UPLOAD" && ! -L "$REMOTE_UPLOAD" ]]; then
    {
      marker_tmp="$REMOTE_UPLOAD/$UPLOAD_MARKER.tmp-$$"
      finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf '{"status":"%s","commit":"%s","finishedAt":"%s"}\n' \
        "$TERMINAL_STATUS" "$BRAI_COMMIT" "$finished_at" >"$marker_tmp"
      mv -f -- "$marker_tmp" "$REMOTE_UPLOAD/$UPLOAD_MARKER"
    } || true
  fi
  rm -rf -- "$REMOTE_UPLOAD"
fi
REMOTE
}
cleanup() {
  local status=$?
  trap - EXIT ERR TERM INT HUP
  set +e
  if (( status == 0 )); then
    CLEANUP_TERMINAL_STATUS="succeeded"
  fi
  if [[ "$REMOTE_UPLOAD_OWNED" == "true" && "$REMOTE_DEPLOY_OWNS_STAGING" != "true" ]]; then
    cleanup_remote_upload
  fi
  rm -f "$KEY_FILE"
  exit "$status"
}
abort() {
  local status="$1"
  CLEANUP_TERMINAL_STATUS="${2:-failed}"
  trap - ERR
  exit "$status"
}
trap cleanup EXIT
trap 'abort $?' ERR
trap 'abort 129 cancelled' HUP
trap 'abort 130 cancelled' INT
trap 'abort 143 cancelled' TERM

printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
  bash -s -- "$REMOTE_UPLOAD" "$UPLOAD_ROOT" "$REMOTE_UPLOAD_NAME" "$BRAI_COMMIT" "$UPLOAD_MARKER" "$DEPLOY_MIN_FREE_GB" <<'REMOTE'
set -euo pipefail
REMOTE_UPLOAD="$1"
UPLOAD_ROOT="$2"
REMOTE_UPLOAD_NAME="$3"
BRAI_COMMIT="$4"
UPLOAD_MARKER="$5"
DEPLOY_MIN_FREE_GB="$6"
umask 0002
[[ "$REMOTE_UPLOAD" == "$UPLOAD_ROOT/$REMOTE_UPLOAD_NAME" && "$REMOTE_UPLOAD_NAME" == *.attempt-* ]] || {
  echo "Refusing to create non-attempt upload path: $REMOTE_UPLOAD" >&2
  exit 1
}
[[ "$BRAI_COMMIT" =~ ^[0-9a-f]{40}$ && "$REMOTE_UPLOAD_NAME" == *-"$BRAI_COMMIT".attempt-* ]] || {
  echo "Refusing upload for mismatched deployment commit" >&2
  exit 1
}
check_upload_headroom() {
  local available_kb
  available_kb="$(df -Pk "$UPLOAD_ROOT" | awk 'NR == 2 { print $4 }')"
  local required_kb=$((10#$DEPLOY_MIN_FREE_GB * 1024 * 1024))
  if (( available_kb < required_kb )); then
    echo "Not enough free disk space before upload: need at least ${DEPLOY_MIN_FREE_GB} GiB, have $((available_kb / 1024 / 1024)) GiB." >&2
    return 1
  fi
}
[[ -d "$UPLOAD_ROOT" && ! -L "$UPLOAD_ROOT" ]] || {
  echo "CI upload root is missing or unsafe: $UPLOAD_ROOT" >&2
  exit 1
}
STAGING_OPERATION_LOCK="$UPLOAD_ROOT/.staging-operation.lock"
[[ -f "$STAGING_OPERATION_LOCK" && ! -L "$STAGING_OPERATION_LOCK" ]] || {
  echo "Staging operation lock is missing or unsafe: $STAGING_OPERATION_LOCK" >&2
  exit 1
}
exec 7<>"$STAGING_OPERATION_LOCK"
flock 7
check_upload_headroom
mkdir "$REMOTE_UPLOAD"
marker_tmp="$REMOTE_UPLOAD/$UPLOAD_MARKER.tmp-$$"
printf '{"status":"active","commit":"%s","finishedAt":null}\n' "$BRAI_COMMIT" >"$marker_tmp"
mv -f -- "$marker_tmp" "$REMOTE_UPLOAD/$UPLOAD_MARKER"
find "$REMOTE_UPLOAD" -type d -exec chmod 2775 {} +
REMOTE
REMOTE_UPLOAD_OWNED="true"

REMOTE_EXTRACT_SCRIPT=""
read -r -d '' REMOTE_EXTRACT_SCRIPT <<'REMOTE_EXTRACT' || true
set -euo pipefail
REMOTE_UPLOAD="$1"
UPLOAD_ROOT="$2"
REMOTE_UPLOAD_NAME="$3"
BRAI_COMMIT="$4"
UPLOAD_MARKER="$5"
UPLOAD_SUCCEEDED="false"
TERMINAL_STATUS="failed"
[[ -d "$UPLOAD_ROOT" && ! -L "$UPLOAD_ROOT" ]] || exit 1
STAGING_OPERATION_LOCK="$UPLOAD_ROOT/.staging-operation.lock"
[[ -f "$STAGING_OPERATION_LOCK" && ! -L "$STAGING_OPERATION_LOCK" ]] || exit 1
exec 7<>"$STAGING_OPERATION_LOCK"
flock 7
write_upload_terminal_marker() {
  [[ "$REMOTE_UPLOAD" == "$UPLOAD_ROOT/$REMOTE_UPLOAD_NAME" && "$REMOTE_UPLOAD_NAME" == *-"$BRAI_COMMIT".attempt-* ]] || return 1
  [[ "$BRAI_COMMIT" =~ ^[0-9a-f]{40}$ \
    && -d "$REMOTE_UPLOAD" && ! -L "$REMOTE_UPLOAD" ]] || return 1
  local marker_tmp="$REMOTE_UPLOAD/$UPLOAD_MARKER.tmp-$$"
  local finished_at
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"status":"%s","commit":"%s","finishedAt":"%s"}\n' \
    "$TERMINAL_STATUS" "$BRAI_COMMIT" "$finished_at" >"$marker_tmp"
  mv -f -- "$marker_tmp" "$REMOTE_UPLOAD/$UPLOAD_MARKER"
}
finish_upload() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$UPLOAD_SUCCEEDED" != "true" ]]; then
    write_upload_terminal_marker || true
  fi
  exit "$status"
}
abort_upload() {
  TERMINAL_STATUS="cancelled"
  UPLOAD_SUCCEEDED="false"
  trap - HUP INT TERM
  exit "$1"
}
trap finish_upload EXIT
trap "abort_upload 129" HUP
trap "abort_upload 130" INT
trap "abort_upload 143" TERM
tar -xzf - -C "$REMOTE_UPLOAD"
UPLOAD_SUCCEEDED="true"
REMOTE_EXTRACT
printf -v REMOTE_EXTRACT_COMMAND 'bash -c %q bash %q %q %q %q %q' \
  "$REMOTE_EXTRACT_SCRIPT" "$REMOTE_UPLOAD" "$UPLOAD_ROOT" "$REMOTE_UPLOAD_NAME" "$BRAI_COMMIT" "$UPLOAD_MARKER"

tar \
  --exclude=.git \
  --exclude=node_modules \
  --exclude='*/node_modules' \
  --exclude=.next \
  --exclude=out \
  --exclude='*/build' \
  --exclude='*/.gradle' \
  --exclude=deploy/site \
  --exclude=deploy/web \
  --exclude=deploy/mobile-update \
  --exclude=deploy/releases \
  --exclude=.brai-upload-terminal.json \
  -czf - . | ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
    "$REMOTE_EXTRACT_COMMAND"

DEPLOY_OUTPUT=""
REMOTE_DEPLOY_OWNS_STAGING="true"
REMOTE_UPLOAD_OWNED="false"
printf -v REMOTE_DEPLOY_COMMAND 'bash -s -- %q %q %q %q %q %q %q %q %q' \
  "$DEPLOY_REPO" "$REMOTE_UPLOAD" "$BRAI_BRANCH" "$BRAI_COMMIT" "$BRAI_NATIVE_APK_CHANGE" \
  "$BRAI_PREVIEW_LEASE_GENERATION" "$UPLOAD_ROOT" "$UPLOAD_MARKER" "$DEPLOY_MIN_FREE_GB"
if ! DEPLOY_OUTPUT="$(ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
  "$REMOTE_DEPLOY_COMMAND" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
REMOTE_UPLOAD="$2"
BRAI_BRANCH="$3"
BRAI_COMMIT="$4"
BRAI_NATIVE_APK_CHANGE="$5"
BRAI_PREVIEW_LEASE_GENERATION="${6:-}"
UPLOAD_ROOT="$7"
UPLOAD_MARKER="$8"
DEPLOY_MIN_FREE_GB="$9"
ATTEMPT_STAGING="$REMOTE_UPLOAD"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
NODE_PREFIX="${BRAI_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ -d "$NODE_PREFIX" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
fi

cd "$REMOTE_UPLOAD"
allocation_field() {
  node -e 'let raw = ""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => { const value = JSON.parse(raw)[process.argv[1]]; console.log(value == null ? "" : value); });' "$1"
}
env_database_url() {
  local env_file="$1"
  (
    set -a
    # shellcheck source=/dev/null
    . "$env_file"
    set +a
    printf '%s' "${BRAI_DATABASE_URL:-}"
  )
}
env_release_password() {
  local env_file="$1"
  (
    set -a
    # shellcheck source=/dev/null
    . "$env_file"
    set +a
    printf '%s' "${BRAI_RELEASE_PASSWORD:-}"
  )
}
check_deploy_headroom() {
  local root="$1"
  local min_gb="$DEPLOY_MIN_FREE_GB"
  if ! [[ "$min_gb" =~ ^[0-9]+$ ]] || (( 10#$min_gb < 12 )); then
    echo "BRAI_DEPLOY_MIN_FREE_GB must be an integer of at least 12 GiB, got: $min_gb" >&2
    exit 1
  fi
  mkdir -p "$root"
  local available_kb
  available_kb="$(df -Pk "$root" | awk 'NR == 2 { print $4 }')"
  local required_kb=$((10#$min_gb * 1024 * 1024))
  if (( available_kb < required_kb )); then
    echo "Not enough free disk space under $root: need at least ${min_gb} GiB before deploy, have $((available_kb / 1024 / 1024)) GiB." >&2
    exit 1
  fi
}
is_deploy_attempt_suffix() {
  local suffix="$1"
  [[ "$suffix" =~ ^[0-9]{14}-[0-9]+$ \
    || "$suffix" =~ ^(local|[0-9]+)-[0-9]+-[A-Za-z0-9._-]+-[0-9]+-[0-9]+$ ]]
}
assert_attempt_staging_path() {
  local path="$1"
  local name
  local suffix="${DEPLOY_ATTEMPT_SUFFIX:-}"
  name="$(basename "$path")"
  [[ "$BRAI_COMMIT" =~ ^[0-9a-f]{40}$ \
    && -n "$path" && "$path" == "$ATTEMPT_STAGING" \
    && "$path" == "$UPLOAD_ROOT/$name" \
    && "$name" == *-"$BRAI_COMMIT".attempt-"$suffix" ]] \
    && is_deploy_attempt_suffix "$suffix"
}
remove_attempt_staging() {
  local terminal_status="${1:-failed}"
  [[ ! -e "$ATTEMPT_STAGING" && ! -L "$ATTEMPT_STAGING" ]] && return 0
  assert_attempt_staging_path "$ATTEMPT_STAGING" || {
    echo "Refusing cleanup for non-attempt staging path: $ATTEMPT_STAGING" >&2
    return 1
  }
  write_attempt_terminal_marker "$terminal_status" || true
  rm -rf -- "$ATTEMPT_STAGING"
}
write_attempt_terminal_marker() {
  local status="$1"
  [[ "$status" == "failed" || "$status" == "cancelled" || "$status" == "succeeded" ]] || {
    echo "Refusing invalid terminal upload status: $status" >&2
    return 1
  }
  assert_attempt_staging_path "$ATTEMPT_STAGING" || return 1
  [[ -d "$ATTEMPT_STAGING" && ! -L "$ATTEMPT_STAGING" ]] || return 0
  local marker_tmp="$ATTEMPT_STAGING/$UPLOAD_MARKER.tmp-$$"
  local finished_at
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"status":"%s","commit":"%s","finishedAt":"%s"}\n' \
    "$status" "$BRAI_COMMIT" "$finished_at" >"$marker_tmp"
  mv -f -- "$marker_tmp" "$ATTEMPT_STAGING/$UPLOAD_MARKER"
}
mark_preview_failed() {
  if [[ "$BRAI_BRANCH" == codex/* && -n "${BRAI_PREVIEW_SLOT:-}" ]]; then
    deploy/scripts/preview-slots.sh failed "$BRAI_BRANCH" "$BRAI_COMMIT" >/dev/null || true
  fi
}
restore_previous_source() {
  if [[ "${PREVIOUS_SOURCE_READY:-false}" == "true" ]]; then
    if [[ -d "${SOURCE_ROOT:-}" ]]; then
      [[ ! -e "$ATTEMPT_STAGING" ]] || return 1
      mv "$SOURCE_ROOT" "$ATTEMPT_STAGING" || return 1
    fi
    mv "$PREVIOUS_SOURCE" "$SOURCE_ROOT" || return 1
    PREVIOUS_SOURCE_READY="false"
    SOURCE_SWAPPED="false"
    return 0
  fi
  if [[ "${SOURCE_SWAPPED:-false}" == "true" && -d "${SOURCE_ROOT:-}" ]]; then
    [[ ! -e "$ATTEMPT_STAGING" ]] || return 1
    mv "$SOURCE_ROOT" "$ATTEMPT_STAGING" || return 1
    SOURCE_SWAPPED="false"
  fi
}
assert_api_quiesced() {
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "$SERVICE_NAME remained active after the deployment drain barrier" >&2
    return 1
  fi
  local main_pid
  if ! main_pid="$(systemctl show "$SERVICE_NAME" --property MainPID --value)"; then
    echo "Cannot verify $SERVICE_NAME MainPID after the deployment drain barrier" >&2
    return 1
  fi
  if [[ "${main_pid:-0}" != "0" ]]; then
    echo "$SERVICE_NAME retained MainPID $main_pid after the deployment drain barrier" >&2
    return 1
  fi
}
wait_for_api_health() {
  local label="${1:-API}"
  local url="http://127.0.0.1:$API_PORT/health"
  local attempt
  for attempt in {1..40}; do
    if systemctl is-active --quiet "$SERVICE_NAME" \
      && node -e 'fetch(process.argv[1]).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));' "$url"; then
      return 0
    fi
    sleep 0.5
  done
  echo "$label health check failed ($ENVIRONMENT): $url" >&2
  return 1
}
wait_for_broker_health() {
  local label="${1:-Codex broker}"
  local attempt
  for attempt in {1..40}; do
    if systemctl is-active --quiet "$BROKER_SERVICE_NAME" \
      && node "$SOURCE_ROOT/services/brai_codex_broker/src/check.mjs" "$BROKER_SOCKET_PATH"; then
      return 0
    fi
    sleep 0.5
  done
  echo "$label readiness check failed ($ENVIRONMENT): $BROKER_SOCKET_PATH" >&2
  return 1
}
rollback_before_new_api_health() {
  local rollback_failed=0

  if [[ -z "${SERVICE_NAME:-}" ]]; then
    restore_previous_source || return 1
    return 0
  fi

  if [[ "${SOURCE_SWAPPED:-false}" == "true" ]]; then
    if ! "${BRAI_SUDO:-sudo}" systemctl stop "$SERVICE_NAME"; then
      echo "Cannot stop failed incoming $SERVICE_NAME before source rollback" >&2
      rollback_failed=1
    elif ! assert_api_quiesced; then
      echo "Failed incoming $SERVICE_NAME did not quiesce before source rollback" >&2
      rollback_failed=1
    fi
  fi

  if (( rollback_failed == 0 )) && ! restore_previous_source; then
    echo "Cannot restore the previous source for $SERVICE_NAME" >&2
    rollback_failed=1
  fi

  if (( rollback_failed == 0 )) && [[ -n "${BROKER_SERVICE_NAME:-}" ]]; then
    if [[ "${BROKER_WAS_ACTIVE:-false}" == "true" ]]; then
      if ! "${BRAI_SUDO:-sudo}" systemctl restart "$BROKER_SERVICE_NAME"; then
        echo "Cannot restart restored $BROKER_SERVICE_NAME" >&2
        rollback_failed=1
      elif ! wait_for_broker_health "Restored Codex broker"; then
        echo "Restored $BROKER_SERVICE_NAME did not become ready" >&2
        rollback_failed=1
      fi
    elif ! "${BRAI_SUDO:-sudo}" systemctl stop "$BROKER_SERVICE_NAME"; then
      echo "Cannot restore inactive state for $BROKER_SERVICE_NAME" >&2
      rollback_failed=1
    fi
  fi

  if (( rollback_failed == 0 )); then
    if [[ "${API_WAS_ACTIVE:-false}" == "true" ]]; then
      if ! "${BRAI_SUDO:-sudo}" systemctl restart "$SERVICE_NAME"; then
        echo "Cannot restart restored $SERVICE_NAME" >&2
        rollback_failed=1
      elif ! wait_for_api_health "Restored API"; then
        echo "Restored $SERVICE_NAME did not become healthy" >&2
        rollback_failed=1
      else
        echo "Restored $SERVICE_NAME is healthy after rollback."
      fi
    elif ! assert_api_quiesced; then
      echo "Previously inactive $SERVICE_NAME did not remain inactive after rollback" >&2
      rollback_failed=1
    else
      echo "Restored the previously inactive $SERVICE_NAME state after rollback."
    fi
  fi

  return "$rollback_failed"
}
reconcile_source_swap_state() {
  if [[ "${PREVIOUS_SOURCE_READY:-false}" != "true" && -n "${PREVIOUS_SOURCE:-}" \
    && -d "$PREVIOUS_SOURCE" && ! -e "${SOURCE_ROOT:-}" ]]; then
    PREVIOUS_SOURCE_READY="true"
  fi
  if [[ "${SOURCE_SWAPPED:-false}" != "true" && -d "${SOURCE_ROOT:-}" \
    && ! -e "$ATTEMPT_STAGING" \
    && ( "${PREVIOUS_SOURCE_READY:-false}" == "true" || "${SOURCE_PRESENT:-false}" == "false" ) ]]; then
    SOURCE_SWAPPED="true"
  fi
}
deploy_cleanup() {
  local status="${1:-$?}"
  [[ "${DEPLOY_CLEANUP_RUNNING:-false}" != "true" ]] || exit "$status"
  DEPLOY_CLEANUP_RUNNING="true"
  trap - EXIT ERR TERM INT HUP
  set +e

  local terminal_status="failed"
  if (( status == 0 )); then
    terminal_status="succeeded"
  elif (( status == 129 || status == 130 || status == 143 )); then
    terminal_status="cancelled"
  fi
  if (( status != 0 )); then
    reconcile_source_swap_state
    if [[ "${NEW_API_HEALTHY:-false}" != "true" \
      && ( "${API_TRANSITION_STARTED:-false}" == "true" \
        || "${API_QUIESCED:-false}" == "true" \
        || "${SOURCE_SWAPPED:-false}" == "true" \
        || "${PREVIOUS_SOURCE_READY:-false}" == "true" ) ]]; then
      if ! rollback_before_new_api_health; then
        echo "Rollback verification failed after the original deployment error; ${SERVICE_NAME:-API} remains failed closed." >&2
      fi
    fi
    mark_preview_failed
  fi

  cleanup_preview_queue
  remove_attempt_staging "$terminal_status" || true
  exit "$status"
}
run_goal_agent_drain_check() {
  local database_url="$1"
  local phase="$2"
  local output
  if ! output="$(BRAI_DATABASE_URL="$database_url" node deploy/scripts/goal-agent-drain-check.mjs \
    --environment "$ENVIRONMENT" \
    --current-source "$SOURCE_ROOT" \
    --expected-branch "$BRAI_BRANCH")"; then
    echo "Goal-agent drain check failed during $phase: $output" >&2
    return 1
  fi
  printf 'Goal-agent drain check (%s): %s\n' "$phase" "$output"
  DRAIN_NONTERMINAL="$(printf '%s' "$output" | allocation_field nonterminal)"
  DRAIN_PRESERVE_TARGET="$(printf '%s' "$output" | allocation_field preserveTargetData)"
  DRAIN_STATE_DIGEST="$(printf '%s' "$output" | allocation_field stateDigest)"
  [[ "$DRAIN_NONTERMINAL" =~ ^[0-9]+$ ]] || {
    echo "Goal-agent drain check returned an invalid nonterminal count" >&2
    return 1
  }
  [[ "$DRAIN_PRESERVE_TARGET" == "true" || "$DRAIN_PRESERVE_TARGET" == "false" ]] || {
    echo "Goal-agent drain check returned an invalid preservation decision" >&2
    return 1
  }
  [[ "$DRAIN_STATE_DIGEST" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Goal-agent drain check returned an invalid state digest" >&2
    return 1
  }
}
run_goal_agent_temporal_empty_check() {
  local phase="$1"
  local output
  if ! output="$(node deploy/scripts/goal-agent-drain-check.mjs \
    --environment "$ENVIRONMENT" \
    --require-empty-temporal true)"; then
    echo "Goal-agent Temporal empty check failed during $phase: $output" >&2
    return 1
  fi
  printf 'Goal-agent Temporal empty check (%s): %s\n' "$phase" "$output"
  [[ "$(printf '%s' "$output" | allocation_field ok)" == "true" ]] || {
    echo "Goal-agent Temporal empty check returned an invalid result" >&2
    return 1
  }
  [[ "$(printf '%s' "$output" | allocation_field temporalRunning)" == "0" ]] || {
    echo "Goal-agent Temporal empty check returned a non-empty inventory" >&2
    return 1
  }
}
cleanup_preview_queue() {
  if [[ "${BRAI_PREVIEW_QUEUED:-}" == "true" ]]; then
    deploy/scripts/preview-slots.sh dequeue "$BRAI_BRANCH" >/dev/null || true
  fi
}
DEPLOY_ATTEMPT_SUFFIX="${ATTEMPT_STAGING##*.attempt-}"
is_deploy_attempt_suffix "$DEPLOY_ATTEMPT_SUFFIX" || {
  echo "Invalid deployment attempt staging path: $ATTEMPT_STAGING" >&2
  exit 1
}
assert_attempt_staging_path "$ATTEMPT_STAGING" || {
  echo "Refusing deployment from non-attempt staging path: $ATTEMPT_STAGING" >&2
  exit 1
}
BRAI_PREVIEW_QUEUED="false"
SOURCE_ROOT=""
PREVIOUS_SOURCE=""
SOURCE_SWAPPED="false"
PREVIOUS_SOURCE_READY="false"
API_WAS_ACTIVE="false"
BROKER_WAS_ACTIVE="false"
API_TRANSITION_STARTED="false"
API_QUIESCED="false"
NEW_API_HEALTHY="false"
DEPLOY_CLEANUP_RUNNING="false"
trap 'deploy_cleanup $?' EXIT
trap 'deploy_cleanup $?' ERR
trap 'deploy_cleanup 129' HUP
trap 'deploy_cleanup 130' INT
trap 'deploy_cleanup 143' TERM
if [[ "$BRAI_BRANCH" == codex/* ]]; then
  [[ -n "$BRAI_PREVIEW_LEASE_GENERATION" ]] || {
    echo "BRAI_PREVIEW_LEASE_GENERATION or GITHUB_RUN_ID is required for Preview deploy." >&2
    exit 1
  }
  QUEUE_MAX_ATTEMPTS="${BRAI_PREVIEW_QUEUE_MAX_ATTEMPTS:-720}"
  QUEUE_POLL_SECONDS="${BRAI_PREVIEW_QUEUE_POLL_SECONDS:-30}"
  for ((attempt = 1; attempt <= QUEUE_MAX_ATTEMPTS; attempt += 1)); do
    ALLOCATION_JSON="$(deploy/scripts/preview-slots.sh allocate "$BRAI_BRANCH" "$BRAI_COMMIT" "$BRAI_PREVIEW_LEASE_GENERATION")"
    BRAI_PREVIEW_QUEUED="$(printf '%s' "$ALLOCATION_JSON" | allocation_field queued)"
    if [[ "$BRAI_PREVIEW_QUEUED" != "true" ]]; then
      break
    fi
    QUEUE_POSITION="$(printf '%s' "$ALLOCATION_JSON" | allocation_field position)"
    echo "All preview slots are occupied; queued at position $QUEUE_POSITION. Waiting ${QUEUE_POLL_SECONDS}s for a released slot."
    if (( attempt == QUEUE_MAX_ATTEMPTS )); then
      echo "Timed out waiting for a preview slot after $QUEUE_MAX_ATTEMPTS attempts." >&2
      exit 1
    fi
    sleep "$QUEUE_POLL_SECONDS"
  done
  BRAI_PREVIEW_QUEUED="false"
  BRAI_PREVIEW_SLOT="$(printf '%s' "$ALLOCATION_JSON" | allocation_field slot)"
  BRAI_PREVIEW_ALLOCATED_NEW="$(printf '%s' "$ALLOCATION_JSON" | allocation_field allocatedNew)"
  BRAI_PREVIEW_RECOVERING_FAILED="$(printf '%s' "$ALLOCATION_JSON" | allocation_field recoveringFailed)"
  export BRAI_PREVIEW_SLOT BRAI_PREVIEW_ALLOCATED_NEW BRAI_PREVIEW_RECOVERING_FAILED
  printf 'BRAI_PREVIEW_SLOT_OUTPUT=%s\n' "$BRAI_PREVIEW_SLOT"
fi

mapfile -t DEPLOY_META < <(node deploy/scripts/resolve-deploy-env.mjs "$BRAI_BRANCH")
ENVIRONMENT="${DEPLOY_META[0]}"
ENV_PATH="${DEPLOY_META[3]}"
SERVICE_NAME="${DEPLOY_META[4]}"
API_PORT="${DEPLOY_META[5]}"
BROKER_SERVICE_NAME="${DEPLOY_META[8]}"
BROKER_SOCKET_PATH="${DEPLOY_META[9]}"
SOURCE_ROOT="$ENVS_ROOT/$ENV_PATH/source"
GOAL_AGENT_RUNTIME_GROUP="${BRAI_GOAL_AGENT_GROUP:-brai-goal-agent}"
case "$SOURCE_ROOT" in
  "$ENVS_ROOT"/*/source) ;;
  *)
    echo "Refusing to reset source path outside $ENVS_ROOT: $SOURCE_ROOT" >&2
    exit 1
    ;;
esac
[[ -d "$ENVS_ROOT" && ! -L "$ENVS_ROOT" ]] || {
  echo "Deployment environment root is missing or unsafe: $ENVS_ROOT" >&2
  exit 1
}
ENV_ROOT="$(dirname "$SOURCE_ROOT")"
[[ -d "$ENV_ROOT" && ! -L "$ENV_ROOT" ]] || {
  echo "Deployment environment directory is missing or unsafe: $ENV_ROOT" >&2
  exit 1
}
SOURCE_OPERATION_LOCK="$ENV_ROOT/.source-operation.lock"
[[ -f "$SOURCE_OPERATION_LOCK" && ! -L "$SOURCE_OPERATION_LOCK" ]] || {
  echo "Source operation lock is missing or unsafe: $SOURCE_OPERATION_LOCK" >&2
  exit 1
}
exec 8<>"$SOURCE_OPERATION_LOCK"
flock 8
export BRAI_SOURCE_OPERATION_LOCK_HELD=true
[[ -d "$UPLOAD_ROOT" && ! -L "$UPLOAD_ROOT" ]] || {
  echo "CI upload root is missing or unsafe: $UPLOAD_ROOT" >&2
  exit 1
}
STAGING_OPERATION_LOCK="$UPLOAD_ROOT/.staging-operation.lock"
[[ -f "$STAGING_OPERATION_LOCK" && ! -L "$STAGING_OPERATION_LOCK" ]] || {
  echo "Staging operation lock is missing or unsafe: $STAGING_OPERATION_LOCK" >&2
  exit 1
}
exec 7<>"$STAGING_OPERATION_LOCK"
flock 7
check_deploy_headroom "$ENVS_ROOT"
deploy/scripts/goal-agent-infrastructure-preflight.sh "$ENVIRONMENT"

if [[ "$ENVIRONMENT" == "prod" ]]; then
  export BRAI_WEB_TARGET="$DEPLOY_REPO/deploy/web"
  export BRAI_PUBLIC_SITE_TARGET="$DEPLOY_REPO/deploy/site"
  export BRAI_MOBILE_TARGET="$DEPLOY_REPO/deploy/mobile-update"
fi
cd "$REMOTE_UPLOAD"
umask 0002
npm ci
npm --prefix apps/brai_app ci
npm --prefix services/brai_api ci
npm --prefix services/brai_goal_agents ci
npm --prefix admin ci
exec 7>&-
find "$REMOTE_UPLOAD" ! -type l -user "$(id -u)" -exec chmod u+rwX,g+rwX {} +
find "$REMOTE_UPLOAD" -type d -user "$(id -u)" -exec chmod g+s {} +

SOURCE_PRESENT="false"
if [[ -e "$SOURCE_ROOT" || -L "$SOURCE_ROOT" ]]; then
  [[ -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] || {
    echo "Existing source path is not a plain directory: $SOURCE_ROOT" >&2
    exit 1
  }
  SOURCE_PRESENT="true"
  find "$SOURCE_ROOT" ! -type l -user "$(id -u)" -exec chmod u+rwX,g+rwX {} + || true
fi
PREVIOUS_SOURCE="${SOURCE_ROOT}.previous-${DEPLOY_ATTEMPT_SUFFIX}"
[[ ! -e "$PREVIOUS_SOURCE" && ! -L "$PREVIOUS_SOURCE" ]] || {
  echo "Owned previous source path already exists: $PREVIOUS_SOURCE" >&2
  exit 1
}

if [[ "$ENVIRONMENT" == preview-* ]]; then
  exec 9>>"$ENVS_ROOT/preview-slots.lock"
  flock 9
  BRAI_ROOT="$REMOTE_UPLOAD" BRAI_ENVS_ROOT="$ENVS_ROOT" \
    node deploy/scripts/preview-slots.mjs assert-owned "$BRAI_BRANCH" "$BRAI_COMMIT" >/dev/null
  exec 9>&-
fi

[[ -r "/etc/brai/supabase-deploy.env" ]] || { echo "/etc/brai/supabase-deploy.env is required" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. /etc/brai/supabase-deploy.env
set +a
[[ -r "/etc/brai/brai-api.env" ]] || { echo "/etc/brai/brai-api.env is required and must be readable" >&2; exit 1; }
BRAI_PROD_DATABASE_URL="$(env_database_url /etc/brai/brai-api.env)"
[[ -n "$BRAI_PROD_DATABASE_URL" ]] || { echo "BRAI_DATABASE_URL is missing in /etc/brai/brai-api.env" >&2; exit 1; }
export BRAI_PROD_DATABASE_URL
BRAI_RELEASE_PASSWORD="$(env_release_password /etc/brai/brai-api.env)"
[[ -n "$BRAI_RELEASE_PASSWORD" ]] || { echo "BRAI_RELEASE_PASSWORD is missing in /etc/brai/brai-api.env" >&2; exit 1; }
export BRAI_RELEASE_PASSWORD

CURRENT_DATABASE_URL=""
if [[ "$ENVIRONMENT" == "prod" ]]; then
  CURRENT_DATABASE_URL="$BRAI_PROD_DATABASE_URL"
elif [[ "$SOURCE_PRESENT" == "true" ]]; then
  RUNTIME_ENV="$ENVS_ROOT/$ENV_PATH/brai-api.env"
  [[ -r "$RUNTIME_ENV" ]] || { echo "$RUNTIME_ENV is required for an existing $ENVIRONMENT deploy" >&2; exit 1; }
  CURRENT_DATABASE_URL="$(env_database_url "$RUNTIME_ENV")"
  [[ -n "$CURRENT_DATABASE_URL" ]] || { echo "BRAI_DATABASE_URL is missing in $RUNTIME_ENV" >&2; exit 1; }
fi

if systemctl is-active --quiet "$BROKER_SERVICE_NAME"; then
  BROKER_WAS_ACTIVE="true"
fi

if systemctl is-active --quiet "$SERVICE_NAME"; then
  if [[ "$SOURCE_PRESENT" != "true" ]]; then
    echo "$SERVICE_NAME is active while $SOURCE_ROOT is absent; refusing first-install bypass" >&2
    exit 1
  fi
  API_WAS_ACTIVE="true"
  API_TRANSITION_STARTED="true"
  "${BRAI_SUDO:-sudo}" systemctl stop "$SERVICE_NAME"
fi
API_QUIESCED="true"
assert_api_quiesced
if [[ "$SOURCE_PRESENT" != "true" && "$ENVIRONMENT" == preview-* \
  && "${BRAI_PREVIEW_ALLOCATED_NEW:-false}" != "true" \
  && "${BRAI_PREVIEW_RECOVERING_FAILED:-false}" != "true" ]]; then
  echo "Missing Preview source is safe only for a new slot or exact failed-deploy recovery" >&2
  exit 1
fi

PRE_DRAIN_STATE_DIGEST=""
DRAIN_PRESERVE_TARGET="false"
if [[ "$SOURCE_PRESENT" == "true" ]]; then
  run_goal_agent_drain_check "$CURRENT_DATABASE_URL" "before-data-setup"
  PRE_DRAIN_STATE_DIGEST="$DRAIN_STATE_DIGEST"
else
  run_goal_agent_temporal_empty_check "before-data-setup"
fi

if [[ "$ENVIRONMENT" == "prod" ]]; then
  BRAI_DATABASE_URL="$CURRENT_DATABASE_URL" node deploy/scripts/supabase-branch.mjs migrate
  BRAI_DATABASE_URL="$CURRENT_DATABASE_URL" node deploy/scripts/postgres-smoke.mjs "$CURRENT_DATABASE_URL"
  TARGET_DATABASE_URL="$CURRENT_DATABASE_URL"
elif [[ "$ENVIRONMENT" == preview-* ]]; then
  PRESERVE_ARGS=()
  [[ "$DRAIN_PRESERVE_TARGET" != "true" ]] || PRESERVE_ARGS=(--preserve-existing true)
  BRAI_DATABASE_URL="$CURRENT_DATABASE_URL" node deploy/scripts/supabase-branch.mjs preview-env \
    --branch "$BRAI_BRANCH" \
    --commit "$BRAI_COMMIT" \
    --runtime-env "$ENVS_ROOT/$ENV_PATH/brai-api.env" \
    "${PRESERVE_ARGS[@]}"
  TARGET_DATABASE_URL="$(env_database_url "$ENVS_ROOT/$ENV_PATH/brai-api.env")"
else
  PRESERVE_ARGS=()
  [[ "$DRAIN_PRESERVE_TARGET" != "true" ]] || PRESERVE_ARGS=(--preserve-existing true)
  BRAI_DATABASE_URL="$CURRENT_DATABASE_URL" node deploy/scripts/supabase-branch.mjs dev-env \
    --runtime-env "$ENVS_ROOT/$ENV_PATH/brai-api.env" \
    "${PRESERVE_ARGS[@]}"
  TARGET_DATABASE_URL="$(env_database_url "$ENVS_ROOT/$ENV_PATH/brai-api.env")"
fi
[[ -n "$TARGET_DATABASE_URL" ]] || { echo "Target BRAI_DATABASE_URL is required after data setup" >&2; exit 1; }
BRAI_DATABASE_URL="$TARGET_DATABASE_URL" node deploy/scripts/supavisor-tenants.mjs assert-url --environment "$ENVIRONMENT"
if [[ "$ENVIRONMENT" != "prod" ]]; then
  BRAI_DATABASE_URL="$TARGET_DATABASE_URL" node deploy/scripts/postgres-smoke.mjs "$TARGET_DATABASE_URL"
fi
run_goal_agent_drain_check "$TARGET_DATABASE_URL" "after-data-setup"
if [[ -n "$PRE_DRAIN_STATE_DIGEST" && "$DRAIN_STATE_DIGEST" != "$PRE_DRAIN_STATE_DIGEST" ]]; then
  echo "Goal-agent nonterminal state changed after the API drain barrier" >&2
  exit 1
fi
export BRAI_DATABASE_URL="$TARGET_DATABASE_URL"

if [[ "$ENVIRONMENT" == preview-* ]]; then
  exec 9>>"$ENVS_ROOT/preview-slots.lock"
  flock 9
  BRAI_ROOT="$REMOTE_UPLOAD" BRAI_ENVS_ROOT="$ENVS_ROOT" \
    node deploy/scripts/preview-slots.mjs assert-owned "$BRAI_BRANCH" "$BRAI_COMMIT" >/dev/null
fi
if [[ "$SOURCE_PRESENT" == "true" ]]; then
  mv "$SOURCE_ROOT" "$PREVIOUS_SOURCE"
  PREVIOUS_SOURCE_READY="true"
  previous_marker_tmp="$PREVIOUS_SOURCE/.brai-previous-source.json.tmp-$$"
  node -e 'const [attempt, branch, commit] = process.argv.slice(1); process.stdout.write(`${JSON.stringify({ attempt, replacedByBranch: branch, replacedByCommit: commit, createdAt: new Date().toISOString() })}\n`);' \
    "$DEPLOY_ATTEMPT_SUFFIX" "$BRAI_BRANCH" "$BRAI_COMMIT" >"$previous_marker_tmp"
  mv -f -- "$previous_marker_tmp" "$PREVIOUS_SOURCE/.brai-previous-source.json"
fi
mv "$REMOTE_UPLOAD" "$SOURCE_ROOT"
SOURCE_SWAPPED="true"
rm -f -- "$SOURCE_ROOT/$UPLOAD_MARKER"
printf '%s\n' "$DEPLOY_ATTEMPT_SUFFIX" >"$SOURCE_ROOT/.brai-deploy-attempt"
printf '%s\n' "$BRAI_COMMIT" >"$SOURCE_ROOT/.brai-deploy-commit"
printf '%s\n' "$BRAI_BRANCH" >"$SOURCE_ROOT/.brai-deploy-branch"
if [[ "$ENVIRONMENT" == preview-* ]]; then
  exec 9>&-
fi

GOAL_AGENT_SOURCE="$SOURCE_ROOT/services/brai_goal_agents"
if [[ -d "$GOAL_AGENT_SOURCE" ]]; then
  find "$GOAL_AGENT_SOURCE" -exec chgrp -h "$GOAL_AGENT_RUNTIME_GROUP" {} +
  chmod -R g=rX,o= "$GOAL_AGENT_SOURCE"
fi

cd "$SOURCE_ROOT"
export BRAI_BRANCH BRAI_COMMIT
export BRAI_NATIVE_APK_CHANGE
export BRAI_ROOT="$SOURCE_ROOT"
export BRAI_RELEASE_TARGET="$DEPLOY_REPO/deploy/releases"
export BRAI_PROD_WEB_VERSION_JSON="$DEPLOY_REPO/deploy/web/version.json"
if [[ "$ENVIRONMENT" == "prod" ]]; then
  set -a
  # shellcheck source=/dev/null
  . /etc/brai/brai-api.env
  set +a
else
  [[ -r "$ENVS_ROOT/$ENV_PATH/brai-api.env" ]] || { echo "$ENVS_ROOT/$ENV_PATH/brai-api.env is required for $ENVIRONMENT deploy" >&2; exit 1; }
  set -a
  # shellcheck source=/dev/null
  . "$ENVS_ROOT/$ENV_PATH/brai-api.env"
  set +a
fi
export BRAI_DATABASE_URL="$TARGET_DATABASE_URL"

echo "Starting provisional $BROKER_SERVICE_NAME from incoming source..."
"${BRAI_SUDO:-sudo}" systemctl restart "$BROKER_SERVICE_NAME"
wait_for_broker_health "New Codex broker"
export BRAI_BROKER_ALREADY_RESTARTED="true"

echo "Starting provisional $SERVICE_NAME from incoming source..."
"${BRAI_SUDO:-sudo}" systemctl restart "$SERVICE_NAME"
wait_for_api_health "New API"
NEW_API_HEALTHY="true"
API_QUIESCED="false"
export BRAI_API_ALREADY_RESTARTED="true"

if [[ "$BRAI_NATIVE_APK_CHANGE" == "true" ]]; then
  if [[ "$ENVIRONMENT" == preview-* ]]; then
    FLAVOR="preview$BRAI_PREVIEW_SLOT"
    deploy/scripts/build-android-env-apk.sh "$FLAVOR"
  elif [[ "$ENVIRONMENT" == "dev" ]]; then
    deploy/scripts/build-android-env-apk.sh dev
  elif [[ "$ENVIRONMENT" == "prod" ]]; then
    deploy/scripts/build-android-env-apk.sh production
    export BRAI_APP_VERSION="$(node deploy/scripts/resolve-app-version.mjs --environment prod --root "$SOURCE_ROOT")"
    deploy/scripts/build-nonproduction-apks.sh
  fi
fi
deploy/scripts/deploy-branch.sh
REMOTE
)"; then
  printf '%s\n' "$DEPLOY_OUTPUT"
  PREVIEW_SLOT="$(printf '%s\n' "$DEPLOY_OUTPUT" | sed -n 's/^BRAI_PREVIEW_SLOT_OUTPUT=//p' | tail -n 1)"
  if [[ -n "${GITHUB_OUTPUT:-}" && -n "$PREVIEW_SLOT" ]]; then
    printf 'preview_slot=%s\n' "$PREVIEW_SLOT" >>"$GITHUB_OUTPUT"
  fi
  exit 1
fi
printf '%s\n' "$DEPLOY_OUTPUT"
PREVIEW_SLOT="$(printf '%s\n' "$DEPLOY_OUTPUT" | sed -n 's/^BRAI_PREVIEW_SLOT_OUTPUT=//p' | tail -n 1)"
if [[ -n "${GITHUB_OUTPUT:-}" && -n "$PREVIEW_SLOT" ]]; then
  printf 'preview_slot=%s\n' "$PREVIEW_SLOT" >>"$GITHUB_OUTPUT"
fi
