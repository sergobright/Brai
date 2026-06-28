#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRIGHT_OS_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
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

ANDROID_API="https://$DOMAIN/api"
if [[ "$ENVIRONMENT" == "prod" ]]; then
  ANDROID_API="https://api.brightos.world"
fi

export BRIGHT_OS_ROOT="$ROOT"
if [[ -z "${BRIGHT_OS_ANDROID_VERSION_CODE:-}" ]]; then
  export BRIGHT_OS_ANDROID_VERSION_CODE="$("$SCRIPT_DIR/apk-version-code.sh" next "manual $FLAVOR APK")"
fi
export BRIGHT_OS_APP_VERSION="${BRIGHT_OS_APP_VERSION:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-app-version.mjs" \
  --environment "$ENVIRONMENT" \
  --root "$ROOT" \
  --db "${BRIGHT_OS_DB:-}" \
  --prod-web-version-json "${BRIGHT_OS_PROD_WEB_VERSION_JSON:-}")}"
export NEXT_PUBLIC_BRIGHT_OS_ENVIRONMENT="$ENVIRONMENT"
export NEXT_PUBLIC_BRIGHT_OS_PREVIEW_SLOT="$SLOT"
export NEXT_PUBLIC_BRIGHT_OS_BRANCH="${BRIGHT_OS_BRANCH:-}"
export NEXT_PUBLIC_BRIGHT_OS_COMMIT="${BRIGHT_OS_COMMIT:-}"
export NEXT_PUBLIC_BRIGHT_OS_OTA_CHANNEL="$DOMAIN/mobile-update"
export NEXT_PUBLIC_BRIGHT_OS_API="/api"
export NEXT_PUBLIC_BRIGHT_OS_ANDROID_API="$ANDROID_API"
if [[ -z "${JAVA_HOME:-}" && -d "/srv/opt/jdk-21" ]]; then
  export JAVA_HOME="/srv/opt/jdk-21"
  export PATH="$JAVA_HOME/bin:$PATH"
fi
SIGNING_ENV="${BRIGHT_OS_ANDROID_SIGNING_ENV:-/srv/projects/bright-os-envs/android-signing/signing.env}"
if [[ -f "$SIGNING_ENV" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$SIGNING_ENV"
  set +a
fi

(cd "$ROOT" && "$NPM_BIN" run app:build)
(cd "$ROOT" && "$NPM_BIN" run app:cap:sync)
if [[ -x "/srv/opt/android-build-env/build-android.sh" ]]; then
  /srv/opt/android-build-env/build-android.sh "$ROOT/apps/bright_os_app/android" "$GRADLE_TASK"
else
  (cd "$ROOT/apps/bright_os_app/android" && ./gradlew "$GRADLE_TASK")
fi

APK="$ROOT/apps/bright_os_app/android/app/build/outputs/apk/$FLAVOR/release/app-$FLAVOR-release.apk"
if [[ ! -f "$APK" ]]; then
  echo "Missing APK output: $APK" >&2
  exit 1
fi

BRIGHT_OS_RELEASE_ENV="$RELEASE_KEY" BRIGHT_OS_APK_SOURCE="$APK" "$SCRIPT_DIR/publish-capacitor-apk.sh"
