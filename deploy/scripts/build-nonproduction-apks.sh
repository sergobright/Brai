#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for flavor in dev previewA previewB previewC previewD previewE; do
  "$SCRIPT_DIR/build-android-env-apk.sh" "$flavor"
done
