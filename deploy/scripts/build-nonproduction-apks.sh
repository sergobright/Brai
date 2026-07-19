#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"

PRODUCTION_APK_VERSION="$("$NODE_BIN" "$SCRIPT_DIR/resolve-required-apk-version.mjs" prod apkVersion)"
if ! [[ "$PRODUCTION_APK_VERSION" =~ ^[1-9][0-9]*$ ]]; then
  echo "Published Production APK baseline is invalid: ${PRODUCTION_APK_VERSION:-missing}" >&2
  exit 1
fi
if [[ -n "${BRAI_APK_VERSION:-}" && "$BRAI_APK_VERSION" != "$PRODUCTION_APK_VERSION" ]]; then
  echo "Requested APK baseline $BRAI_APK_VERSION does not match published Production $PRODUCTION_APK_VERSION" >&2
  exit 1
fi
export BRAI_APK_VERSION="$PRODUCTION_APK_VERSION"

for flavor in dev previewA previewB previewC previewD previewE; do
  BRAI_BUILD_CLIENT=false "$SCRIPT_DIR/build-android-env-apk.sh" "$flavor"
done
