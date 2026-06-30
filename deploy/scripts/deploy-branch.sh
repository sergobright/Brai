#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRIGHT_OS_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
ENVS_ROOT="${BRIGHT_OS_ENVS_ROOT:-/srv/projects/bright-os-envs}"
BRANCH="${BRIGHT_OS_BRANCH:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)}"
COMMIT="${BRIGHT_OS_COMMIT:-$(git -C "$ROOT" rev-parse HEAD)}"
RUN_ID="${GITHUB_RUN_NUMBER:-$(date -u +%Y%m%d%H%M%S)}"
SLOT=""

if [[ "$BRANCH" == codex/* ]]; then
  if [[ -n "${BRIGHT_OS_PREVIEW_SLOT:-}" ]]; then
    SLOT="$BRIGHT_OS_PREVIEW_SLOT"
    ALLOCATED_NEW="${BRIGHT_OS_PREVIEW_ALLOCATED_NEW:-false}"
  else
    ALLOCATION_JSON="$("$SCRIPT_DIR/preview-slots.sh" allocate "$BRANCH" "$COMMIT")"
    SLOT="$(printf '%s' "$ALLOCATION_JSON" | "$NODE_BIN" -e 'let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => console.log(JSON.parse(raw).slot));')"
    ALLOCATED_NEW="$(printf '%s' "$ALLOCATION_JSON" | "$NODE_BIN" -e 'let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => console.log(JSON.parse(raw).allocatedNew ? "true" : "false"));')"
  fi
  export BRIGHT_OS_PREVIEW_SLOT="$SLOT"
  trap '"$SCRIPT_DIR/preview-slots.sh" failed "$BRANCH" "$COMMIT" >/dev/null || true' ERR
else
  ALLOCATED_NEW="false"
fi

mapfile -t DEPLOY_META < <("$NODE_BIN" "$SCRIPT_DIR/resolve-deploy-env.mjs" "$BRANCH")
ENVIRONMENT="${DEPLOY_META[0]}"
DISPLAY_LABEL="${DEPLOY_META[1]}"
DOMAIN="${DEPLOY_META[2]}"
ENV_PATH="${DEPLOY_META[3]}"
SERVICE_NAME="${DEPLOY_META[4]}"

GIT_SUBJECT="$(git -C "$ROOT" log -1 --format=%s "$COMMIT" 2>/dev/null || true)"
GIT_BODY="$(git -C "$ROOT" log -1 --format=%b "$COMMIT" 2>/dev/null || true)"
if [[ "$GIT_SUBJECT" == Merge\ pull\ request* && -n "$GIT_BODY" ]]; then
  while IFS= read -r line; do
    if [[ -n "${line//[[:space:]]/}" ]]; then
      GIT_SUBJECT="$line"
    fi
  done <<<"$GIT_BODY"
  GIT_BODY=""
fi
DEPLOY_SHORT_CHANGES="${BRIGHT_OS_DEPLOY_SHORT_CHANGES:-${GIT_SUBJECT:-Branch deployment}}"
if [[ -n "${BRIGHT_OS_DEPLOY_DETAILED_CHANGES:-}" ]]; then
  DEPLOY_DETAILED_CHANGES="$BRIGHT_OS_DEPLOY_DETAILED_CHANGES"
elif [[ -n "$GIT_BODY" ]]; then
  DEPLOY_DETAILED_CHANGES="$GIT_SUBJECT"$'\n\n'"$GIT_BODY"
else
  DEPLOY_DETAILED_CHANGES="${GIT_SUBJECT:-Branch deployment}"
fi

if [[ "$ENVIRONMENT" == "prod" ]]; then
  WEB_TARGET="${BRIGHT_OS_WEB_TARGET:-$ROOT/deploy/web}"
  MOBILE_TARGET="${BRIGHT_OS_MOBILE_TARGET:-$ROOT/deploy/mobile-update}"
  DB_PATH="${BRIGHT_OS_DB:-$ROOT/data/bright_os.sqlite}"
else
  TARGET_ROOT="${BRIGHT_OS_ENV_ROOT:-$ENVS_ROOT/$ENV_PATH}"
  WEB_TARGET="$TARGET_ROOT/web"
  MOBILE_TARGET="$TARGET_ROOT/mobile-update"
  DB_PATH="$TARGET_ROOT/data/bright_os.sqlite"
  mkdir -p "$WEB_TARGET" "$MOBILE_TARGET" "$(dirname "$DB_PATH")"
fi

if [[ "$ENVIRONMENT" == preview-* && "$ALLOCATED_NEW" == "true" && "${BRIGHT_OS_RESET_NEW_PREVIEW_DB:-true}" != "false" ]]; then
  case "$TARGET_ROOT" in
    "$ENVS_ROOT"/preview-*)
      find "$TARGET_ROOT" -user "$(id -u)" -exec chmod u+rwX,g+rwX {} + || true
      rm -f "$TARGET_ROOT/data/bright_os.sqlite" "$TARGET_ROOT/data/bright_os.sqlite-shm" "$TARGET_ROOT/data/bright_os.sqlite-wal"
      ;;
    *)
      echo "Refusing to reset preview DB outside $ENVS_ROOT/preview-* path: $TARGET_ROOT" >&2
      exit 1
      ;;
  esac
fi

VERSION="${BRIGHT_OS_APP_VERSION:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-app-version.mjs" \
  --environment "$ENVIRONMENT" \
  --root "$ROOT" \
  --db "$DB_PATH" \
  --prod-db "${BRIGHT_OS_PROD_DB:-}" \
  --prod-web-version-json "${BRIGHT_OS_PROD_WEB_VERSION_JSON:-}" \
  --mobile-target "$MOBILE_TARGET")}"

if [[ "$ENVIRONMENT" == "prod" ]]; then
  BUNDLE_VERSION="${BRIGHT_OS_MOBILE_BUNDLE_VERSION:-$VERSION}"
else
  BUNDLE_VERSION="${BRIGHT_OS_MOBILE_BUNDLE_VERSION:-$VERSION.$RUN_ID}"
fi

ANDROID_API="https://$DOMAIN/api"
if [[ "$ENVIRONMENT" == "prod" ]]; then
  ANDROID_API="https://api.brightos.world"
fi

export BRIGHT_OS_ROOT="$ROOT"
export BRIGHT_OS_WEB_TARGET="$WEB_TARGET"
export BRIGHT_OS_MOBILE_TARGET="$MOBILE_TARGET"
export BRIGHT_OS_UPDATE_BASE_URL="https://$DOMAIN/mobile-update"
export BRIGHT_OS_APP_VERSION="$VERSION"
export BRIGHT_OS_MOBILE_BUNDLE_VERSION="$BUNDLE_VERSION"
export NEXT_PUBLIC_BRIGHT_OS_APP_VERSION="$VERSION"
export NEXT_PUBLIC_BRIGHT_OS_ENVIRONMENT="$ENVIRONMENT"
export NEXT_PUBLIC_BRIGHT_OS_PREVIEW_SLOT="$SLOT"
export NEXT_PUBLIC_BRIGHT_OS_BRANCH="$BRANCH"
export NEXT_PUBLIC_BRIGHT_OS_COMMIT="$COMMIT"
export NEXT_PUBLIC_BRIGHT_OS_OTA_CHANNEL="$DOMAIN/mobile-update"
export NEXT_PUBLIC_BRIGHT_OS_API="/api"
export NEXT_PUBLIC_BRIGHT_OS_ANDROID_API="$ANDROID_API"

"$SCRIPT_DIR/publish-client-web-layer.sh"

if [[ "$ENVIRONMENT" != "prod" ]]; then
  find "$TARGET_ROOT" -user "$(id -u)" -exec chmod u+rwX,g+rwX {} +
fi

if ! "$NODE_BIN" "$SCRIPT_DIR/record-deployment.mjs" \
  --db "$DB_PATH" \
  --environment "$ENVIRONMENT" \
  --slot "$SLOT" \
  --branch "$BRANCH" \
  --commit "$COMMIT" \
  --domain "$DOMAIN" \
  --web-ota-version "$BUNDLE_VERSION" \
  --short-changes "$DEPLOY_SHORT_CHANGES" \
  --detailed-changes "$DEPLOY_DETAILED_CHANGES" \
  --reason "${BRIGHT_OS_DEPLOY_REASON:-Automated branch delivery}"; then
  if [[ "$ENVIRONMENT" != preview-* ]]; then
    exit 1
  fi
  echo "Warning: preview deployment metadata was not recorded; acceptance will use branch and commit fallback metadata." >&2
fi

if [[ "$ENVIRONMENT" != "prod" ]]; then
  find "$TARGET_ROOT" -user "$(id -u)" -exec chmod u+rwX,g+rwX {} +
fi

if [[ "$ENVIRONMENT" == preview-* ]]; then
  "$SCRIPT_DIR/preview-slots.sh" ready "$BRANCH" "$COMMIT" >/dev/null
fi

if command -v systemctl >/dev/null 2>&1 && [[ "${BRIGHT_OS_RESTART_SERVICE:-true}" != "false" ]]; then
  "${BRIGHT_OS_SUDO:-sudo}" systemctl restart "$SERVICE_NAME"
fi

echo "Deployed $BRANCH@$COMMIT to $ENVIRONMENT ($DOMAIN) with bundle $BUNDLE_VERSION."
