#!/usr/bin/env bash
set -euo pipefail

: "${BRIGHT_DEPLOY_HOST:?BRIGHT_DEPLOY_HOST is required}"
: "${BRIGHT_DEPLOY_USER:?BRIGHT_DEPLOY_USER is required}"
: "${BRIGHT_DEPLOY_SSH_KEY:?BRIGHT_DEPLOY_SSH_KEY is required}"
: "${BRIGHT_OS_BRANCH:?BRIGHT_OS_BRANCH is required}"

DEPLOY_REPO="${BRIGHT_DEPLOY_REPO:-/srv/projects/bright-os}"
SSH_PORT="${BRIGHT_DEPLOY_SSH_PORT:-22}"
ENVS_ROOT="${BRIGHT_OS_ENVS_ROOT:-/srv/projects/bright-os-envs}"
REQUIRE_RELEASE="${BRIGHT_OS_REQUIRE_PREVIEW_SLOT_RELEASE:-false}"
NODE_BIN="${NODE_BIN:-node}"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/bright-deploy-key.XXXXXX")"
cleanup() {
  rm -f "$KEY_FILE"
}
trap cleanup EXIT

printf '%s\n' "$BRIGHT_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

RELEASE_JSON="$(ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRIGHT_DEPLOY_USER@$BRIGHT_DEPLOY_HOST" \
  bash -s -- "$DEPLOY_REPO" "$ENVS_ROOT" "$BRIGHT_OS_BRANCH" "$REQUIRE_RELEASE" "${BRIGHT_OS_ACCEPTED_PREVIEW:-false}" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
ENVS_ROOT="$2"
BRIGHT_OS_BRANCH="$3"
REQUIRE_RELEASE="$4"
BRIGHT_OS_ACCEPTED_PREVIEW="$5"
RELEASE_BRANCH="$BRIGHT_OS_BRANCH"
NODE_PREFIX="${BRIGHT_OS_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ -d "$NODE_PREFIX" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
fi

RELEASE_ROOT="$DEPLOY_REPO"
REGISTRY="${BRIGHT_OS_PREVIEW_REGISTRY:-$ENVS_ROOT/preview-slots.json}"
if [[ -f "$REGISTRY" ]]; then
  SLOT_SOURCE="$(node - "$REGISTRY" "$BRIGHT_OS_BRANCH" <<'NODE' || true
const fs = require("node:fs");
const [registryPath, branch] = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
for (const [slot, entry] of Object.entries(registry)) {
  if (entry?.branch === branch) {
    console.log(`preview-${slot.toLowerCase()}/source`);
    process.exit(0);
  }
}
process.exit(1);
NODE
)"
  if [[ -n "$SLOT_SOURCE" && -r "$ENVS_ROOT/$SLOT_SOURCE/deploy/scripts/preview-slots.mjs" ]]; then
    RELEASE_ROOT="$ENVS_ROOT/$SLOT_SOURCE"
  elif [[ -r "$ENVS_ROOT/dev/source/deploy/scripts/preview-slots.mjs" ]]; then
    RELEASE_ROOT="$ENVS_ROOT/dev/source"
  fi
fi

if [[ ! -r "$RELEASE_ROOT/deploy/scripts/preview-slots.mjs" ]]; then
  echo "Cannot read preview slot tooling from $RELEASE_ROOT" >&2
  exit 1
fi

cd "$RELEASE_ROOT"
mapfile -t SLOT_META < <(bash deploy/scripts/preview-slots.sh status | node -e '
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const branch = process.argv[1];
  const registry = JSON.parse(raw).registry;
  for (const slot of ["A", "B", "C", "D", "E"]) {
    const entry = registry[slot];
    if (entry.branch === branch && entry.apk_version_code) {
      console.log(slot);
      return;
    }
  }
});
' "$BRIGHT_OS_BRANCH")
if [[ -n "${SLOT_META[0]:-}" ]]; then
  BASELINE_SOURCE="$ENVS_ROOT/prod/source"
  if [[ -d "$ENVS_ROOT/prod/source" ]]; then
    BASELINE_SOURCE="$ENVS_ROOT/prod/source"
  elif [[ -d "$DEPLOY_REPO/.git" ]]; then
    BASELINE_SOURCE="$DEPLOY_REPO"
  elif [[ -d "$ENVS_ROOT/dev/source" ]]; then
    BASELINE_SOURCE="$ENVS_ROOT/dev/source"
  fi
  if [[ ! -d "$BASELINE_SOURCE" ]]; then
    echo "Cannot rebuild baseline preview APK without source: $BASELINE_SOURCE" >&2
    exit 1
  fi
  cd "$BASELINE_SOURCE"
  export BRIGHT_OS_BRANCH=""
  export BRIGHT_OS_COMMIT=""
  export BRIGHT_OS_ROOT="$BASELINE_SOURCE"
  export BRIGHT_OS_RELEASE_TARGET="$DEPLOY_REPO/deploy/releases"
  export BRIGHT_OS_PROD_WEB_VERSION_JSON="$DEPLOY_REPO/deploy/web/version.json"
  export BRIGHT_OS_ANDROID_VERSION_CODE="$(deploy/scripts/apk-version-code.sh next "released $RELEASE_BRANCH baseline preview ${SLOT_META[0]}")"
  deploy/scripts/build-android-env-apk.sh "preview${SLOT_META[0]}"
  cd "$RELEASE_ROOT"
fi
RELEASE_JSON="$(bash deploy/scripts/preview-slots.sh release "$RELEASE_BRANCH")"
printf '%s\n' "$RELEASE_JSON"
REMOTE
)"
printf '%s\n' "$RELEASE_JSON"
RELEASED="$(printf '%s' "$RELEASE_JSON" | "$NODE_BIN" -e 'let raw = ""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => console.log(JSON.parse(raw).released === true ? "true" : "false"));')"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'released=%s\n' "$RELEASED" >>"$GITHUB_OUTPUT"
fi
if [[ "$REQUIRE_RELEASE" == "true" && "$RELEASED" != "true" ]]; then
  echo "Required preview slot release did not release a slot for $BRIGHT_OS_BRANCH." >&2
  exit 1
fi
