#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"

if [[ "$#" -eq 0 ]]; then
  echo "usage: publish-environment-web-layer.sh preview-a|preview-b|preview-c|preview-d|preview-e [...]" >&2
  exit 1
fi

VERSION="$("$NODE_BIN" -e '
let version = process.env.BRAI_APP_VERSION || "";
const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:\.|$)/);
if (!match) throw new Error("BRAI_APP_VERSION is required as Brai X.Y.Z app version");
console.log(match.slice(1, 4).join("."));
' "$ROOT")"

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

  BRAI_ROOT="$ROOT" \
  BRAI_WEB_TARGET="$TARGET_ROOT/web" \
  BRAI_MOBILE_TARGET="$TARGET_ROOT/mobile-update" \
  BRAI_UPDATE_BASE_URL="https://$DOMAIN/mobile-update" \
  BRAI_APP_VERSION="$VERSION" \
  BRAI_MOBILE_BUNDLE_VERSION="${BRAI_MOBILE_BUNDLE_VERSION:-$VERSION}" \
  NEXT_PUBLIC_BRAI_ENVIRONMENT="$ENVIRONMENT" \
  NEXT_PUBLIC_BRAI_PREVIEW_SLOT="$SLOT" \
  NEXT_PUBLIC_BRAI_BRANCH="${BRAI_BRANCH:-}" \
  NEXT_PUBLIC_BRAI_COMMIT="${BRAI_COMMIT:-}" \
  NEXT_PUBLIC_BRAI_OTA_CHANNEL="$DOMAIN/mobile-update" \
  NEXT_PUBLIC_BRAI_API="/api" \
  NEXT_PUBLIC_BRAI_ANDROID_API="https://$DOMAIN/api" \
  "$SCRIPT_DIR/publish-client-web-layer.sh"
done
