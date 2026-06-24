#!/usr/bin/env bash
set -euo pipefail

ROOT="${BRIGHT_OS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
NODE_PREFIX="${BRIGHT_OS_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ -d "$NODE_PREFIX" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
fi
SOURCE="${BRIGHT_OS_MOBILE_SOURCE:-$ROOT/apps/bright_os_app/out}"
TARGET_ROOT="${BRIGHT_OS_MOBILE_TARGET:-$ROOT/deploy/mobile-update}"
NODE_BIN="${NODE_BIN:-node}"
ZIP_BIN="${ZIP_BIN:-zip}"
VERSION="${BRIGHT_OS_APP_VERSION:-$("$NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const parsed = JSON.parse(fs.readFileSync(path.join(root, "apps/bright_os_app/public/version.json"), "utf8"));
const version = String(parsed.version || "");
if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error("Unable to resolve Bright OS X.Y.Z.S app version");
console.log(version);
' "$ROOT")}"
BUNDLE_VERSION="${BRIGHT_OS_MOBILE_BUNDLE_VERSION:-$VERSION}"
UPDATE_BASE_URL="${BRIGHT_OS_UPDATE_BASE_URL:-https://app.brightos.world/mobile-update}"
MIN_APK_VERSION_CODE="${BRIGHT_OS_MIN_APK_VERSION_CODE:-1}"
MAX_APK_VERSION_CODE="${BRIGHT_OS_MAX_APK_VERSION_CODE:-}"
MANDATORY="${BRIGHT_OS_MOBILE_MANDATORY:-false}"
RETAIN_PREVIOUS="${BRIGHT_OS_MOBILE_RETAIN_PREVIOUS:-3}"
ENTRYPOINT="${BRIGHT_OS_MOBILE_ENTRYPOINT:-index.html}"
PUBLISHED_AT="${BRIGHT_OS_PUBLISHED_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"

node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { console.error(`Bright OS requires Node.js >=22.0.0. Current: ${process.version}.`); process.exit(1); }'

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

if [[ ! "$BUNDLE_VERSION" =~ ^[A-Za-z0-9._+-]+$ ]]; then
  echo "Invalid bundle version: $BUNDLE_VERSION" >&2
  exit 1
fi

ENVIRONMENT="${NEXT_PUBLIC_BRIGHT_OS_ENVIRONMENT:-${BRIGHT_OS_ENVIRONMENT:-prod}}"
if [[ "$ENVIRONMENT" == "prod" && ! "$BUNDLE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Production bundle version must use Bright OS X.Y.Z.S format: $BUNDLE_VERSION" >&2
  exit 1
fi

if [[ "$ENVIRONMENT" != "prod" && ! "$BUNDLE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+([._+-][A-Za-z0-9._+-]+)?$ ]]; then
  echo "Non-production bundle version must start with Bright OS X.Y.Z.S: $BUNDLE_VERSION" >&2
  exit 1
fi

if [[ "$MANDATORY" != "true" && "$MANDATORY" != "false" ]]; then
  echo "BRIGHT_OS_MOBILE_MANDATORY must be true or false" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bright-mobile-bundle.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

PAYLOAD_DIR="$TMP_DIR/payload"
mkdir -p "$PAYLOAD_DIR"
cp -R "$SOURCE"/. "$PAYLOAD_DIR"/

ARCHIVE_URL="${UPDATE_BASE_URL%/}/bundles/$BUNDLE_VERSION/bundle.zip"
PAYLOAD_METADATA="$PAYLOAD_DIR/metadata.json"

"$NODE_BIN" -e '
const fs = require("node:fs");
const [file, bundleVersion, publishedAt, entrypoint, minApk, maxApk, mandatory, archiveUrl] = process.argv.slice(1);
const parsedUrl = new URL(archiveUrl);
if (parsedUrl.protocol !== "https:") throw new Error("archive URL must use HTTPS");
if (parsedUrl.username || parsedUrl.password) throw new Error("archive URL must not include credentials");
const metadata = {
  schemaVersion: 1,
  type: "bright-os-mobile-web-bundle",
  bundleVersion,
  publishedAt,
  entrypoint,
  minApkVersionCode: Number(minApk),
  maxApkVersionCode: maxApk ? Number(maxApk) : null,
  mandatory: mandatory === "true",
  archiveUrl,
  source: "next-static-export"
};
fs.writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`);
' "$PAYLOAD_METADATA" "$BUNDLE_VERSION" "$PUBLISHED_AT" "$ENTRYPOINT" "$MIN_APK_VERSION_CODE" "$MAX_APK_VERSION_CODE" "$MANDATORY" "$ARCHIVE_URL"

ARCHIVE_TMP="$TMP_DIR/bundle.zip"
(cd "$PAYLOAD_DIR" && "$ZIP_BIN" -qry "$ARCHIVE_TMP" .)

SIZE_BYTES="$(wc -c < "$ARCHIVE_TMP" | tr -d ' ')"
SHA256="$(sha256sum "$ARCHIVE_TMP" | awk '{print $1}')"
BUNDLE_DIR="$TARGET_ROOT/bundles/$BUNDLE_VERSION"
ARCHIVE_TARGET="$BUNDLE_DIR/bundle.zip"
METADATA_TARGET="$BUNDLE_DIR/metadata.json"
ARCHIVE_STAGE="$BUNDLE_DIR/.bundle.zip.$$"
METADATA_STAGE="$BUNDLE_DIR/.metadata.json.$$"
MANIFEST_TMP="$TARGET_ROOT/.manifest.json.$$"

mkdir -p "$BUNDLE_DIR"
cp "$ARCHIVE_TMP" "$ARCHIVE_STAGE"
cp "$PAYLOAD_METADATA" "$METADATA_STAGE"
chmod u=rw,go=r "$ARCHIVE_STAGE" "$METADATA_STAGE"

"$NODE_BIN" -e '
const fs = require("node:fs");
const [metadataFile, manifestFile, bundleVersion, publishedAt, archiveUrl, sha256, sizeBytes, entrypoint, minApk, maxApk, mandatory] = process.argv.slice(1);
const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
metadata.sha256 = sha256;
metadata.sizeBytes = Number(sizeBytes);
fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
const manifest = {
  schemaVersion: 1,
  channel: "stable",
  bundleVersion,
  publishedAt,
  archiveUrl,
  sha256,
  sizeBytes: Number(sizeBytes),
  entrypoint,
  minApkVersionCode: Number(minApk),
  maxApkVersionCode: maxApk ? Number(maxApk) : null,
  mandatory: mandatory === "true"
};
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
' "$METADATA_STAGE" "$MANIFEST_TMP" "$BUNDLE_VERSION" "$PUBLISHED_AT" "$ARCHIVE_URL" "$SHA256" "$SIZE_BYTES" "$ENTRYPOINT" "$MIN_APK_VERSION_CODE" "$MAX_APK_VERSION_CODE" "$MANDATORY"

mv "$ARCHIVE_STAGE" "$ARCHIVE_TARGET"
mv "$METADATA_STAGE" "$METADATA_TARGET"
mv "$MANIFEST_TMP" "$TARGET_ROOT/manifest.json"
if [[ -O "$TARGET_ROOT" ]]; then
  find "$TARGET_ROOT" -user "$(id -u)" -exec chmod u=rwX,go=rX {} +
fi

if [[ "$RETAIN_PREVIOUS" =~ ^[0-9]+$ ]]; then
  KEEP_COUNT=$((RETAIN_PREVIOUS + 1))
  mapfile -t BUNDLE_DIRS < <(find "$TARGET_ROOT/bundles" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')
  INDEX=0
  for DIR in "${BUNDLE_DIRS[@]}"; do
    INDEX=$((INDEX + 1))
    if [[ "$INDEX" -le "$KEEP_COUNT" || "$DIR" == "$BUNDLE_DIR" ]]; then
      continue
    fi
    rm -rf "$DIR"
  done
fi

echo "$SHA256  $BUNDLE_DIR/bundle.zip"
echo "Published mobile OTA manifest: $TARGET_ROOT/manifest.json"
