#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_ROOT="$ROOT/apps/brai_app/android"
TASK=":app:testProductionDebugUnitTest"

export BRAI_APP_VERSION="${BRAI_APP_VERSION:-0.0.0}"
export BRAI_APK_VERSION="${BRAI_APK_VERSION:-1}"
export BRAI_ANDROID_VERSION_CODE="${BRAI_ANDROID_VERSION_CODE:-1}"
export BRAI_APK_BUILD_KIND="${BRAI_APK_BUILD_KIND:-local-debug}"
export NEXT_PUBLIC_BRAI_ENVIRONMENT="${NEXT_PUBLIC_BRAI_ENVIRONMENT:-prod}"
export NEXT_PUBLIC_BRAI_API="${NEXT_PUBLIC_BRAI_API:-/api}"
export NEXT_PUBLIC_BRAI_ANDROID_API="${NEXT_PUBLIC_BRAI_ANDROID_API:-https://api.brai.one}"
export NEXT_PUBLIC_BRAI_OTA_CHANNEL="${NEXT_PUBLIC_BRAI_OTA_CHANNEL:-app.brai.one/mobile-update}"
unset BRAI_ANDROID_KEYSTORE_PATH BRAI_ANDROID_STORE_PASSWORD BRAI_ANDROID_KEY_ALIAS BRAI_ANDROID_KEY_PASSWORD

run_capacitor_sync() {
  local settings="$ANDROID_ROOT/capacitor.settings.gradle"
  local backup status=0
  backup="$(mktemp)"
  cp -- "$settings" "$backup"
  (cd "$ROOT" && npm run app:cap:sync) || status=$?
  cp -- "$backup" "$settings"
  rm -f -- "$backup"
  return "$status"
}

if [[ -z "${JAVA_HOME:-}" && -d /srv/opt/jdk-21 ]]; then
  export JAVA_HOME=/srv/opt/jdk-21
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if [[ ! -f "$ANDROID_ROOT/capacitor-cordova-android-plugins/cordova.variables.gradle" ]]; then
  (cd "$ROOT" && npm run app:build)
  run_capacitor_sync
fi

if [[ -x /srv/opt/android-build-env/build-android.sh ]]; then
  exec /srv/opt/android-build-env/build-android.sh "$ANDROID_ROOT" "$TASK"
fi
exec "$ANDROID_ROOT/gradlew" -p "$ANDROID_ROOT" "$TASK"
