#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${BRIGHT_OS_ANDROID_VERSION_CODE:-}" ]]; then
  export BRIGHT_OS_ANDROID_VERSION_CODE="$("$SCRIPT_DIR/apk-version-code.sh" next "non-production APK baseline")"
fi

for flavor in previewA previewB previewC previewD previewE; do
  "$SCRIPT_DIR/build-android-env-apk.sh" "$flavor"
done
