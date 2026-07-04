#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/permissions.sh"
ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
BRANCH="${BRAI_BRANCH:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)}"
COMMIT="${BRAI_COMMIT:-$(git -C "$ROOT" rev-parse HEAD)}"
RUN_ID="${GITHUB_RUN_NUMBER:-$(date -u +%Y%m%d%H%M%S)}"
SLOT=""

if [[ "$BRANCH" == codex/* ]]; then
  if [[ -n "${BRAI_PREVIEW_SLOT:-}" ]]; then
    SLOT="$BRAI_PREVIEW_SLOT"
    ALLOCATED_NEW="${BRAI_PREVIEW_ALLOCATED_NEW:-false}"
  else
    ALLOCATION_JSON="$("$SCRIPT_DIR/preview-slots.sh" allocate "$BRANCH" "$COMMIT")"
    SLOT="$(printf '%s' "$ALLOCATION_JSON" | "$NODE_BIN" -e 'let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => console.log(JSON.parse(raw).slot));')"
    ALLOCATED_NEW="$(printf '%s' "$ALLOCATION_JSON" | "$NODE_BIN" -e 'let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => console.log(JSON.parse(raw).allocatedNew ? "true" : "false"));')"
  fi
  export BRAI_PREVIEW_SLOT="$SLOT"
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
DEPLOY_SHORT_CHANGES="${BRAI_DEPLOY_SHORT_CHANGES:-${GIT_SUBJECT:-Branch deployment}}"
if [[ -n "${BRAI_DEPLOY_DETAILED_CHANGES:-}" ]]; then
  DEPLOY_DETAILED_CHANGES="$BRAI_DEPLOY_DETAILED_CHANGES"
elif [[ -n "$GIT_BODY" ]]; then
  DEPLOY_DETAILED_CHANGES="$GIT_SUBJECT"$'\n\n'"$GIT_BODY"
else
  DEPLOY_DETAILED_CHANGES="${GIT_SUBJECT:-Branch deployment}"
fi

if [[ "$ENVIRONMENT" == "prod" ]]; then
  WEB_TARGET="${BRAI_WEB_TARGET:-$ROOT/deploy/web}"
  MOBILE_TARGET="${BRAI_MOBILE_TARGET:-$ROOT/deploy/mobile-update}"
  DB_PATH="${BRAI_DB:-$ROOT/data/brai.sqlite}"
else
  TARGET_ROOT="${BRAI_ENV_ROOT:-$ENVS_ROOT/$ENV_PATH}"
  umask 0002
  WEB_TARGET="$TARGET_ROOT/web"
  MOBILE_TARGET="$TARGET_ROOT/mobile-update"
  DB_PATH="$TARGET_ROOT/data/brai.sqlite"
  mkdir -p "$WEB_TARGET" "$MOBILE_TARGET" "$(dirname "$DB_PATH")"
fi

if [[ "$ENVIRONMENT" == preview-* && "$ALLOCATED_NEW" == "true" && "${BRAI_RESET_NEW_PREVIEW_DB:-true}" != "false" ]]; then
  case "$TARGET_ROOT" in
    "$ENVS_ROOT"/preview-*)
      find "$TARGET_ROOT" -user "$(id -u)" -exec chmod u+rwX,g+rwX {} + || true
      if ! rm -f "$TARGET_ROOT/data/brai.sqlite" "$TARGET_ROOT/data/brai.sqlite-shm" "$TARGET_ROOT/data/brai.sqlite-wal"; then
        cat >&2 <<RECOVERY
Preview SQLite reset failed under $TARGET_ROOT/data.
Expected: data directory brai-deploy:brai-deploy 2775, SQLite files group-writable 0664.
Recovery: run the Brai Ansible playbook as an admin, or run:
  chown -R brai-deploy:brai-deploy "$TARGET_ROOT/data"
  chmod -R u+rwX,g+rwX,o=rX "$TARGET_ROOT/data"
  find "$TARGET_ROOT/data" -type d -exec chmod 2775 {} +
Then retry this same branch deploy so the preview slot is reused.
RECOVERY
        exit 1
      fi
      ;;
    *)
      echo "Refusing to reset preview DB outside $ENVS_ROOT/preview-* path: $TARGET_ROOT" >&2
      exit 1
      ;;
  esac
fi

normalize_preview_artifacts() {
  local failed=0
  chmod 2775 "$TARGET_ROOT" 2>/dev/null || true
  normalize_public_tree "$WEB_TARGET" || failed=1
  normalize_public_tree "$MOBILE_TARGET" || failed=1
  return "$failed"
}

VERSION="${BRAI_APP_VERSION:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-app-version.mjs" \
  --environment "$ENVIRONMENT" \
  --root "$ROOT" \
  --db "$DB_PATH" \
  --prod-db "${BRAI_PROD_DB:-}" \
  --prod-web-version-json "${BRAI_PROD_WEB_VERSION_JSON:-}" \
  --mobile-target "$MOBILE_TARGET")}"

if [[ "$ENVIRONMENT" == "prod" ]]; then
  BUNDLE_VERSION="${BRAI_MOBILE_BUNDLE_VERSION:-$VERSION}"
else
  BUNDLE_VERSION="${BRAI_MOBILE_BUNDLE_VERSION:-$VERSION}"
fi

ANDROID_API="https://$DOMAIN/api"
if [[ "$ENVIRONMENT" == "prod" ]]; then
  ANDROID_API="https://api.brightos.world"
fi

export BRAI_ROOT="$ROOT"
export BRAI_WEB_TARGET="$WEB_TARGET"
export BRAI_MOBILE_TARGET="$MOBILE_TARGET"
export BRAI_UPDATE_BASE_URL="https://$DOMAIN/mobile-update"
export BRAI_APP_VERSION="$VERSION"
export BRAI_MOBILE_BUNDLE_VERSION="$BUNDLE_VERSION"
export NEXT_PUBLIC_BRAI_APP_VERSION="$VERSION"
export NEXT_PUBLIC_BRAI_ENVIRONMENT="$ENVIRONMENT"
export NEXT_PUBLIC_BRAI_PREVIEW_SLOT="$SLOT"
export NEXT_PUBLIC_BRAI_BRANCH="$BRANCH"
export NEXT_PUBLIC_BRAI_COMMIT="$COMMIT"
export NEXT_PUBLIC_BRAI_OTA_CHANNEL="$DOMAIN/mobile-update"
export NEXT_PUBLIC_BRAI_API="/api"
export NEXT_PUBLIC_BRAI_ANDROID_API="$ANDROID_API"

"$SCRIPT_DIR/publish-client-web-layer.sh"

if [[ "$ENVIRONMENT" != "prod" ]]; then
  echo "Normalizing preview artifact roots..."
  if ! normalize_preview_artifacts; then
    echo "Warning: preview artifact root normalization failed; continuing after published artifacts were normalized." >&2
  fi
fi

if [[ "$ENVIRONMENT" != "prod" || "${BRAI_RECORD_PROD_BRANCH_DEPLOYMENT:-false}" == "true" ]]; then
  echo "Recording deployment metadata..."
  if ! "$NODE_BIN" "$SCRIPT_DIR/record-deployment.mjs" \
    --db "$DB_PATH" \
    --environment "$ENVIRONMENT" \
    --slot "$SLOT" \
    --branch "$BRANCH" \
    --commit "$COMMIT" \
    --domain "$DOMAIN" \
    --web-ota-version "$VERSION" \
    --short-changes "$DEPLOY_SHORT_CHANGES" \
    --detailed-changes "$DEPLOY_DETAILED_CHANGES" \
    --reason "${BRAI_DEPLOY_REASON:-Автоматическая доставка ветки}"; then
    if [[ "$ENVIRONMENT" != preview-* ]]; then
      exit 1
    fi
    echo "Warning: preview deployment metadata was not recorded; production promotion still requires preview handoff release notes and will not use deployment fallback metadata." >&2
  fi
fi

if [[ "$ENVIRONMENT" != "prod" ]]; then
  echo "Normalizing preview artifact roots after metadata..."
  if ! normalize_preview_artifacts; then
    echo "Warning: preview artifact root normalization after metadata failed; continuing." >&2
  fi
fi

if command -v systemctl >/dev/null 2>&1 && [[ "${BRAI_RESTART_SERVICE:-true}" != "false" ]]; then
  echo "Restarting $SERVICE_NAME..."
  "${BRAI_SUDO:-sudo}" systemctl restart "$SERVICE_NAME"
fi

if [[ "$ENVIRONMENT" == preview-* ]]; then
  echo "Marking preview slot ready..."
  "$SCRIPT_DIR/preview-slots.sh" ready "$BRANCH" "$COMMIT" >/dev/null
fi

echo "Deployed $BRANCH@$COMMIT to $ENVIRONMENT ($DOMAIN) with bundle $BUNDLE_VERSION."
