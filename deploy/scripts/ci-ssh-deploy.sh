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
REMOTE_UPLOAD="$UPLOAD_ROOT/$SAFE_BRANCH"
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
  bash -s -- "$DEPLOY_REPO" "$REMOTE_UPLOAD" "$BRAI_BRANCH" "$BRAI_COMMIT" "$BRAI_NATIVE_APK_CHANGE" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
REMOTE_UPLOAD="$2"
BRAI_BRANCH="$3"
BRAI_COMMIT="$4"
BRAI_NATIVE_APK_CHANGE="$5"
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
mark_preview_failed() {
  if [[ "$BRAI_BRANCH" == codex/* && -n "${BRAI_PREVIEW_SLOT:-}" ]]; then
    deploy/scripts/preview-slots.sh failed "$BRAI_BRANCH" "$BRAI_COMMIT" >/dev/null || true
  fi
}
cleanup_preview_queue() {
  if [[ "${BRAI_PREVIEW_QUEUED:-}" == "true" ]]; then
    deploy/scripts/preview-slots.sh dequeue "$BRAI_BRANCH" >/dev/null || true
  fi
}
if [[ "$BRAI_BRANCH" == codex/* ]]; then
  BRAI_PREVIEW_QUEUED="false"
  trap cleanup_preview_queue EXIT
  QUEUE_MAX_ATTEMPTS="${BRAI_PREVIEW_QUEUE_MAX_ATTEMPTS:-720}"
  QUEUE_POLL_SECONDS="${BRAI_PREVIEW_QUEUE_POLL_SECONDS:-30}"
  for ((attempt = 1; attempt <= QUEUE_MAX_ATTEMPTS; attempt += 1)); do
    ALLOCATION_JSON="$(deploy/scripts/preview-slots.sh allocate "$BRAI_BRANCH" "$BRAI_COMMIT")"
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
  trap mark_preview_failed ERR
fi

mapfile -t DEPLOY_META < <(node deploy/scripts/resolve-deploy-env.mjs "$BRAI_BRANCH")
ENVIRONMENT="${DEPLOY_META[0]}"
ENV_PATH="${DEPLOY_META[3]}"
SOURCE_ROOT="$ENVS_ROOT/$ENV_PATH/source"
case "$SOURCE_ROOT" in
  "$ENVS_ROOT"/*/source) ;;
  *)
    echo "Refusing to reset source path outside $ENVS_ROOT: $SOURCE_ROOT" >&2
    exit 1
    ;;
esac

if [[ "$ENVIRONMENT" == "prod" ]]; then
  export BRAI_WEB_TARGET="$DEPLOY_REPO/deploy/web"
  export BRAI_PUBLIC_SITE_TARGET="$DEPLOY_REPO/deploy/site"
  export BRAI_MOBILE_TARGET="$DEPLOY_REPO/deploy/mobile-update"
fi
if [[ -d "$SOURCE_ROOT" ]]; then
  find "$SOURCE_ROOT" -user "$(id -u)" -exec chmod u+rwX,g+rwX {} + || true
fi
rm -rf "$SOURCE_ROOT" || { sleep 2; rm -rf "$SOURCE_ROOT"; }
mkdir -p "$(dirname "$SOURCE_ROOT")"
mv "$REMOTE_UPLOAD" "$SOURCE_ROOT"
find "$SOURCE_ROOT" -user "$(id -u)" -exec chmod u+rwX,g+rwX {} +
find "$SOURCE_ROOT" -type d -user "$(id -u)" -exec chmod g+s {} +

cd "$SOURCE_ROOT"
umask 0002
npm ci
npm --prefix apps/brai_app ci
npm --prefix services/brai_api ci
npm --prefix admin ci
export BRAI_BRANCH BRAI_COMMIT
export BRAI_NATIVE_APK_CHANGE
export BRAI_ROOT="$SOURCE_ROOT"
export BRAI_RELEASE_TARGET="$DEPLOY_REPO/deploy/releases"
export BRAI_PROD_WEB_VERSION_JSON="$DEPLOY_REPO/deploy/web/version.json"
[[ -r "/etc/brai/supabase-deploy.env" ]] || { echo "/etc/brai/supabase-deploy.env is required" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. /etc/brai/supabase-deploy.env
set +a
if [[ "$ENVIRONMENT" == "prod" && -r "/etc/brai/brai-api.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  . /etc/brai/brai-api.env
  set +a
  export BRAI_PROD_DATABASE_URL="${BRAI_DATABASE_URL:-}"
elif [[ "$ENVIRONMENT" == "prod" ]]; then
  echo "/etc/brai/brai-api.env is required and must be readable for production deploy" >&2
  exit 1
elif [[ "$ENVIRONMENT" == preview-* || "$ENVIRONMENT" == "dev" ]]; then
  [[ -r "/etc/brai/brai-api.env" ]] || { echo "/etc/brai/brai-api.env is required and must be readable for test data seed" >&2; exit 1; }
  export BRAI_PROD_DATABASE_URL="$(env_database_url /etc/brai/brai-api.env)"
  [[ -n "$BRAI_PROD_DATABASE_URL" ]] || { echo "BRAI_DATABASE_URL is missing in /etc/brai/brai-api.env" >&2; exit 1; }
fi
if [[ "$ENVIRONMENT" == "prod" ]]; then
  : "${BRAI_DATABASE_URL:?BRAI_DATABASE_URL is required for production deploy}"
  node deploy/scripts/supabase-branch.mjs migrate
  node deploy/scripts/postgres-smoke.mjs "$BRAI_DATABASE_URL"
fi
if [[ "$ENVIRONMENT" == preview-* ]]; then
  node deploy/scripts/supabase-branch.mjs preview-env \
    --branch "$BRAI_BRANCH" \
    --runtime-env "$ENVS_ROOT/$ENV_PATH/brai-api.env"
elif [[ "$ENVIRONMENT" == "dev" ]]; then
  node deploy/scripts/supabase-branch.mjs dev-env \
    --runtime-env "$ENVS_ROOT/$ENV_PATH/brai-api.env"
fi
if [[ "$ENVIRONMENT" != "prod" && -f "$ENVS_ROOT/$ENV_PATH/brai-api.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENVS_ROOT/$ENV_PATH/brai-api.env"
  set +a
elif [[ "$ENVIRONMENT" != "prod" ]]; then
  echo "$ENVS_ROOT/$ENV_PATH/brai-api.env is required for $ENVIRONMENT deploy" >&2
  exit 1
fi
: "${BRAI_DATABASE_URL:?BRAI_DATABASE_URL is required after Supabase env setup}"
if [[ "$ENVIRONMENT" != "prod" ]]; then
  node deploy/scripts/postgres-smoke.mjs "$BRAI_DATABASE_URL"
fi
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
