#!/usr/bin/env bash
set -euo pipefail

ROOT="${BRAI_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/permissions.sh"
NODE_PREFIX="${BRAI_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ -d "$NODE_PREFIX" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
fi
SOURCE="${BRAI_MOBILE_SOURCE:-$ROOT/apps/brai_app/out}"
TARGET_ROOT="${BRAI_MOBILE_TARGET:-$ROOT/deploy/mobile-update}"
NODE_BIN="${NODE_BIN:-node}"
ZIP_BIN="${ZIP_BIN:-zip}"
VERSION="$("$NODE_BIN" -e '
let version = process.env.BRAI_APP_VERSION || "";
const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:\.|$)/);
if (!match) throw new Error("BRAI_APP_VERSION is required as Brai X.Y.Z app version");
console.log(match.slice(1, 4).join("."));
' "$ROOT")"
OTA_VERSION="${BRAI_OTA_VERSION:-$VERSION}"
BUNDLE_ID="${BRAI_MOBILE_BUNDLE_VERSION:-$OTA_VERSION}"
UPDATE_BASE_URL="${BRAI_UPDATE_BASE_URL:-https://app.brai.one/mobile-update}"
TARGET_APK_VERSION="${BRAI_TARGET_APK_VERSION:-${BRAI_APK_VERSION:-1}}"
TARGET_APK_RELEASE_KEY="${BRAI_TARGET_APK_RELEASE_KEY:-production}"
TARGET_APK_BUILD_KIND="${BRAI_TARGET_APK_BUILD_KIND:-stable}"
TARGET_APK_PREVIEW_ITERATION="${BRAI_TARGET_APK_PREVIEW_ITERATION:-0}"
TARGET_APK_VERSION_CODE="${BRAI_TARGET_APK_VERSION_CODE:-$TARGET_APK_VERSION}"
MANDATORY="${BRAI_MOBILE_MANDATORY:-false}"
RETAIN_PREVIOUS="${BRAI_MOBILE_RETAIN_PREVIOUS:-3}"
ENTRYPOINT="${BRAI_MOBILE_ENTRYPOINT:-index.html}"
PUBLISHED_AT="${BRAI_PUBLISHED_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"

node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { console.error(`Brai requires Node.js >=22.0.0. Current: ${process.version}.`); process.exit(1); }'

if [[ ! -d "$SOURCE" ]]; then
  echo "Missing Next.js static export at $SOURCE" >&2
  exit 1
fi

if [[ ! -f "$SOURCE/$ENTRYPOINT" ]]; then
  echo "Missing mobile bundle entrypoint at $SOURCE/$ENTRYPOINT" >&2
  exit 1
fi

if ! command -v "$ZIP_BIN" >/dev/null 2>&1; then
  echo "Missing zip command required for mobile bundle publication" >&2
  exit 1
fi

if [[ ! "$OTA_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid OTA version: $OTA_VERSION" >&2
  exit 1
fi

if [[ ! "$BUNDLE_ID" =~ ^[A-Za-z0-9._+-]+$ ]]; then
  echo "Invalid bundle id: $BUNDLE_ID" >&2
  exit 1
fi

if [[ "$MANDATORY" != "true" && "$MANDATORY" != "false" ]]; then
  echo "BRAI_MOBILE_MANDATORY must be true or false" >&2
  exit 1
fi

if [[ ! "$TARGET_APK_VERSION" =~ ^[0-9]+$ || "$TARGET_APK_VERSION" -le 0 ]]; then
  echo "BRAI_TARGET_APK_VERSION must be a positive integer" >&2
  exit 1
fi

if [[ ! "$TARGET_APK_RELEASE_KEY" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "BRAI_TARGET_APK_RELEASE_KEY must contain only letters, numbers, dot, underscore, or dash" >&2
  exit 1
fi

if [[ "$TARGET_APK_BUILD_KIND" != "stable" && "$TARGET_APK_BUILD_KIND" != "preview" ]]; then
  echo "BRAI_TARGET_APK_BUILD_KIND must be stable or preview" >&2
  exit 1
fi

if [[ ! "$TARGET_APK_PREVIEW_ITERATION" =~ ^[0-9]+$ ]]; then
  echo "BRAI_TARGET_APK_PREVIEW_ITERATION must be a non-negative integer" >&2
  exit 1
fi

if [[ "$TARGET_APK_BUILD_KIND" == "preview" && "$TARGET_APK_PREVIEW_ITERATION" -le 0 ]]; then
  echo "Preview OTA targets must include a positive BRAI_TARGET_APK_PREVIEW_ITERATION" >&2
  exit 1
fi

if [[ ! "$TARGET_APK_VERSION_CODE" =~ ^[0-9]+$ || "$TARGET_APK_VERSION_CODE" -le 0 ]]; then
  echo "BRAI_TARGET_APK_VERSION_CODE must be a positive integer" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/brai-mobile-bundle.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

PAYLOAD_DIR="$TMP_DIR/payload"
mkdir -p "$PAYLOAD_DIR"
cp -R "$SOURCE"/. "$PAYLOAD_DIR"/

ARCHIVE_URL="${UPDATE_BASE_URL%/}/bundles/$BUNDLE_ID/bundle.zip"
PAYLOAD_METADATA="$PAYLOAD_DIR/metadata.json"

"$NODE_BIN" -e '
const fs = require("node:fs");
const [file, otaVersion, bundleId, publishedAt, entrypoint, targetApk, targetReleaseKey, targetBuildKind, targetPreviewIteration, targetVersionCode, mandatory, archiveUrl] = process.argv.slice(1);
const parsedUrl = new URL(archiveUrl);
if (parsedUrl.protocol !== "https:") throw new Error("archive URL must use HTTPS");
if (parsedUrl.username || parsedUrl.password) throw new Error("archive URL must not include credentials");
const metadata = {
  schemaVersion: 2,
  type: "brai-mobile-web-bundle",
  otaVersion,
  bundleId,
  publishedAt,
  entrypoint,
  targetApkVersion: Number(targetApk),
  targetApkReleaseKey: targetReleaseKey,
  targetApkBuildKind: targetBuildKind,
  targetApkPreviewIteration: Number(targetPreviewIteration),
  targetApkVersionCode: Number(targetVersionCode),
  mandatory: mandatory === "true",
  archiveUrl,
  source: "next-static-export"
};
fs.writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`);
' "$PAYLOAD_METADATA" "$OTA_VERSION" "$BUNDLE_ID" "$PUBLISHED_AT" "$ENTRYPOINT" "$TARGET_APK_VERSION" "$TARGET_APK_RELEASE_KEY" "$TARGET_APK_BUILD_KIND" "$TARGET_APK_PREVIEW_ITERATION" "$TARGET_APK_VERSION_CODE" "$MANDATORY" "$ARCHIVE_URL"

ARCHIVE_TMP="$TMP_DIR/bundle.zip"
(cd "$PAYLOAD_DIR" && "$ZIP_BIN" -qry "$ARCHIVE_TMP" .)

SIZE_BYTES="$(wc -c < "$ARCHIVE_TMP" | tr -d ' ')"
SHA256="$(sha256sum "$ARCHIVE_TMP" | awk '{print $1}')"
BUNDLE_DIR="$TARGET_ROOT/bundles/$BUNDLE_ID"
ARCHIVE_TARGET="$BUNDLE_DIR/bundle.zip"
METADATA_TARGET="$BUNDLE_DIR/metadata.json"
ARCHIVE_STAGE="$BUNDLE_DIR/.bundle.zip.$$"
METADATA_STAGE="$BUNDLE_DIR/.metadata.json.$$"
MANIFEST_TMP="$TARGET_ROOT/.manifest.json.$$"

mkdir -p "$BUNDLE_DIR"
cp "$ARCHIVE_TMP" "$ARCHIVE_STAGE"
cp "$PAYLOAD_METADATA" "$METADATA_STAGE"
normalize_public_file "$ARCHIVE_STAGE"
normalize_public_file "$METADATA_STAGE"

"$NODE_BIN" -e '
const fs = require("node:fs");
const [metadataFile, manifestFile, otaVersion, publishedAt, archiveUrl, sha256, sizeBytes, entrypoint, targetApk, targetReleaseKey, targetBuildKind, targetPreviewIteration, targetVersionCode, mandatory] = process.argv.slice(1);
const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
metadata.sha256 = sha256;
metadata.sizeBytes = Number(sizeBytes);
fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
const manifest = {
  schemaVersion: 2,
  otaVersion,
  targetApkVersion: Number(targetApk),
  targetApkReleaseKey: targetReleaseKey,
  targetApkBuildKind: targetBuildKind,
  targetApkPreviewIteration: Number(targetPreviewIteration),
  targetApkVersionCode: Number(targetVersionCode),
  publishedAt,
  archiveUrl,
  sha256,
  sizeBytes: Number(sizeBytes),
  entrypoint,
  mandatory: mandatory === "true"
};
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
' "$METADATA_STAGE" "$MANIFEST_TMP" "$OTA_VERSION" "$PUBLISHED_AT" "$ARCHIVE_URL" "$SHA256" "$SIZE_BYTES" "$ENTRYPOINT" "$TARGET_APK_VERSION" "$TARGET_APK_RELEASE_KEY" "$TARGET_APK_BUILD_KIND" "$TARGET_APK_PREVIEW_ITERATION" "$TARGET_APK_VERSION_CODE" "$MANDATORY"

normalize_public_file "$MANIFEST_TMP"
mv "$ARCHIVE_STAGE" "$ARCHIVE_TARGET"
mv "$METADATA_STAGE" "$METADATA_TARGET"
mv "$MANIFEST_TMP" "$TARGET_ROOT/manifest.json"
normalize_public_tree "$TARGET_ROOT"

if [[ "$RETAIN_PREVIOUS" =~ ^[0-9]+$ ]]; then
  KEEP_COUNT=$((RETAIN_PREVIOUS + 1))
  mapfile -t BUNDLE_DIRS < <(find "$TARGET_ROOT/bundles" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')
  INDEX=0
  for DIR in "${BUNDLE_DIRS[@]}"; do
    INDEX=$((INDEX + 1))
    if [[ "$INDEX" -le "$KEEP_COUNT" || "$DIR" == "$BUNDLE_DIR" ]]; then
      continue
    fi
    if ! rm -rf "$DIR"; then
      echo "Warning: failed to remove old OTA bundle directory: $DIR" >&2
    fi
  done
fi

echo "$SHA256  $BUNDLE_DIR/bundle.zip"
echo "Published mobile OTA manifest: $TARGET_ROOT/manifest.json"
