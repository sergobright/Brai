#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRIGHT_OS_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
ENVS_ROOT="${BRIGHT_OS_ENVS_ROOT:-/srv/projects/bright-os-envs}"

if [[ "$#" -eq 0 ]]; then
  echo "usage: publish-environment-web-layer.sh dev|preview-a|preview-b|preview-c|preview-d|preview-e [...]" >&2
  exit 1
fi

VERSION="${BRIGHT_OS_APP_VERSION:-$("$NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const parsed = JSON.parse(fs.readFileSync(path.join(root, "apps/bright_os_app/public/version.json"), "utf8"));
console.log(parsed.version);
' "$ROOT")}"

for ENVIRONMENT in "$@"; do
  mapfile -t META < <("$NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const key = process.argv[2];
const { environments } = JSON.parse(fs.readFileSync(path.join(root, "deploy/environments.json"), "utf8"));
const env = environments[key];
if (!env || key === "prod") throw new Error(`unsupported non-production environment: ${key}`);
console.log(env.domain);
console.log(env.path);
console.log(key.startsWith("preview-") ? env.displayLabel : "");
' "$ROOT" "$ENVIRONMENT")

  DOMAIN="${META[0]}"
  ENV_PATH="${META[1]}"
  SLOT="${META[2]}"
  TARGET_ROOT="$ENVS_ROOT/$ENV_PATH"

  BRIGHT_OS_ROOT="$ROOT" \
  BRIGHT_OS_WEB_TARGET="$TARGET_ROOT/web" \
  BRIGHT_OS_MOBILE_TARGET="$TARGET_ROOT/mobile-update" \
  BRIGHT_OS_UPDATE_BASE_URL="https://$DOMAIN/mobile-update" \
  BRIGHT_OS_APP_VERSION="$VERSION" \
  BRIGHT_OS_MOBILE_BUNDLE_VERSION="${BRIGHT_OS_MOBILE_BUNDLE_VERSION:-$VERSION.0}" \
  NEXT_PUBLIC_BRIGHT_OS_ENVIRONMENT="$ENVIRONMENT" \
  NEXT_PUBLIC_BRIGHT_OS_PREVIEW_SLOT="$SLOT" \
  NEXT_PUBLIC_BRIGHT_OS_BRANCH="${BRIGHT_OS_BRANCH:-}" \
  NEXT_PUBLIC_BRIGHT_OS_COMMIT="${BRIGHT_OS_COMMIT:-}" \
  NEXT_PUBLIC_BRIGHT_OS_OTA_CHANNEL="$DOMAIN/mobile-update" \
  NEXT_PUBLIC_BRIGHT_OS_API="/api" \
  NEXT_PUBLIC_BRIGHT_OS_ANDROID_API="https://$DOMAIN/api" \
  "$SCRIPT_DIR/publish-client-web-layer.sh"
done
