#!/usr/bin/env bash
set -euo pipefail

: "${BRAI_DEPLOY_HOST:?BRAI_DEPLOY_HOST is required}"
: "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
: "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"
: "${BRAI_BRANCH:?BRAI_BRANCH is required}"
: "${BRAI_COMMIT:?BRAI_COMMIT is required}"

DEPLOY_REPO="${BRAI_DEPLOY_REPO:-/srv/projects/brai}"
SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
UPLOAD_ROOT="${BRAI_DEPLOY_UPLOAD_ROOT:-$ENVS_ROOT/ci-uploads}"
SAFE_BRANCH="$(printf '%s' "$BRAI_BRANCH" | tr -c 'A-Za-z0-9._-' '-')"
BRAI_PREVIEW_LEASE_GENERATION="${BRAI_PREVIEW_LEASE_GENERATION:-${GITHUB_RUN_ID:-}}"
REMOTE_UPLOAD="$UPLOAD_ROOT/$SAFE_BRANCH-$BRAI_COMMIT"
if [[ -z "${BRAI_NATIVE_APK_CHANGE:-}" ]]; then
  BRAI_NATIVE_APK_CHANGE="$(node deploy/scripts/detect-native-apk-change.mjs "$BRAI_BRANCH" "${BRAI_BASE_COMMIT:-}")"
fi
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-deploy-key.XXXXXX")"
cleanup() {
  rm -f "$KEY_FILE"
}
trap cleanup EXIT

printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
  bash -s -- "$REMOTE_UPLOAD" "$UPLOAD_ROOT" <<'REMOTE'
set -euo pipefail
REMOTE_UPLOAD="$1"
UPLOAD_ROOT="$2"
umask 0002
case "$REMOTE_UPLOAD" in
  "$UPLOAD_ROOT"/*) ;;
  *)
    echo "Refusing to reset upload path outside $UPLOAD_ROOT: $REMOTE_UPLOAD" >&2
    exit 1
    ;;
esac
rm -rf "$REMOTE_UPLOAD"
mkdir -p "$REMOTE_UPLOAD"
find "$REMOTE_UPLOAD" -type d -exec chmod 2775 {} +
REMOTE

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
  -czf - . | ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
    tar -xzf - -C "$REMOTE_UPLOAD"

DEPLOY_OUTPUT=""
if ! DEPLOY_OUTPUT="$(ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
  bash -s -- "$DEPLOY_REPO" "$REMOTE_UPLOAD" "$BRAI_BRANCH" "$BRAI_COMMIT" "$BRAI_NATIVE_APK_CHANGE" "$BRAI_PREVIEW_LEASE_GENERATION" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
REMOTE_UPLOAD="$2"
BRAI_BRANCH="$3"
BRAI_COMMIT="$4"
BRAI_NATIVE_APK_CHANGE="$5"
BRAI_PREVIEW_LEASE_GENERATION="${6:-}"
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
  local min_gb="${BRAI_DEPLOY_MIN_FREE_GB:-4}"
  if ! [[ "$min_gb" =~ ^[0-9]+$ ]]; then
    echo "BRAI_DEPLOY_MIN_FREE_GB must be a non-negative integer, got: $min_gb" >&2
    exit 1
  fi
  mkdir -p "$root"
  local available_kb
  available_kb="$(df -Pk "$root" | awk 'NR == 2 { print $4 }')"
  local required_kb=$((min_gb * 1024 * 1024))
  if (( available_kb < required_kb )); then
    echo "Not enough free disk space under $root: need at least ${min_gb}GB before deploy, have $((available_kb / 1024 / 1024))GB." >&2
    exit 1
  fi
}
cleanup_stale_preview_previous_sources() {
  local keep="${1:-}"
  [[ "${ENVIRONMENT:-}" == preview-* ]] || return 0
  local slot_root="$ENVS_ROOT/$ENV_PATH"
  case "$slot_root" in
    "$ENVS_ROOT"/preview-[a-e]) ;;
    *)
      echo "Refusing stale source.previous cleanup outside preview slots: $slot_root" >&2
      return 1
      ;;
  esac
  shopt -s nullglob
  local previous
  for previous in "$slot_root"/source.previous-*; do
    [[ -n "$keep" && "$previous" == "$keep" ]] && continue
    rm -rf "$previous"
  done
  shopt -u nullglob
}
mark_preview_failed() {
  if [[ "$BRAI_BRANCH" == codex/* && -n "${BRAI_PREVIEW_SLOT:-}" ]]; then
    deploy/scripts/preview-slots.sh failed "$BRAI_BRANCH" "$BRAI_COMMIT" >/dev/null || true
  fi
}
restore_previous_source() {
  if [[ "${PREVIOUS_SOURCE_READY:-false}" == "true" ]]; then
    if [[ -d "${SOURCE_ROOT:-}" ]]; then
      local failed_source="$REMOTE_UPLOAD"
      [[ ! -e "$failed_source" ]] || failed_source="${REMOTE_UPLOAD}.failed-$$"
      mv "$SOURCE_ROOT" "$failed_source" || return 1
    fi
    mv "$PREVIOUS_SOURCE" "$SOURCE_ROOT" || return 1
    PREVIOUS_SOURCE_READY="false"
    SOURCE_SWAPPED="false"
    return 0
  fi
  if [[ "${SOURCE_SWAPPED:-false}" == "true" && -d "${SOURCE_ROOT:-}" ]]; then
    [[ ! -e "$REMOTE_UPLOAD" ]] || return 1
    mv "$SOURCE_ROOT" "$REMOTE_UPLOAD" || return 1
    SOURCE_SWAPPED="false"
  fi
}
deploy_failed() {
  local failed_status=$?
  set +e
  if [[ "${NEW_API_HEALTHY:-false}" != "true" ]]; then
    if ! rollback_before_new_api_health; then
      echo "Rollback verification failed after the original deployment error; ${SERVICE_NAME:-API} remains failed closed." >&2
    fi
  fi
  mark_preview_failed
  if [[ "${SOURCE_SWAPPED:-false}" == "true" ]]; then
    cleanup_stale_preview_previous_sources "${PREVIOUS_SOURCE:-}" || true
  fi
  set -e
  return "$failed_status"
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
if [[ "$BRAI_BRANCH" == codex/* ]]; then
  [[ -n "$BRAI_PREVIEW_LEASE_GENERATION" ]] || {
    echo "BRAI_PREVIEW_LEASE_GENERATION or GITHUB_RUN_ID is required for Preview deploy." >&2
    exit 1
  }
  BRAI_PREVIEW_QUEUED="false"
  trap cleanup_preview_queue EXIT
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
  trap - EXIT
  BRAI_PREVIEW_SLOT="$(printf '%s' "$ALLOCATION_JSON" | allocation_field slot)"
  BRAI_PREVIEW_ALLOCATED_NEW="$(printf '%s' "$ALLOCATION_JSON" | allocation_field allocatedNew)"
  export BRAI_PREVIEW_SLOT BRAI_PREVIEW_ALLOCATED_NEW
  printf 'BRAI_PREVIEW_SLOT_OUTPUT=%s\n' "$BRAI_PREVIEW_SLOT"
  trap deploy_failed ERR
fi

mapfile -t DEPLOY_META < <(node deploy/scripts/resolve-deploy-env.mjs "$BRAI_BRANCH")
ENVIRONMENT="${DEPLOY_META[0]}"
ENV_PATH="${DEPLOY_META[3]}"
SERVICE_NAME="${DEPLOY_META[4]}"
API_PORT="${DEPLOY_META[5]}"
SOURCE_ROOT="$ENVS_ROOT/$ENV_PATH/source"
GOAL_AGENT_RUNTIME_GROUP="${BRAI_GOAL_AGENT_GROUP:-brai-goal-agent}"
SOURCE_SWAPPED="false"
PREVIOUS_SOURCE_READY="false"
API_WAS_ACTIVE="false"
API_QUIESCED="false"
NEW_API_HEALTHY="false"
trap deploy_failed ERR
case "$SOURCE_ROOT" in
  "$ENVS_ROOT"/*/source) ;;
  *)
    echo "Refusing to reset source path outside $ENVS_ROOT: $SOURCE_ROOT" >&2
    exit 1
    ;;
esac
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
find "$REMOTE_UPLOAD" ! -type l -user "$(id -u)" -exec chmod u+rwX,g+rwX {} +
find "$REMOTE_UPLOAD" -type d -user "$(id -u)" -exec chmod g+s {} +

SOURCE_OPERATION_LOCK="$(dirname "$SOURCE_ROOT")/.source-operation.lock"
exec 8>"$SOURCE_OPERATION_LOCK"
flock 8
export BRAI_SOURCE_OPERATION_LOCK_HELD=true
SOURCE_PRESENT="false"
if [[ -d "$SOURCE_ROOT" ]]; then
  SOURCE_PRESENT="true"
  find "$SOURCE_ROOT" ! -type l -user "$(id -u)" -exec chmod u+rwX,g+rwX {} + || true
fi
PREVIOUS_SOURCE="${SOURCE_ROOT}.previous-$(date -u +%Y%m%d%H%M%S)-$$"
mkdir -p "$(dirname "$SOURCE_ROOT")"

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

if systemctl is-active --quiet "$SERVICE_NAME"; then
  if [[ "$SOURCE_PRESENT" != "true" ]]; then
    echo "$SERVICE_NAME is active while $SOURCE_ROOT is absent; refusing first-install bypass" >&2
    exit 1
  fi
  API_WAS_ACTIVE="true"
  "${BRAI_SUDO:-sudo}" systemctl stop "$SERVICE_NAME"
fi
API_QUIESCED="true"
assert_api_quiesced
if [[ "$SOURCE_PRESENT" != "true" && "$ENVIRONMENT" == preview-* \
  && "${BRAI_PREVIEW_ALLOCATED_NEW:-false}" != "true" ]]; then
  echo "Missing Preview source is first-install-safe only for a newly allocated slot" >&2
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
fi
mv "$REMOTE_UPLOAD" "$SOURCE_ROOT"
SOURCE_SWAPPED="true"
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
rm -rf "$PREVIOUS_SOURCE"
PREVIOUS_SOURCE_READY="false"
cleanup_stale_preview_previous_sources
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
