#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/permissions.sh"
ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
BRANCH="${BRAI_BRANCH:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)}"
COMMIT="${BRAI_COMMIT:-$(git -C "$ROOT" rev-parse HEAD)}"
RUN_ID="${GITHUB_RUN_NUMBER:-$(date -u +%Y%m%d%H%M%S)}"
SLOT=""

if [[ "$BRANCH" == codex/* ]]; then
  if [[ -n "${BRAI_PREVIEW_SLOT:-}" ]]; then
    SLOT="$BRAI_PREVIEW_SLOT"
    ALLOCATED_NEW="${BRAI_PREVIEW_ALLOCATED_NEW:-false}"
  else
    ALLOCATION_JSON="$("$SCRIPT_DIR/preview-slots.sh" allocate "$BRANCH" "$COMMIT")"
    SLOT="$(printf '%s' "$ALLOCATION_JSON" | "$NODE_BIN" -e 'let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => console.log(JSON.parse(raw).slot));')"
    ALLOCATED_NEW="$(printf '%s' "$ALLOCATION_JSON" | "$NODE_BIN" -e 'let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => console.log(JSON.parse(raw).allocatedNew ? "true" : "false"));')"
  fi
  export BRAI_PREVIEW_SLOT="$SLOT"
  trap '"$SCRIPT_DIR/preview-slots.sh" failed "$BRANCH" "$COMMIT" >/dev/null || true' ERR
else
  ALLOCATED_NEW="false"
fi

mapfile -t DEPLOY_META < <("$NODE_BIN" "$SCRIPT_DIR/resolve-deploy-env.mjs" "$BRANCH")
ENVIRONMENT="${DEPLOY_META[0]}"
DISPLAY_LABEL="${DEPLOY_META[1]}"
DOMAIN="${DEPLOY_META[2]}"
ENV_PATH="${DEPLOY_META[3]}"
SERVICE_NAME="${DEPLOY_META[4]}"
API_PORT="${DEPLOY_META[5]:-}"
ADMIN_SERVICE_NAME="${DEPLOY_META[6]:-}"
ADMIN_PORT="${DEPLOY_META[7]:-}"

GIT_SUBJECT="$(git -C "$ROOT" log -1 --format=%s "$COMMIT" 2>/dev/null || true)"
GIT_BODY="$(git -C "$ROOT" log -1 --format=%b "$COMMIT" 2>/dev/null || true)"
if [[ "$GIT_SUBJECT" == Merge\ pull\ request* && -n "$GIT_BODY" ]]; then
  while IFS= read -r line; do
    if [[ -n "${line//[[:space:]]/}" ]]; then
      GIT_SUBJECT="$line"
    fi
  done <<<"$GIT_BODY"
  GIT_BODY=""
fi
DEPLOY_SHORT_CHANGES="${BRAI_DEPLOY_SHORT_CHANGES:-${GIT_SUBJECT:-Branch deployment}}"
if [[ -n "${BRAI_DEPLOY_DETAILED_CHANGES:-}" ]]; then
  DEPLOY_DETAILED_CHANGES="$BRAI_DEPLOY_DETAILED_CHANGES"
elif [[ -n "$GIT_BODY" ]]; then
  DEPLOY_DETAILED_CHANGES="$GIT_SUBJECT"$'\n\n'"$GIT_BODY"
else
  DEPLOY_DETAILED_CHANGES="${GIT_SUBJECT:-Branch deployment}"
fi

if [[ "$ENVIRONMENT" == "prod" ]]; then
  WEB_TARGET="${BRAI_WEB_TARGET:-$ROOT/deploy/web}"
  MOBILE_TARGET="${BRAI_MOBILE_TARGET:-$ROOT/deploy/mobile-update}"
else
  TARGET_ROOT="${BRAI_ENV_ROOT:-$ENVS_ROOT/$ENV_PATH}"
  umask 0002
  WEB_TARGET="$TARGET_ROOT/web"
  MOBILE_TARGET="$TARGET_ROOT/mobile-update"
  mkdir -p "$WEB_TARGET" "$MOBILE_TARGET"
fi
POSTGRES_URL="${BRAI_DATABASE_URL:-}"
PROD_POSTGRES_URL="${BRAI_PROD_DATABASE_URL:-}"
: "${POSTGRES_URL:?BRAI_DATABASE_URL is required for $ENVIRONMENT deploy}"

wait_for_preview_api() {
  [[ "$ENVIRONMENT" == preview-* || "$ENVIRONMENT" == "dev" ]] || return 0
  [[ -n "$API_PORT" ]] || return 0
  local url="http://127.0.0.1:$API_PORT/health"
  local attempt
  for attempt in {1..20}; do
    if "$NODE_BIN" -e 'fetch(process.argv[1]).then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1));' "$url"; then
      return 0
    fi
    sleep 0.5
  done
  echo "Preview API health check failed ($ENVIRONMENT): $url" >&2
  "${BRAI_SUDO:-sudo}" journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
  return 1
}

wait_for_admin() {
  [[ -n "$ADMIN_PORT" ]] || return 0
  local url="http://127.0.0.1:$ADMIN_PORT/admin"
  local attempt
  for attempt in {1..20}; do
    if "$NODE_BIN" -e 'fetch(process.argv[1]).then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1));' "$url"; then
      return 0
    fi
    sleep 0.5
  done
  echo "Admin health check failed ($ENVIRONMENT): $url" >&2
  if [[ -n "$ADMIN_SERVICE_NAME" ]]; then
    "${BRAI_SUDO:-sudo}" journalctl -u "$ADMIN_SERVICE_NAME" -n 80 --no-pager >&2 || true
  fi
  return 1
}

check_api_service_contract() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local unit
  unit="$("${BRAI_SUDO:-sudo}" systemctl cat "$SERVICE_NAME" 2>/dev/null || true)"
  [[ -n "$unit" ]] || return 0
  if grep -q "BRAI_INBOUND_STORAGE_ROOT" <<<"$unit"; then
    echo "$SERVICE_NAME uses obsolete BRAI_INBOUND_STORAGE_ROOT; use BRAI_INBOX_STORAGE_ROOT" >&2
    return 1
  fi
  if ! grep -q "BRAI_INBOX_STORAGE_ROOT" <<<"$unit"; then
    echo "$SERVICE_NAME has no BRAI_INBOX_STORAGE_ROOT" >&2
    return 1
  fi
  if ! grep -Eq "^(Group|SupplementaryGroups)=.*[=[:space:]]brai([[:space:]]|$)" <<<"$unit"; then
    echo "$SERVICE_NAME does not include the brai runtime group" >&2
    return 1
  fi
  if ! grep -Eq "^(Group|SupplementaryGroups)=.*brai-deploy" <<<"$unit"; then
    echo "$SERVICE_NAME does not include the brai-deploy group" >&2
    return 1
  fi
}

normalize_preview_artifacts() {
  local failed=0
  chmod 2775 "$TARGET_ROOT" 2>/dev/null || true
  normalize_public_tree "$WEB_TARGET" || failed=1
  normalize_public_tree "$MOBILE_TARGET" || failed=1
  return "$failed"
}

OTA_VERSION_ARGS=(
  --environment "$ENVIRONMENT"
  --root "$ROOT"
  --prod-web-version-json "${BRAI_PROD_WEB_VERSION_JSON:-}"
  --mobile-target "$MOBILE_TARGET"
)
if [[ "$ENVIRONMENT" == preview-* && "$BRANCH" == codex/* ]]; then
  OTA_VERSION_ARGS+=(--next-ota true)
fi

VERSION="${BRAI_APP_VERSION:-$(BRAI_DATABASE_URL="$POSTGRES_URL" BRAI_PROD_DATABASE_URL="$PROD_POSTGRES_URL" "$NODE_BIN" "$SCRIPT_DIR/resolve-app-version.mjs" \
  "${OTA_VERSION_ARGS[@]}")}"

if [[ "$ENVIRONMENT" == "prod" ]]; then
  BUNDLE_VERSION="${BRAI_MOBILE_BUNDLE_VERSION:-$VERSION}"
else
  BUNDLE_VERSION="${BRAI_MOBILE_BUNDLE_VERSION:-$VERSION}"
fi

ANDROID_API="https://$DOMAIN/api"
if [[ "$ENVIRONMENT" == "prod" ]]; then
  ANDROID_API="https://api.brai.one"
fi

export BRAI_ROOT="$ROOT"
export BRAI_WEB_TARGET="$WEB_TARGET"
export BRAI_MOBILE_TARGET="$MOBILE_TARGET"
export BRAI_UPDATE_BASE_URL="https://$DOMAIN/mobile-update"
export BRAI_APP_VERSION="$VERSION"
export BRAI_MOBILE_BUNDLE_VERSION="$BUNDLE_VERSION"
export NEXT_PUBLIC_BRAI_APP_VERSION="$VERSION"
export NEXT_PUBLIC_BRAI_ENVIRONMENT="$ENVIRONMENT"
export NEXT_PUBLIC_BRAI_PREVIEW_SLOT="$SLOT"
export NEXT_PUBLIC_BRAI_BRANCH="$BRANCH"
export NEXT_PUBLIC_BRAI_COMMIT="$COMMIT"
export NEXT_PUBLIC_BRAI_OTA_CHANNEL="$DOMAIN/mobile-update"
export NEXT_PUBLIC_BRAI_API="/api"
export NEXT_PUBLIC_BRAI_ANDROID_API="$ANDROID_API"
RELEASE_TARGET="${BRAI_RELEASE_TARGET:-$ROOT/deploy/releases}"

if [[ "$ENVIRONMENT" == preview-* && "$BRANCH" == codex/* && "${BRAI_NATIVE_APK_CHANGE:-false}" != "true" ]]; then
  export BRAI_TARGET_APK_VERSION="$("$NODE_BIN" "$SCRIPT_DIR/resolve-required-apk-version.mjs" prod apkVersion)"
  export BRAI_TARGET_APK_RELEASE_KEY="${SLOT,,}"
  export BRAI_TARGET_APK_BUILD_KIND="stable"
  export BRAI_TARGET_APK_PREVIEW_ITERATION="0"
  export BRAI_TARGET_APK_VERSION_CODE="$("$NODE_BIN" "$SCRIPT_DIR/resolve-required-apk-version.mjs" prod versionCode)"
  "$NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const [releaseIndex, releaseKey, targetApkVersion, targetVersionCode] = process.argv.slice(1);
const fail = (reason) => {
  console.error(`Cannot publish Preview ${releaseKey.toUpperCase()} OTA: ${reason}`);
  process.exit(1);
};
if (!fs.existsSync(releaseIndex)) fail(`release index is missing: ${releaseIndex}`);
let releases;
try {
  releases = JSON.parse(fs.readFileSync(releaseIndex, "utf8"));
} catch {
  fail(`release index is invalid: ${releaseIndex}`);
}
const production = releases.sections?.production;
const slot = releases.sections?.[releaseKey];
const productionApkVersion = Number(production?.apkVersion);
const productionVersionCode = Number(production?.versionCode);
if (!Number.isInteger(productionApkVersion) || productionApkVersion <= 0
  || !Number.isInteger(productionVersionCode) || productionVersionCode <= 0) {
  fail("Production APK baseline is missing apkVersion or versionCode");
}
if (productionApkVersion !== Number(targetApkVersion) || productionVersionCode !== Number(targetVersionCode)) {
  fail("resolved Production APK target does not match releases.json");
}
if (!slot?.file) fail("stable slot APK release is missing");
if (slot.apkBuildKind !== "stable") fail(`slot APK release is ${slot.apkBuildKind || "unknown"}, expected stable`);
const releaseRoot = path.dirname(releaseIndex);
const slotFile = path.resolve(releaseRoot, slot.file);
if (path.dirname(slotFile) !== path.resolve(releaseRoot) || !fs.existsSync(slotFile)) {
  fail(`stable slot APK artifact is missing: ${slot.file}`);
}
if (Number(slot.apkVersion) !== productionApkVersion || Number(slot.versionCode) !== productionVersionCode) {
  fail(`stable slot APK baseline ${slot.apkVersion}/${slot.versionCode} does not match Production ${productionApkVersion}/${productionVersionCode}`);
}
' "$RELEASE_TARGET/releases.json" "$BRAI_TARGET_APK_RELEASE_KEY" "$BRAI_TARGET_APK_VERSION" "$BRAI_TARGET_APK_VERSION_CODE"
fi

"$SCRIPT_DIR/publish-client-web-layer.sh"

echo "Building Brai Admin..."
(cd "$ROOT/admin" && npm run build)

if [[ "$ENVIRONMENT" == "prod" ]]; then
  if [[ -f "$RELEASE_TARGET/releases.json" ]]; then
    BRAI_RELEASE_TARGET="$RELEASE_TARGET" "$NODE_BIN" "$SCRIPT_DIR/update-release-index.mjs" --render-only
  fi
fi

if [[ "$ENVIRONMENT" != "prod" ]]; then
  echo "Normalizing preview artifact roots..."
  if ! normalize_preview_artifacts; then
    echo "Warning: preview artifact root normalization failed; continuing after published artifacts were normalized." >&2
  fi
fi

if [[ "$ENVIRONMENT" != "prod" || "${BRAI_RECORD_PROD_BRANCH_DEPLOYMENT:-false}" == "true" ]]; then
  echo "Recording deployment metadata..."
  if ! BRAI_DATABASE_URL="$POSTGRES_URL" "$NODE_BIN" "$SCRIPT_DIR/record-deployment.mjs" \
    --environment "$ENVIRONMENT" \
    --slot "$SLOT" \
    --branch "$BRANCH" \
    --commit "$COMMIT" \
    --domain "$DOMAIN" \
    --web-ota-version "$VERSION" \
    --short-changes "$DEPLOY_SHORT_CHANGES" \
    --detailed-changes "$DEPLOY_DETAILED_CHANGES" \
    --reason "${BRAI_DEPLOY_REASON:-Автоматическая доставка ветки}"; then
    if [[ "$ENVIRONMENT" != preview-* ]]; then
      exit 1
    fi
    echo "Warning: preview deployment metadata was not recorded; production promotion still requires preview handoff release notes and will not use deployment fallback metadata." >&2
  fi
fi

if [[ "$ENVIRONMENT" != "prod" ]]; then
  echo "Normalizing preview artifact roots after metadata..."
  if ! normalize_preview_artifacts; then
    echo "Warning: preview artifact root normalization after metadata failed; continuing." >&2
  fi
fi

if command -v systemctl >/dev/null 2>&1 && [[ "${BRAI_RESTART_SERVICE:-true}" != "false" ]]; then
  check_api_service_contract
  if [[ "${BRAI_API_ALREADY_RESTARTED:-false}" == "true" ]]; then
    echo "Using the already provisionally verified $SERVICE_NAME."
  else
    echo "Restarting $SERVICE_NAME..."
    "${BRAI_SUDO:-sudo}" systemctl restart "$SERVICE_NAME"
  fi
  wait_for_preview_api
  if [[ "$ENVIRONMENT" == "prod" ]]; then
    echo "Running Codex CLI service smoke as brai..."
    "${BRAI_SUDO:-sudo}" -u brai "$SCRIPT_DIR/codex-cli-smoke.sh"
  fi
  if [[ -n "$ADMIN_SERVICE_NAME" ]]; then
    echo "Restarting $ADMIN_SERVICE_NAME..."
    "${BRAI_SUDO:-sudo}" systemctl restart "$ADMIN_SERVICE_NAME"
    wait_for_admin
  fi
fi

if [[ "$ENVIRONMENT" == preview-* ]]; then
  if [[ "$BRANCH" == codex/* && "${BRAI_NATIVE_APK_CHANGE:-false}" != "true" ]]; then
    "$SCRIPT_DIR/preview-slots.sh" clear-apk "$BRANCH" "$COMMIT" >/dev/null
  fi
fi

echo "Deployed application $BRANCH@$COMMIT to $ENVIRONMENT ($DOMAIN) with bundle $BUNDLE_VERSION; Goal-agent gate remains pending."
