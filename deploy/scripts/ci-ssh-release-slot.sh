#!/usr/bin/env bash
set -euo pipefail

: "${BRAI_DEPLOY_HOST:?BRAI_DEPLOY_HOST is required}"
: "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
: "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"
: "${BRAI_BRANCH:?BRAI_BRANCH is required}"

DEPLOY_REPO="${BRAI_DEPLOY_REPO:-/srv/projects/brai}"
SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
REQUIRE_RELEASE="${BRAI_REQUIRE_PREVIEW_SLOT_RELEASE:-false}"
NODE_BIN="${NODE_BIN:-node}"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-deploy-key.XXXXXX")"
cleanup() {
  rm -f "$KEY_FILE"
}
trap cleanup EXIT

printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

RELEASE_JSON="$(ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
  bash -s -- "$DEPLOY_REPO" "$ENVS_ROOT" "$BRAI_BRANCH" "$REQUIRE_RELEASE" "${BRAI_ACCEPTED_PREVIEW:-false}" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
ENVS_ROOT="$2"
BRAI_BRANCH="$3"
REQUIRE_RELEASE="$4"
BRAI_ACCEPTED_PREVIEW="$5"
RELEASE_BRANCH="$BRAI_BRANCH"
NODE_PREFIX="${BRAI_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ -d "$NODE_PREFIX" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
fi

RELEASE_ROOT=""
REGISTRY="${BRAI_PREVIEW_REGISTRY:-$ENVS_ROOT/preview-slots.json}"
SLOT=""
SLOT_LOWER=""
SUPABASE_PREVIEW_BRANCH=""
if [[ -f "$REGISTRY" ]]; then
  mapfile -t BRANCH_SLOT_META < <(node - "$REGISTRY" "$BRAI_BRANCH" <<'NODE' || true
const fs = require("node:fs");
const [registryPath, branch] = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
for (const [slot, entry] of Object.entries(registry)) {
  if (entry?.branch === branch) {
    console.log(slot);
    console.log(`preview-${slot.toLowerCase()}/source`);
    console.log(entry.supabase_branch_name || "");
    process.exit(0);
  }
}
process.exit(1);
NODE
)
  SLOT="${BRANCH_SLOT_META[0]:-}"
  SLOT_SOURCE="${BRANCH_SLOT_META[1]:-}"
  SUPABASE_PREVIEW_BRANCH="${BRANCH_SLOT_META[2]:-}"
  if [[ -n "$SLOT" ]]; then
    SLOT_LOWER="$(printf '%s' "$SLOT" | tr '[:upper:]' '[:lower:]')"
  fi
  if [[ -n "$SLOT_SOURCE" && -r "$ENVS_ROOT/$SLOT_SOURCE/deploy/scripts/preview-slots.mjs" ]]; then
    RELEASE_ROOT="$ENVS_ROOT/$SLOT_SOURCE"
  fi
fi
if [[ -z "$RELEASE_ROOT" && -r "$ENVS_ROOT/prod/source/deploy/scripts/preview-slots.mjs" ]]; then
  RELEASE_ROOT="$ENVS_ROOT/prod/source"
fi

if [[ -z "$RELEASE_ROOT" || ! -r "$RELEASE_ROOT/deploy/scripts/preview-slots.mjs" ]]; then
  echo "Cannot read preview slot tooling from deploy-owned source under $ENVS_ROOT" >&2
  exit 1
fi

cd "$RELEASE_ROOT"
if [[ -f "/etc/brai/supabase-deploy.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  . /etc/brai/supabase-deploy.env
  set +a
fi
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
' "$BRAI_BRANCH")
if [[ -n "${SLOT_META[0]:-}" ]]; then
  SLOT_LOWER="$(printf '%s' "${SLOT_META[0]}" | tr '[:upper:]' '[:lower:]')"
  if node - "$DEPLOY_REPO/deploy/releases" "$SLOT_LOWER" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [releaseDir, slot] = process.argv.slice(2);
const indexPath = path.join(releaseDir, "releases.json");
if (!fs.existsSync(indexPath)) process.exit(1);
const section = JSON.parse(fs.readFileSync(indexPath, "utf8")).sections?.[slot];
const version = Number(section?.apkVersion);
const expectedFile = Number.isInteger(version) && version > 0 ? `brai-${slot}-v${version}.apk` : "";
if (section?.apkBuildKind === "stable" && section?.file === expectedFile && fs.existsSync(path.join(releaseDir, expectedFile))) {
  process.exit(0);
}
process.exit(1);
NODE
  then
    echo "Stable Preview ${SLOT_META[0]} APK baseline already exists; skipping rebuild." >&2
  else
    BASELINE_SOURCE="$ENVS_ROOT/prod/source"
    if [[ ! -d "$BASELINE_SOURCE" ]]; then
      echo "Cannot rebuild baseline preview APK without source: $BASELINE_SOURCE" >&2
      exit 1
    fi
    cd "$BASELINE_SOURCE"
    export BRAI_BRANCH=""
    export BRAI_COMMIT=""
    export BRAI_ROOT="$BASELINE_SOURCE"
    export BRAI_RELEASE_TARGET="$DEPLOY_REPO/deploy/releases"
    if [[ -f "/etc/brai/brai-api.env" ]]; then
      set -a
      # shellcheck source=/dev/null
      . /etc/brai/brai-api.env
      set +a
      export BRAI_PROD_DATABASE_URL="${BRAI_DATABASE_URL:-}"
    fi
    export BRAI_PROD_WEB_VERSION_JSON="$DEPLOY_REPO/deploy/web/version.json"
    deploy/scripts/build-android-env-apk.sh "preview${SLOT_META[0]}" >&2
    cd "$RELEASE_ROOT"
  fi
fi
stop_preview_unit_if_exists() {
  local unit="$1"
  command -v systemctl >/dev/null 2>&1 || return 0
  if "${BRAI_SUDO:-sudo}" systemctl cat "$unit" >/dev/null 2>&1; then
    "${BRAI_SUDO:-sudo}" systemctl stop "$unit" >&2
    "${BRAI_SUDO:-sudo}" systemctl reset-failed "$unit" >&2 || true
  fi
}
cleanup_released_preview_slot_artifacts() {
  [[ -n "$SLOT_LOWER" ]] || return 0
  local slot_root="$ENVS_ROOT/preview-$SLOT_LOWER"
  case "$slot_root" in
    "$ENVS_ROOT"/preview-[a-e]) ;;
    *)
      echo "Refusing preview slot cleanup outside $ENVS_ROOT/preview-[a-e]: $slot_root" >&2
      return 1
      ;;
  esac
  shopt -s nullglob
  rm -rf "$slot_root/source" "$slot_root"/source.previous-* "$slot_root/web" "$slot_root/mobile-update"
  shopt -u nullglob
}
if [[ "$RELEASE_BRANCH" == codex/* ]]; then
  if [[ -n "$SUPABASE_PREVIEW_BRANCH" ]]; then
    node deploy/scripts/supabase-branch.mjs delete-preview --branch "$RELEASE_BRANCH" --name "$SUPABASE_PREVIEW_BRANCH" >&2
  else
    node deploy/scripts/supabase-branch.mjs delete-preview --branch "$RELEASE_BRANCH" >&2
  fi
  node deploy/scripts/cleanup-test-schemas.mjs --branch "$RELEASE_BRANCH" --legacy-before-hours 24 >&2
fi
if [[ -n "$SLOT_LOWER" ]]; then
  stop_preview_unit_if_exists "brai-api-preview-$SLOT_LOWER.service"
  stop_preview_unit_if_exists "brai-admin-preview-$SLOT_LOWER.service"
fi
RELEASE_JSON="$(bash deploy/scripts/preview-slots.sh release "$RELEASE_BRANCH")"
cleanup_released_preview_slot_artifacts
printf '%s\n' "$RELEASE_JSON"
REMOTE
)"
printf '%s\n' "$RELEASE_JSON"
RELEASED="$(printf '%s' "$RELEASE_JSON" | "$NODE_BIN" -e 'let raw = ""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => console.log(JSON.parse(raw).released === true ? "true" : "false"));')"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'released=%s\n' "$RELEASED" >>"$GITHUB_OUTPUT"
fi
if [[ "$REQUIRE_RELEASE" == "true" && "$RELEASED" != "true" ]]; then
  echo "Required preview slot release did not release a slot for $BRAI_BRANCH." >&2
  exit 1
fi
