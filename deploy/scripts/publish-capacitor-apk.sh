#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/permissions.sh"
ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
APK_VERSION="${BRAI_APK_VERSION:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-app-version.mjs" --kind apk --root "$ROOT" --db "${BRAI_DB:-}")}"
RELEASE_ENV="${BRAI_RELEASE_ENV:-production}"
TARGET_DIR="${BRAI_RELEASE_TARGET:-$ROOT/deploy/releases}"
APK_FLAVOR="$("$NODE_BIN" "$SCRIPT_DIR/apk-release-targets.mjs" "$RELEASE_ENV" androidFlavor)"
APK_BUILD_KIND="${BRAI_APK_BUILD_KIND:-stable}"
APK_PREVIEW_ITERATION="${BRAI_APK_PREVIEW_ITERATION:-}"

if [[ "$APK_BUILD_KIND" != "stable" && "$APK_BUILD_KIND" != "preview" ]]; then
  echo "BRAI_APK_BUILD_KIND must be stable or preview" >&2
  exit 1
fi

if [[ "$APK_BUILD_KIND" == "preview" && ! "$APK_PREVIEW_ITERATION" =~ ^[0-9]+$ ]]; then
  echo "Preview APK builds require numeric BRAI_APK_PREVIEW_ITERATION" >&2
  exit 1
fi

if [[ "$APK_BUILD_KIND" == "preview" && "$APK_PREVIEW_ITERATION" -le 0 ]]; then
  echo "Preview APK builds require positive BRAI_APK_PREVIEW_ITERATION" >&2
  exit 1
fi

if [[ -n "${BRAI_APK_SOURCE:-}" ]]; then
  SOURCE="$BRAI_APK_SOURCE"
elif [[ -n "$APK_FLAVOR" && -f "$ROOT/apps/brai_app/android/app/build/outputs/apk/$APK_FLAVOR/release/app-$APK_FLAVOR-release.apk" ]]; then
  SOURCE="$ROOT/apps/brai_app/android/app/build/outputs/apk/$APK_FLAVOR/release/app-$APK_FLAVOR-release.apk"
else
  SOURCE="$ROOT/apps/brai_app/android/app/build/outputs/apk/release/app-release.apk"
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "Missing Capacitor release APK at $SOURCE" >&2
  exit 1
fi

if [[ "$APK_BUILD_KIND" == "preview" ]]; then
  FILENAME="brai-v$APK_VERSION-preview$APK_PREVIEW_ITERATION.apk"
elif [[ "$RELEASE_ENV" == "production" ]]; then
  FILENAME="brai-v$APK_VERSION.apk"
else
  FILENAME="brai-$RELEASE_ENV-v$APK_VERSION.apk"
fi

mkdir -p "$TARGET_DIR"
PRIMARY="$TARGET_DIR/$FILENAME"
TMP="$TARGET_DIR/.$FILENAME.$$.tmp"
cleanup() {
  rm -f "$TMP"
}
trap cleanup EXIT
cp "$SOURCE" "$TMP"
normalize_public_file "$TMP"
mv -f "$TMP" "$PRIMARY"
trap - EXIT

"$NODE_BIN" "$SCRIPT_DIR/update-release-index.mjs" \
  --release "$RELEASE_ENV" \
  --file "$FILENAME" \
  --apk-version "$APK_VERSION" \
  --version-code "${BRAI_ANDROID_VERSION_CODE:-$APK_VERSION}" \
  --build-kind "$APK_BUILD_KIND" \
  --preview-iteration "${APK_PREVIEW_ITERATION:-0}" \
  --published-at "${BRAI_PUBLISHED_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"

if [[ "$RELEASE_ENV" =~ ^[a-e]$ && "${BRAI_BRANCH:-}" == codex/* ]]; then
  "$SCRIPT_DIR/preview-slots.sh" apk "$BRAI_BRANCH" "${BRAI_COMMIT:-}" "${BRAI_ANDROID_VERSION_CODE:-$APK_VERSION}" "$FILENAME" "$APK_VERSION" "${APK_PREVIEW_ITERATION:-}" "$APK_BUILD_KIND" >/dev/null
fi

normalize_public_tree "$TARGET_DIR"

sha256sum "$PRIMARY"
