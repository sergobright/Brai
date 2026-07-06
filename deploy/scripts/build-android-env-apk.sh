#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"
FLAVOR="${1:-}"

if [[ -z "$FLAVOR" ]]; then
  echo "usage: build-android-env-apk.sh production|dev|previewA|previewB|previewC|previewD|previewE" >&2
  exit 1
fi

mapfile -t META < <("$NODE_BIN" "$SCRIPT_DIR/resolve-android-env.mjs" "$FLAVOR")
ENVIRONMENT="${META[0]}"
SLOT="${META[1]}"
DOMAIN="${META[2]}"
GRADLE_TASK="${META[3]}"
RELEASE_KEY="${META[4]}"
ENV_PATH="${META[5]}"

ANDROID_API="https://$DOMAIN/api"
if [[ "$ENVIRONMENT" == "prod" ]]; then
  ANDROID_API="https://api.brightos.world"
fi

export BRAI_ROOT="$ROOT"
APK_LEDGER_RECORD=false
MOBILE_TARGET="${BRAI_MOBILE_TARGET:-}"
if [[ -z "$MOBILE_TARGET" && -n "$ENV_PATH" ]]; then
  MOBILE_TARGET="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}/$ENV_PATH/mobile-update"
fi
OTA_VERSION_ARGS=(
  --environment "$ENVIRONMENT" \
  --root "$ROOT" \
  --prod-web-version-json "${BRAI_PROD_WEB_VERSION_JSON:-}" \
  --mobile-target "$MOBILE_TARGET"
)
APK_VERSION_ARGS=(--kind apk --root "$ROOT")
if [[ "$ENVIRONMENT" == preview-* && "${BRAI_BRANCH:-}" == codex/* && -n "${BRAI_COMMIT:-}" ]]; then
  APK_VERSION_ARGS+=(--next-apk true --target-branch "$BRAI_BRANCH" --target-commit "$BRAI_COMMIT")
fi
if [[ "$ENVIRONMENT" == "prod" && "${BRAI_RECORD_APK_LEDGER:-true}" != "false" && -n "${BRAI_DATABASE_URL:-}" && -z "${BRAI_APP_VERSION:-}" && -n "${BRAI_BRANCH:-}" && -n "${BRAI_COMMIT:-}" ]]; then
  APK_LEDGER_RECORD=true
  APK_VERSION_ARGS+=(--next-apk true --target-branch "$BRAI_BRANCH" --target-commit "$BRAI_COMMIT")
fi
export BRAI_APP_VERSION="${BRAI_APP_VERSION:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-app-version.mjs" "${OTA_VERSION_ARGS[@]}")}"
export BRAI_APK_VERSION="${BRAI_APK_VERSION:-$("$NODE_BIN" "$SCRIPT_DIR/resolve-app-version.mjs" "${APK_VERSION_ARGS[@]}")}"
export BRAI_APK_RELEASE_KEY="${BRAI_APK_RELEASE_KEY:-$RELEASE_KEY}"
if [[ "$ENVIRONMENT" == preview-* && "${BRAI_BRANCH:-}" == codex/* && -n "${BRAI_COMMIT:-}" ]]; then
  PREVIEW_JSON="$("$SCRIPT_DIR/preview-slots.sh" next-apk-preview "$BRAI_BRANCH" "$BRAI_COMMIT" "$BRAI_APK_VERSION")"
  export BRAI_APK_BUILD_KIND="preview"
  export BRAI_APK_PREVIEW_ITERATION="$(printf '%s' "$PREVIEW_JSON" | "$NODE_BIN" -e 'let raw = ""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => console.log(JSON.parse(raw).previewIteration));')"
  export BRAI_ANDROID_VERSION_CODE="$(printf '%s' "$PREVIEW_JSON" | "$NODE_BIN" -e 'let raw = ""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => console.log(JSON.parse(raw).versionCode));')"
  export BRAI_ANDROID_APP_LABEL="${BRAI_ANDROID_APP_LABEL:-Brai $SLOT v${BRAI_APK_VERSION}.${BRAI_APK_PREVIEW_ITERATION}}"
else
  export BRAI_APK_BUILD_KIND="${BRAI_APK_BUILD_KIND:-stable}"
  export BRAI_APK_PREVIEW_ITERATION="${BRAI_APK_PREVIEW_ITERATION:-0}"
  export BRAI_ANDROID_VERSION_CODE="${BRAI_ANDROID_VERSION_CODE:-$BRAI_APK_VERSION}"
fi
export NEXT_PUBLIC_BRAI_ENVIRONMENT="$ENVIRONMENT"
export NEXT_PUBLIC_BRAI_PREVIEW_SLOT="$SLOT"
export NEXT_PUBLIC_BRAI_BRANCH="${BRAI_BRANCH:-}"
export NEXT_PUBLIC_BRAI_COMMIT="${BRAI_COMMIT:-}"
export NEXT_PUBLIC_BRAI_OTA_CHANNEL="$DOMAIN/mobile-update"
export NEXT_PUBLIC_BRAI_API="/api"
export NEXT_PUBLIC_BRAI_ANDROID_API="$ANDROID_API"
if [[ -z "${JAVA_HOME:-}" && -d "/srv/opt/jdk-21" ]]; then
  export JAVA_HOME="/srv/opt/jdk-21"
  export PATH="$JAVA_HOME/bin:$PATH"
fi
SIGNING_ENV="${BRAI_ANDROID_SIGNING_ENV:-/srv/projects/brai-envs/android-signing/signing.env}"
if [[ -f "$SIGNING_ENV" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$SIGNING_ENV"
  set +a
fi

verify_version_json() {
  local file="$1"
  local expected="$2"
  if [[ ! -f "$file" ]]; then
    echo "Missing version.json: $file" >&2
    exit 1
  fi
  local actual
  actual="$("$NODE_BIN" -e '
const fs = require("node:fs");
const [file] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(parsed.version || "");
' "$file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "version.json mismatch in $file: expected $expected, got ${actual:-missing}" >&2
    exit 1
  fi
}

(cd "$ROOT" && "$NPM_BIN" run app:build)
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
' "$ROOT" "$BRAI_APP_VERSION"
verify_version_json "$ROOT/apps/brai_app/out/version.json" "$BRAI_APP_VERSION"
(cd "$ROOT" && "$NPM_BIN" run app:cap:sync)
verify_version_json "$ROOT/apps/brai_app/android/app/src/main/assets/public/version.json" "$BRAI_APP_VERSION"
if [[ -x "/srv/opt/android-build-env/build-android.sh" ]]; then
  /srv/opt/android-build-env/build-android.sh "$ROOT/apps/brai_app/android" "$GRADLE_TASK"
else
  (cd "$ROOT/apps/brai_app/android" && ./gradlew "$GRADLE_TASK")
fi

APK="$ROOT/apps/brai_app/android/app/build/outputs/apk/$FLAVOR/release/app-$FLAVOR-release.apk"
if [[ ! -f "$APK" ]]; then
  echo "Missing APK output: $APK" >&2
  exit 1
fi

if ! command -v unzip >/dev/null 2>&1; then
  echo "unzip is required to verify embedded APK version.json" >&2
  exit 1
fi
APK_VERSION_JSON="$(unzip -p "$APK" assets/public/version.json)"
APK_EMBEDDED_VERSION="$(printf '%s' "$APK_VERSION_JSON" | "$NODE_BIN" -e '
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const parsed = JSON.parse(raw);
  console.log(parsed.version || "");
});
')"
if [[ "$APK_EMBEDDED_VERSION" != "$BRAI_APP_VERSION" ]]; then
  echo "Embedded APK version.json mismatch: expected $BRAI_APP_VERSION, got ${APK_EMBEDDED_VERSION:-missing}" >&2
  exit 1
fi

if [[ "$APK_LEDGER_RECORD" == "true" ]]; then
  export BRAI_PUBLISHED_AT="${BRAI_PUBLISHED_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
fi
BRAI_RELEASE_ENV="$RELEASE_KEY" BRAI_APK_SOURCE="$APK" "$SCRIPT_DIR/publish-capacitor-apk.sh"
if [[ "$APK_LEDGER_RECORD" == "true" ]]; then
  BRAI_DATABASE_URL="${BRAI_DATABASE_URL:-}" "$NODE_BIN" "$SCRIPT_DIR/record-shipped-apk-version.mjs" \
    --version "$BRAI_APK_VERSION" \
    --version-code "$BRAI_ANDROID_VERSION_CODE" \
    --target-branch "$BRAI_BRANCH" \
    --target-commit "$BRAI_COMMIT" \
    --released-at "$BRAI_PUBLISHED_AT"
  LEDGER_VERSION="$(BRAI_DATABASE_URL="${BRAI_DATABASE_URL:-}" "$NODE_BIN" "$SCRIPT_DIR/resolve-app-version.mjs" --kind apk --root "$ROOT")"
  if [[ "$LEDGER_VERSION" != "$BRAI_APK_VERSION" ]]; then
    echo "Published APK version $BRAI_APK_VERSION does not match ledger version $LEDGER_VERSION" >&2
    exit 1
  fi
fi
