#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"
FLAVOR="${1:-}"

if [[ -z "$FLAVOR" ]]; then
  echo "usage: build-android-env-apk.sh production|dev|previewA|previewB|previewC|previewD|previewE" >&2
  exit 1
fi

mapfile -t META < <("$NODE_BIN" "$SCRIPT_DIR/resolve-android-env.mjs" "$FLAVOR")
ENVIRONMENT="${META[0]}"
SLOT="${META[1]}"
DOMAIN="${META[2]}"
GRADLE_TASK="${META[3]}"
RELEASE_KEY="${META[4]}"
ENV_PATH="${META[5]}"

ANDROID_API="https://$DOMAIN/api"
if [[ "$ENVIRONMENT" == "prod" ]]; then
  ANDROID_API="https://api.brightos.world"
fi

export BRAI_ROOT="$ROOT"
APK_LEDGER_RECORD=false
MOBILE_TARGET="${BRAI_MOBILE_TARGET:-}"
if [[ -z "$MOBILE_TARGET" && -n "$ENV_PATH" ]]; then
  MOBILE_TARGET="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}/$ENV_PATH/mobile-update"
fi
OTA_VERSION_ARGS=(
  --environment "$ENVIRONMENT" \
  --root "$ROOT" \
  --db "${BRAI_DB:-}" \
  --prod-db "${BRAI_PROD_DB:-}" \
  --prod-web-version-json "${BRAI_PROD_WEB_VERSION_JSON:-}" \
  --mobile-target "$MOBILE_TARGET"
)
APK_VERSION_ARGS=(--kind apk --root "$ROOT" --db "${BRAI_DB:-${BRAI_PROD_DB:-}}")
if [[ "$ENVIRONMENT" == "prod" && "${BRAI_RECORD_APK_LEDGER:-false}" == "true" && -n "${BRAI_DB:-}" && -z "${BRAI_APP_VERSION:-}" && -n "${BRAI_BRANCH:-}" && -n "${BRAI_COMMIT:-}" ]]; then
  APK_LEDGER_RECORD=true
  APK_VERSION_ARGS+=(--next-apk true --target-branch "$BRAI_BRANCH" --target-commit "$BRAI_COMMIT")
fi
export BRAI_APP_VERSION="${BRAI_APP_VERSION:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-app-version.mjs" "${OTA_VERSION_ARGS[@]}")}"
export BRAI_APK_VERSION="${BRAI_APK_VERSION:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-app-version.mjs" "${APK_VERSION_ARGS[@]}")}"
export BRAI_ANDROID_VERSION_CODE="${BRAI_ANDROID_VERSION_CODE:-$BRAI_APK_VERSION}"
export NEXT_PUBLIC_BRAI_ENVIRONMENT="$ENVIRONMENT"
export NEXT_PUBLIC_BRAI_PREVIEW_SLOT="$SLOT"
export NEXT_PUBLIC_BRAI_BRANCH="${BRAI_BRANCH:-}"
export NEXT_PUBLIC_BRAI_COMMIT="${BRAI_COMMIT:-}"
export NEXT_PUBLIC_BRAI_OTA_CHANNEL="$DOMAIN/mobile-update"
export NEXT_PUBLIC_BRAI_API="/api"
export NEXT_PUBLIC_BRAI_ANDROID_API="$ANDROID_API"
if [[ -z "${JAVA_HOME:-}" && -d "/srv/opt/jdk-21" ]]; then
  export JAVA_HOME="/srv/opt/jdk-21"
  export PATH="$JAVA_HOME/bin:$PATH"
fi
SIGNING_ENV="${BRAI_ANDROID_SIGNING_ENV:-/srv/projects/brai-envs/android-signing/signing.env}"
if [[ -f "$SIGNING_ENV" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$SIGNING_ENV"
  set +a
fi

(cd "$ROOT" && "$NPM_BIN" run app:build)
(cd "$ROOT" && "$NPM_BIN" run app:cap:sync)
if [[ -x "/srv/opt/android-build-env/build-android.sh" ]]; then
  /srv/opt/android-build-env/build-android.sh "$ROOT/apps/brai_app/android" "$GRADLE_TASK"
else
  (cd "$ROOT/apps/brai_app/android" && ./gradlew "$GRADLE_TASK")
fi

APK="$ROOT/apps/brai_app/android/app/build/outputs/apk/$FLAVOR/release/app-$FLAVOR-release.apk"
if [[ ! -f "$APK" ]]; then
  echo "Missing APK output: $APK" >&2
  exit 1
fi

if [[ "$APK_LEDGER_RECORD" == "true" ]]; then
  export BRAI_PUBLISHED_AT="${BRAI_PUBLISHED_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
fi
BRAI_RELEASE_ENV="$RELEASE_KEY" BRAI_APK_SOURCE="$APK" "$SCRIPT_DIR/publish-capacitor-apk.sh"
if [[ "$APK_LEDGER_RECORD" == "true" ]]; then
  "$NODE_BIN" "$SCRIPT_DIR/record-shipped-apk-version.mjs" \
    --db "$BRAI_DB" \
    --version "$BRAI_APK_VERSION" \
    --version-code "$BRAI_ANDROID_VERSION_CODE" \
    --target-branch "$BRAI_BRANCH" \
    --target-commit "$BRAI_COMMIT" \
    --released-at "$BRAI_PUBLISHED_AT"
  LEDGER_VERSION="$("$NODE_BIN" "$SCRIPT_DIR/resolve-app-version.mjs" --kind apk --root "$ROOT" --db "$BRAI_DB")"
  if [[ "$LEDGER_VERSION" != "$BRAI_APK_VERSION" ]]; then
    echo "Published APK version $BRAI_APK_VERSION does not match ledger version $LEDGER_VERSION" >&2
    exit 1
  fi
fi
