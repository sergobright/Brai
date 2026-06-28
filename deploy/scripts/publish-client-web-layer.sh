#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ROOT="${BRIGHT_OS_ROOT:-$DEFAULT_ROOT}"
NODE_PREFIX="${BRIGHT_OS_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ -d "$NODE_PREFIX" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
fi
node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { console.error(`Bright OS requires Node.js >=22.0.0. Current: ${process.version}.`); process.exit(1); }'

NPM_BIN="${NPM_BIN:-npm}"
NODE_BIN="${NODE_BIN:-node}"
BUILD_CLIENT="${BRIGHT_OS_BUILD_CLIENT:-true}"

mapfile -t APP_META < <("$NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
let version = process.env.BRIGHT_OS_APP_VERSION || "";
const versionFile = path.join(root, "apps/bright_os_app/public/version.json");
if (!version && fs.existsSync(versionFile)) {
  const parsed = JSON.parse(fs.readFileSync(versionFile, "utf8"));
  version = String(parsed.version || "");
}
if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Unable to resolve Bright OS X.Y.Z.S app version");
}
console.log(version);
' "$ROOT")

VERSION="${BRIGHT_OS_APP_VERSION:-${APP_META[0]}}"
export BRIGHT_OS_APP_VERSION="$VERSION"
export BRIGHT_OS_ROOT="$ROOT"
export NODE_BIN="$NODE_BIN"

if [[ "$BUILD_CLIENT" != "false" && "$BUILD_CLIENT" != "0" ]]; then
  echo "Building Bright OS web layer..."
  (cd "$ROOT" && "$NPM_BIN" run app:build)
else
  echo "Skipping client build because BRIGHT_OS_BUILD_CLIENT=$BUILD_CLIENT"
fi

"$NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const [root, version] = process.argv.slice(1);
const outVersionFile = path.join(root, "apps/bright_os_app/out/version.json");
const publicVersionFile = path.join(root, "apps/bright_os_app/public/version.json");
const sourceFile = fs.existsSync(outVersionFile) ? outVersionFile : publicVersionFile;
const parsed = fs.existsSync(sourceFile) ? JSON.parse(fs.readFileSync(sourceFile, "utf8")) : {};
const [major, release, build, apk] = version.split(".").map(Number);
Object.assign(parsed, {
  version,
  versionParts: { major, release, build, apk },
});
fs.writeFileSync(outVersionFile, `${JSON.stringify(parsed, null, 2)}\n`);
' "$ROOT" "$VERSION"

echo "Publishing browser web assets..."
"$SCRIPT_DIR/publish-web.sh"

export BRIGHT_OS_MOBILE_BUNDLE_VERSION="${BRIGHT_OS_MOBILE_BUNDLE_VERSION:-$VERSION}"

ENVIRONMENT="${NEXT_PUBLIC_BRIGHT_OS_ENVIRONMENT:-${BRIGHT_OS_ENVIRONMENT:-prod}}"
if [[ "$ENVIRONMENT" != "prod" ]]; then
  if [[ -n "${BRIGHT_OS_REQUIRED_APK_VERSION_CODE:-}" ]]; then
    export BRIGHT_OS_MIN_APK_VERSION_CODE="${BRIGHT_OS_MIN_APK_VERSION_CODE:-$BRIGHT_OS_REQUIRED_APK_VERSION_CODE}"
    export BRIGHT_OS_MAX_APK_VERSION_CODE="${BRIGHT_OS_MAX_APK_VERSION_CODE:-$BRIGHT_OS_MIN_APK_VERSION_CODE}"
  elif [[ "${BRIGHT_OS_NATIVE_APK_CHANGE:-false}" == "true" ]]; then
    REQUIRED_APK_VERSION_CODE="${BRIGHT_OS_MIN_APK_VERSION_CODE:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-required-apk-version-code.mjs" "$ENVIRONMENT")}"
    export BRIGHT_OS_MIN_APK_VERSION_CODE="${BRIGHT_OS_MIN_APK_VERSION_CODE:-$REQUIRED_APK_VERSION_CODE}"
    export BRIGHT_OS_MAX_APK_VERSION_CODE="${BRIGHT_OS_MAX_APK_VERSION_CODE:-$BRIGHT_OS_MIN_APK_VERSION_CODE}"
  fi
fi

echo "Publishing Android OTA bundle..."
"$SCRIPT_DIR/publish-mobile-bundle.sh"
