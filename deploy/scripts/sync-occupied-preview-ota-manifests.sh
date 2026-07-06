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
DEPLOY_REPO="${BRAI_DEPLOY_REPO:-/srv/projects/brai}"
PROD_SOURCE_ROOT="${BRAI_PROD_SOURCE_ROOT:-$ENVS_ROOT/prod/source}"
PROD_POSTGRES_URL="${BRAI_PROD_DATABASE_URL:-${BRAI_DATABASE_URL:-}}"
REGISTRY="${BRAI_PREVIEW_REGISTRY:-$ENVS_ROOT/preview-slots.json}"
MODE="${1:-}"
CHECK_ACCESS=false
if [[ "$MODE" == "--check-access" ]]; then
  CHECK_ACCESS=true
  MODE="--local"
fi

check_access() {
  local check_root="$1"
  test -x "$check_root/deploy/scripts/sync-occupied-preview-ota-manifests.sh"
  test -r "$REGISTRY"
  : "${PROD_POSTGRES_URL:?BRAI_PROD_DATABASE_URL or BRAI_DATABASE_URL is required}"
  BRAI_DATABASE_URL="$PROD_POSTGRES_URL" "$NODE_BIN" "$check_root/deploy/scripts/resolve-app-version.mjs" --environment prod --root "$check_root" >/dev/null
  echo "accepted preview OTA sync access ok: $check_root"
}

if [[ ( "$MODE" != "--local" || "$CHECK_ACCESS" == "true" ) && -n "${BRAI_DEPLOY_HOST:-}" ]]; then
  : "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
  : "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"
  SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
  REMOTE_ROOT="${BRAI_REMOTE_ROOT:-$PROD_SOURCE_ROOT}"
  LOCAL_MODE_ARG="--local"
  if [[ "$CHECK_ACCESS" == "true" ]]; then
    LOCAL_MODE_ARG="--check-access"
  fi
  KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-deploy-key.XXXXXX")"
  trap 'rm -f "$KEY_FILE"' EXIT
  printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
  chmod 600 "$KEY_FILE"
  ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
    "if [ ! -x '$REMOTE_ROOT/deploy/scripts/sync-occupied-preview-ota-manifests.sh' ]; then echo 'Cannot run OTA sync from deploy-owned source: $REMOTE_ROOT' >&2; exit 1; fi; BRAI_ROOT='$REMOTE_ROOT' BRAI_ENVS_ROOT='$ENVS_ROOT' BRAI_PROD_WEB_VERSION_JSON='$DEPLOY_REPO/deploy/web/version.json' BRAI_RELEASE_TARGET='$DEPLOY_REPO/deploy/releases' '$REMOTE_ROOT/deploy/scripts/sync-occupied-preview-ota-manifests.sh' '$LOCAL_MODE_ARG'"
  exit 0
fi

if [[ -z "$PROD_POSTGRES_URL" && -r "/etc/brai/brai-api.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  . /etc/brai/brai-api.env
  set +a
  PROD_POSTGRES_URL="${BRAI_PROD_DATABASE_URL:-${BRAI_DATABASE_URL:-}}"
fi

if [[ "${BRAI_SKIP_DEPLOY_USER_REENTRY:-false}" != "true" ]]; then
  current_user="$(id -un 2>/dev/null || true)"
  deploy_user="${BRAI_DEPLOY_USER:-brai-deploy}"
  if [[ -z "${BRAI_DEPLOY_HOST:-}" && "$current_user" != "$deploy_user" && "$ROOT" == "$DEPLOY_REPO" ]] && command -v sudo >/dev/null 2>&1; then
    REENTRY_MODE_ARGS=()
    if [[ "$CHECK_ACCESS" == "true" ]]; then
      REENTRY_MODE_ARGS=(--check-access)
    elif [[ -n "$MODE" ]]; then
      REENTRY_MODE_ARGS=("$MODE")
    fi
    exec sudo -n -u "$deploy_user" env \
      BRAI_SKIP_DEPLOY_USER_REENTRY=true \
      BRAI_ROOT="$ROOT" \
      BRAI_ENVS_ROOT="$ENVS_ROOT" \
      BRAI_DEPLOY_REPO="$DEPLOY_REPO" \
      BRAI_PROD_SOURCE_ROOT="$PROD_SOURCE_ROOT" \
      BRAI_PROD_DATABASE_URL="$PROD_POSTGRES_URL" \
      BRAI_PROD_WEB_VERSION_JSON="${BRAI_PROD_WEB_VERSION_JSON:-$DEPLOY_REPO/deploy/web/version.json}" \
      BRAI_RELEASE_TARGET="${BRAI_RELEASE_TARGET:-$DEPLOY_REPO/deploy/releases}" \
      "$ROOT/deploy/scripts/sync-occupied-preview-ota-manifests.sh" "${REENTRY_MODE_ARGS[@]}"
  fi
fi

if [[ "$ROOT" == "$DEPLOY_REPO" && "$ROOT" != "$PROD_SOURCE_ROOT" && ( "$MODE" == "" || "$MODE" == "--local" ) ]]; then
  if [[ ! -x "$PROD_SOURCE_ROOT/deploy/scripts/sync-occupied-preview-ota-manifests.sh" ]]; then
    echo "Refusing to sync occupied preview OTA manifests from locked checkout; deploy-owned source is missing: $PROD_SOURCE_ROOT" >&2
    exit 1
  fi
  if [[ "$CHECK_ACCESS" == "true" ]]; then
    check_access "$PROD_SOURCE_ROOT"
    exit 0
  fi
  LOCAL_MODE_ARG="--local"
  exec env \
    BRAI_ROOT="$PROD_SOURCE_ROOT" \
    BRAI_ENVS_ROOT="$ENVS_ROOT" \
    BRAI_DEPLOY_REPO="$DEPLOY_REPO" \
    BRAI_PROD_SOURCE_ROOT="$PROD_SOURCE_ROOT" \
    BRAI_PROD_DATABASE_URL="$PROD_POSTGRES_URL" \
    BRAI_PROD_WEB_VERSION_JSON="${BRAI_PROD_WEB_VERSION_JSON:-$DEPLOY_REPO/deploy/web/version.json}" \
    BRAI_RELEASE_TARGET="${BRAI_RELEASE_TARGET:-$DEPLOY_REPO/deploy/releases}" \
    "$PROD_SOURCE_ROOT/deploy/scripts/sync-occupied-preview-ota-manifests.sh" "$LOCAL_MODE_ARG"
fi

if [[ "$CHECK_ACCESS" == "true" ]]; then
  check_access "$ROOT"
  exit 0
fi

if [[ ! -f "$REGISTRY" ]]; then
  echo "Preview slot registry is missing: $REGISTRY"
  exit 0
fi

: "${PROD_POSTGRES_URL:?BRAI_PROD_DATABASE_URL or BRAI_DATABASE_URL is required}"
VERSION="${BRAI_APP_VERSION:-$(BRAI_DATABASE_URL="$PROD_POSTGRES_URL" "$NODE_BIN" "$ROOT/deploy/scripts/resolve-app-version.mjs" --environment prod --root "$ROOT")}"
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
    BRAI_PROD_DATABASE_URL="$PROD_POSTGRES_URL" \
    BRAI_PROD_WEB_VERSION_JSON="${BRAI_PROD_WEB_VERSION_JSON:-$ROOT/deploy/web/version.json}" \
    BRAI_RELEASE_TARGET="${BRAI_RELEASE_TARGET:-$ROOT/deploy/releases}" \
      "$source_root/deploy/scripts/publish-environment-web-layer.sh" "preview-$slot_lower"
  )
done
