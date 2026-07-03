#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_PREFIX="${BRAI_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ -d "$NODE_PREFIX" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
fi
NODE_BIN="${NODE_BIN:-node}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
PROD_DB="${BRAI_PROD_DB:-${BRAI_DB:-$ROOT/data/brai.sqlite}}"
REGISTRY="${BRAI_PREVIEW_REGISTRY:-$ENVS_ROOT/preview-slots.json}"
MODE="${1:-}"

if [[ "$MODE" != "--local" && -n "${BRAI_DEPLOY_HOST:-}" ]]; then
  : "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
  : "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"
  DEPLOY_REPO="${BRAI_DEPLOY_REPO:-/srv/projects/brai}"
  SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
  REMOTE_PROD_DB="${BRAI_PROD_DB:-${BRAI_DB:-$DEPLOY_REPO/data/brai.sqlite}}"
  REMOTE_ROOT="${BRAI_REMOTE_ROOT:-$ENVS_ROOT/prod/source}"
  KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-deploy-key.XXXXXX")"
  trap 'rm -f "$KEY_FILE"' EXIT
  printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
  chmod 600 "$KEY_FILE"
  ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
    "if [ ! -x '$REMOTE_ROOT/deploy/scripts/sync-occupied-preview-ota-manifests.sh' ]; then echo 'Cannot run OTA sync from deploy-owned source: $REMOTE_ROOT' >&2; exit 1; fi; BRAI_ROOT='$REMOTE_ROOT' BRAI_ENVS_ROOT='$ENVS_ROOT' BRAI_PROD_DB='$REMOTE_PROD_DB' BRAI_PROD_WEB_VERSION_JSON='$DEPLOY_REPO/deploy/web/version.json' BRAI_RELEASE_TARGET='$DEPLOY_REPO/deploy/releases' '$REMOTE_ROOT/deploy/scripts/sync-occupied-preview-ota-manifests.sh' --local"
  exit 0
fi

if [[ ! -f "$REGISTRY" ]]; then
  echo "Preview slot registry is missing: $REGISTRY"
  exit 0
fi

VERSION="${BRAI_APP_VERSION:-$("$NODE_BIN" "$ROOT/deploy/scripts/resolve-app-version.mjs" --environment prod --root "$ROOT" --db "$PROD_DB")}"
mapfile -t OCCUPIED_SLOTS < <("$NODE_BIN" -e '
const fs = require("node:fs");
const registry = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const slot of ["A", "B", "C", "D", "E"]) {
  const entry = registry[slot] || {};
  if (entry.branch && (entry.status || "free") !== "free") console.log(slot);
}
' "$REGISTRY")

if [[ "${#OCCUPIED_SLOTS[@]}" -eq 0 ]]; then
  echo "No occupied preview slots to sync."
  exit 0
fi

for slot in "${OCCUPIED_SLOTS[@]}"; do
  slot_lower="${slot,,}"
  source_root="$ENVS_ROOT/preview-$slot_lower/source"
  if [[ ! -d "$source_root" ]]; then
    echo "Missing Preview $slot source: $source_root" >&2
    exit 1
  fi
  echo "Syncing Preview $slot OTA manifest to $VERSION from $source_root."
  (
    cd "$source_root"
    BRAI_ROOT="$source_root" \
    BRAI_ENVS_ROOT="$ENVS_ROOT" \
    BRAI_APP_VERSION="$VERSION" \
    BRAI_MOBILE_BUNDLE_VERSION="$VERSION" \
    BRAI_PROD_DB="$PROD_DB" \
    BRAI_PROD_WEB_VERSION_JSON="${BRAI_PROD_WEB_VERSION_JSON:-$ROOT/deploy/web/version.json}" \
    BRAI_RELEASE_TARGET="${BRAI_RELEASE_TARGET:-$ROOT/deploy/releases}" \
      "$source_root/deploy/scripts/publish-environment-web-layer.sh" "preview-$slot_lower"
  )
done
