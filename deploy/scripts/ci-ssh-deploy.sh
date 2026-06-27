#!/usr/bin/env bash
set -euo pipefail

: "${BRIGHT_DEPLOY_HOST:?BRIGHT_DEPLOY_HOST is required}"
: "${BRIGHT_DEPLOY_USER:?BRIGHT_DEPLOY_USER is required}"
: "${BRIGHT_DEPLOY_SSH_KEY:?BRIGHT_DEPLOY_SSH_KEY is required}"
: "${BRIGHT_OS_BRANCH:?BRIGHT_OS_BRANCH is required}"
: "${BRIGHT_OS_COMMIT:?BRIGHT_OS_COMMIT is required}"

DEPLOY_REPO="${BRIGHT_DEPLOY_REPO:-/srv/projects/bright-os}"
SSH_PORT="${BRIGHT_DEPLOY_SSH_PORT:-22}"
ENVS_ROOT="${BRIGHT_OS_ENVS_ROOT:-/srv/projects/bright-os-envs}"
UPLOAD_ROOT="${BRIGHT_DEPLOY_UPLOAD_ROOT:-$ENVS_ROOT/ci-uploads}"
SAFE_BRANCH="$(printf '%s' "$BRIGHT_OS_BRANCH" | tr -c 'A-Za-z0-9._-' '-')"
REMOTE_UPLOAD="$UPLOAD_ROOT/$SAFE_BRANCH"
if [[ -z "${BRIGHT_OS_NATIVE_APK_CHANGE:-}" ]]; then
  BRIGHT_OS_NATIVE_APK_CHANGE="$(node deploy/scripts/detect-native-apk-change.mjs "$BRIGHT_OS_BRANCH" "${BRIGHT_OS_BASE_COMMIT:-}")"
fi
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/bright-deploy-key.XXXXXX")"
cleanup() {
  rm -f "$KEY_FILE"
}
trap cleanup EXIT

printf '%s\n' "$BRIGHT_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRIGHT_DEPLOY_USER@$BRIGHT_DEPLOY_HOST" \
  bash -s -- "$REMOTE_UPLOAD" "$UPLOAD_ROOT" <<'REMOTE'
set -euo pipefail
REMOTE_UPLOAD="$1"
UPLOAD_ROOT="$2"
case "$REMOTE_UPLOAD" in
  "$UPLOAD_ROOT"/*) ;;
  *)
    echo "Refusing to reset upload path outside $UPLOAD_ROOT: $REMOTE_UPLOAD" >&2
    exit 1
    ;;
esac
rm -rf "$REMOTE_UPLOAD"
mkdir -p "$REMOTE_UPLOAD"
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
  -czf - . | ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRIGHT_DEPLOY_USER@$BRIGHT_DEPLOY_HOST" \
    tar -xzf - -C "$REMOTE_UPLOAD"

DEPLOY_OUTPUT=""
if ! DEPLOY_OUTPUT="$(ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRIGHT_DEPLOY_USER@$BRIGHT_DEPLOY_HOST" \
  bash -s -- "$DEPLOY_REPO" "$REMOTE_UPLOAD" "$BRIGHT_OS_BRANCH" "$BRIGHT_OS_COMMIT" "$BRIGHT_OS_NATIVE_APK_CHANGE" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
REMOTE_UPLOAD="$2"
BRIGHT_OS_BRANCH="$3"
BRIGHT_OS_COMMIT="$4"
BRIGHT_OS_NATIVE_APK_CHANGE="$5"
ENVS_ROOT="${BRIGHT_OS_ENVS_ROOT:-/srv/projects/bright-os-envs}"
NODE_PREFIX="${BRIGHT_OS_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ -d "$NODE_PREFIX" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
fi

cd "$REMOTE_UPLOAD"
allocation_field() {
  node -e 'let raw = ""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => { const value = JSON.parse(raw)[process.argv[1]]; console.log(value == null ? "" : value); });' "$1"
}
mark_preview_failed() {
  if [[ "$BRIGHT_OS_BRANCH" == codex/* && -n "${BRIGHT_OS_PREVIEW_SLOT:-}" ]]; then
    deploy/scripts/preview-slots.sh failed "$BRIGHT_OS_BRANCH" "$BRIGHT_OS_COMMIT" >/dev/null || true
  fi
}
cleanup_preview_queue() {
  if [[ "${BRIGHT_OS_PREVIEW_QUEUED:-}" == "true" ]]; then
    deploy/scripts/preview-slots.sh dequeue "$BRIGHT_OS_BRANCH" >/dev/null || true
  fi
}
if [[ "$BRIGHT_OS_BRANCH" == codex/* ]]; then
  BRIGHT_OS_PREVIEW_QUEUED="false"
  trap cleanup_preview_queue EXIT
  QUEUE_MAX_ATTEMPTS="${BRIGHT_OS_PREVIEW_QUEUE_MAX_ATTEMPTS:-720}"
  QUEUE_POLL_SECONDS="${BRIGHT_OS_PREVIEW_QUEUE_POLL_SECONDS:-30}"
  for ((attempt = 1; attempt <= QUEUE_MAX_ATTEMPTS; attempt += 1)); do
    ALLOCATION_JSON="$(deploy/scripts/preview-slots.sh allocate "$BRIGHT_OS_BRANCH" "$BRIGHT_OS_COMMIT")"
    BRIGHT_OS_PREVIEW_QUEUED="$(printf '%s' "$ALLOCATION_JSON" | allocation_field queued)"
    if [[ "$BRIGHT_OS_PREVIEW_QUEUED" != "true" ]]; then
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
  BRIGHT_OS_PREVIEW_QUEUED="false"
  trap - EXIT
  BRIGHT_OS_PREVIEW_SLOT="$(printf '%s' "$ALLOCATION_JSON" | allocation_field slot)"
  BRIGHT_OS_PREVIEW_ALLOCATED_NEW="$(printf '%s' "$ALLOCATION_JSON" | allocation_field allocatedNew)"
  export BRIGHT_OS_PREVIEW_SLOT BRIGHT_OS_PREVIEW_ALLOCATED_NEW
  printf 'BRIGHT_OS_PREVIEW_SLOT_OUTPUT=%s\n' "$BRIGHT_OS_PREVIEW_SLOT"
  trap mark_preview_failed ERR
fi

mapfile -t DEPLOY_META < <(node deploy/scripts/resolve-deploy-env.mjs "$BRIGHT_OS_BRANCH")
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
  export BRIGHT_OS_SITE_TARGET="$DEPLOY_REPO/deploy/site"
  export BRIGHT_OS_WEB_TARGET="$DEPLOY_REPO/deploy/web"
  export BRIGHT_OS_MOBILE_TARGET="$DEPLOY_REPO/deploy/mobile-update"
  export BRIGHT_OS_DB="$DEPLOY_REPO/data/bright_os.sqlite"
fi
rm -rf "$SOURCE_ROOT"
mkdir -p "$(dirname "$SOURCE_ROOT")"
mv "$REMOTE_UPLOAD" "$SOURCE_ROOT"

cd "$SOURCE_ROOT"
umask 0002
npm ci
npm --prefix apps/bright_os_app ci
npm --prefix services/bright_os_api ci
export BRIGHT_OS_BRANCH BRIGHT_OS_COMMIT
export BRIGHT_OS_ROOT="$SOURCE_ROOT"
export BRIGHT_OS_RELEASE_TARGET="$DEPLOY_REPO/deploy/releases"
export BRIGHT_OS_PROD_WEB_VERSION_JSON="$DEPLOY_REPO/deploy/web/version.json"
if [[ "$BRIGHT_OS_NATIVE_APK_CHANGE" == "true" ]]; then
  if [[ "$ENVIRONMENT" == preview-* ]]; then
    FLAVOR="preview$BRIGHT_OS_PREVIEW_SLOT"
    export BRIGHT_OS_ANDROID_VERSION_CODE="$(deploy/scripts/apk-version-code.sh next "$BRIGHT_OS_BRANCH $BRIGHT_OS_COMMIT $FLAVOR")"
    deploy/scripts/build-android-env-apk.sh "$FLAVOR"
  elif [[ "$ENVIRONMENT" == "dev" ]]; then
    export BRIGHT_OS_ANDROID_VERSION_CODE="$(deploy/scripts/apk-version-code.sh next "dev non-production APK baseline $BRIGHT_OS_COMMIT")"
    deploy/scripts/build-nonproduction-apks.sh
    deploy/scripts/publish-environment-web-layer.sh preview-a preview-b preview-c preview-d preview-e
  elif [[ "$ENVIRONMENT" == "prod" ]]; then
    export BRIGHT_OS_ANDROID_VERSION_CODE="$(deploy/scripts/apk-version-code.sh next "production APK $BRIGHT_OS_COMMIT")"
    deploy/scripts/build-android-env-apk.sh production
  fi
fi
deploy/scripts/deploy-branch.sh
REMOTE
)"; then
  printf '%s\n' "$DEPLOY_OUTPUT"
  PREVIEW_SLOT="$(printf '%s\n' "$DEPLOY_OUTPUT" | sed -n 's/^BRIGHT_OS_PREVIEW_SLOT_OUTPUT=//p' | tail -n 1)"
  if [[ -n "${GITHUB_OUTPUT:-}" && -n "$PREVIEW_SLOT" ]]; then
    printf 'preview_slot=%s\n' "$PREVIEW_SLOT" >>"$GITHUB_OUTPUT"
  fi
  exit 1
fi
printf '%s\n' "$DEPLOY_OUTPUT"
PREVIEW_SLOT="$(printf '%s\n' "$DEPLOY_OUTPUT" | sed -n 's/^BRIGHT_OS_PREVIEW_SLOT_OUTPUT=//p' | tail -n 1)"
if [[ -n "${GITHUB_OUTPUT:-}" && -n "$PREVIEW_SLOT" ]]; then
  printf 'preview_slot=%s\n' "$PREVIEW_SLOT" >>"$GITHUB_OUTPUT"
fi
