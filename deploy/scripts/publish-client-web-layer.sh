#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ROOT="${BRAI_ROOT:-$DEFAULT_ROOT}"
NODE_PREFIX="${BRAI_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ -d "$NODE_PREFIX" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
fi
node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { console.error(`Brai requires Node.js >=22.0.0. Current: ${process.version}.`); process.exit(1); }'

NPM_BIN="${NPM_BIN:-npm}"
NODE_BIN="${NODE_BIN:-node}"
BUILD_CLIENT="${BRAI_BUILD_CLIENT:-true}"

mapfile -t APP_META < <("$NODE_BIN" -e '
let version = process.env.BRAI_APP_VERSION || "";
const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:\.|$)/);
if (!match) {
  throw new Error("BRAI_APP_VERSION is required as Brai X.Y.Z app version");
}
console.log(match.slice(1, 4).join("."));
' "$ROOT")

VERSION="${APP_META[0]}"
export BRAI_APP_VERSION="$VERSION"
export BRAI_ROOT="$ROOT"
export NODE_BIN="$NODE_BIN"

if [[ "$BUILD_CLIENT" != "false" && "$BUILD_CLIENT" != "0" ]]; then
  echo "Building Brai web layer..."
  (cd "$ROOT" && "$NPM_BIN" run app:build)
else
  echo "Skipping client build because BRAI_BUILD_CLIENT=$BUILD_CLIENT"
fi

"$NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const [root, version] = process.argv.slice(1);
const outVersionFile = path.join(root, "apps/brai_app/out/version.json");
const publicVersionFile = path.join(root, "apps/brai_app/public/version.json");
const sourceFile = fs.existsSync(outVersionFile) ? outVersionFile : publicVersionFile;
const parsed = fs.existsSync(sourceFile) ? JSON.parse(fs.readFileSync(sourceFile, "utf8")) : {};
const [major, release, build] = version.split(".").map(Number);
Object.assign(parsed, {
  version,
  versionParts: { major, release, build },
});
fs.writeFileSync(outVersionFile, `${JSON.stringify(parsed, null, 2)}\n`);
' "$ROOT" "$VERSION"

echo "Publishing browser web assets..."
"$SCRIPT_DIR/publish-web.sh"

export BRAI_MOBILE_BUNDLE_VERSION="${BRAI_MOBILE_BUNDLE_VERSION:-$VERSION}"

ENVIRONMENT="${NEXT_PUBLIC_BRAI_ENVIRONMENT:-${BRAI_ENVIRONMENT:-prod}}"
export BRAI_TARGET_APK_VERSION="${BRAI_TARGET_APK_VERSION:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-required-apk-version.mjs" "$ENVIRONMENT")}"
export BRAI_TARGET_APK_RELEASE_KEY="${BRAI_TARGET_APK_RELEASE_KEY:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-required-apk-version.mjs" "$ENVIRONMENT" releaseKey)}"
export BRAI_TARGET_APK_BUILD_KIND="${BRAI_TARGET_APK_BUILD_KIND:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-required-apk-version.mjs" "$ENVIRONMENT" buildKind)}"
export BRAI_TARGET_APK_PREVIEW_ITERATION="${BRAI_TARGET_APK_PREVIEW_ITERATION:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-required-apk-version.mjs" "$ENVIRONMENT" previewIteration)}"
export BRAI_TARGET_APK_VERSION_CODE="${BRAI_TARGET_APK_VERSION_CODE:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-required-apk-version.mjs" "$ENVIRONMENT" versionCode)}"

echo "Publishing Android OTA bundle..."
"$SCRIPT_DIR/publish-mobile-bundle.sh"
