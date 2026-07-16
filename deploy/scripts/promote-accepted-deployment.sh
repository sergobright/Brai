#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
SOURCE_BRANCH="${BRAI_SOURCE_BRANCH:?BRAI_SOURCE_BRANCH is required}"
TARGET_ENVIRONMENT="${BRAI_TARGET_ENVIRONMENT:?BRAI_TARGET_ENVIRONMENT is required}"
TARGET_BRANCH="${BRAI_TARGET_BRANCH:?BRAI_TARGET_BRANCH is required}"
TARGET_COMMIT="${BRAI_TARGET_COMMIT:?BRAI_TARGET_COMMIT is required}"
VERSION_WORK_JSON="${BRAI_VERSION_WORK_JSON:-}"
if [[ -z "$VERSION_WORK_JSON" ]]; then
  SOURCE_SHORT_CHANGES="${BRAI_SOURCE_SHORT_CHANGES:?BRAI_SOURCE_SHORT_CHANGES is required}"
  SOURCE_DETAILS="${BRAI_SOURCE_DETAILED_CHANGES:?BRAI_SOURCE_DETAILED_CHANGES is required}"
  SOURCE_REASON="${BRAI_SOURCE_REASON:?BRAI_SOURCE_REASON is required}"
fi
TARGET_POSTGRES_URL="${BRAI_DATABASE_URL:-}"
: "${TARGET_POSTGRES_URL:?BRAI_DATABASE_URL is required for accepted promotion}"

if [[ -n "$VERSION_WORK_JSON" ]]; then
  BRAI_DATABASE_URL="$TARGET_POSTGRES_URL" "$NODE_BIN" "$SCRIPT_DIR/promote-deployment.mjs" \
    --source-branch "$SOURCE_BRANCH" \
    --target-environment "$TARGET_ENVIRONMENT" \
    --target-branch "$TARGET_BRANCH" \
    --target-commit "$TARGET_COMMIT" \
    --ledger-only true \
    --work-json "$VERSION_WORK_JSON"
  mapfile -t APK_META < <(BRAI_VERSION_WORK_JSON="$VERSION_WORK_JSON" "$NODE_BIN" -e '
const payload = JSON.parse(process.env.BRAI_VERSION_WORK_JSON);
const hasApk = payload.pulls?.some((pull) => pull.releaseNotes?.platforms?.apk);
if (hasApk) {
  const fs = require("node:fs");
  const path = require("node:path");
  const releaseRoot = process.env.BRAI_RELEASE_TARGET;
  if (!releaseRoot) throw new Error("BRAI_RELEASE_TARGET is required for APK work reconciliation");
  const release = JSON.parse(fs.readFileSync(path.join(releaseRoot, "releases.json"), "utf8")).sections?.production;
  if (!release?.apkVersion || !release?.versionCode || !release?.publishedAt) throw new Error("published production APK metadata is incomplete");
  console.log(payload.work.key);
  console.log(release.apkVersion);
  console.log(release.versionCode);
  console.log(release.publishedAt);
}
')
  if [[ "${#APK_META[@]}" -gt 0 ]]; then
    [[ "${#APK_META[@]}" -eq 4 ]] || { echo "Invalid published APK reconciliation metadata" >&2; exit 1; }
    BRAI_DATABASE_URL="$TARGET_POSTGRES_URL" "$NODE_BIN" "$SCRIPT_DIR/record-shipped-apk-version.mjs" \
      --work-key "${APK_META[0]}" \
      --version "${APK_META[1]}" \
      --version-code "${APK_META[2]}" \
      --target-branch "$TARGET_BRANCH" \
      --target-commit "$TARGET_COMMIT" \
      --released-at "${APK_META[3]}"
  fi
  exit 0
fi

accepted_build_recorded() {
  [[ -r "$ROOT/services/brai_api/package.json" ]] || return 1
  "$NODE_BIN" --input-type=module - "$ROOT" "$TARGET_POSTGRES_URL" "$SOURCE_BRANCH" "$TARGET_BRANCH" "$TARGET_COMMIT" <<'NODE'
const { createRequire } = await import("node:module");
const [sourceRoot, databaseUrl, sourceBranch, targetBranch, targetCommit] = process.argv.slice(2);
const require = createRequire(`${sourceRoot}/services/brai_api/package.json`);
const { Pool } = require("pg");
const pool = new Pool({ connectionString: databaseUrl, ssl: /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false });
try {
  const result = await pool.query(`
    SELECT 1
    FROM build_version_refs
    WHERE version_type_id = 'build'
      AND source_branch = $1
      AND target_branch = $2
      AND target_commit = $3
    LIMIT 1
  `, [sourceBranch, targetBranch, targetCommit]);
  process.exit(result.rows.length ? 0 : 1);
} finally {
  await pool.end();
}
NODE
}

if [[ "$TARGET_ENVIRONMENT" == "prod" && "$SOURCE_BRANCH" == codex/* ]]; then
  if ! SLOT="$("$NODE_BIN" -e '
const fs = require("node:fs");
const path = process.env.BRAI_PREVIEW_REGISTRY || `${process.env.BRAI_ENVS_ROOT || "/srv/projects/brai-envs"}/preview-slots.json`;
const branch = process.argv[1];
const registry = JSON.parse(fs.readFileSync(path, "utf8"));
for (const slot of ["A", "B", "C", "D", "E"]) if (registry[slot]?.branch === branch) { console.log(slot); process.exit(0); }
process.exit(1);
' "$SOURCE_BRANCH")"; then
    if accepted_build_recorded; then
      echo "Accepted production branch $SOURCE_BRANCH is already promoted for $TARGET_BRANCH@$TARGET_COMMIT; no preview slot remains."
      exit 0
    fi
    echo "No preview slot found for accepted production branch $SOURCE_BRANCH." >&2
    exit 1
  fi
  SOURCE_POSTGRES_URL=""
  if [[ -f "$ENVS_ROOT/preview-${SLOT,,}/brai-api.env" ]]; then
    SOURCE_POSTGRES_URL="$(env -i bash -c 'set -a; . "$1"; printf "%s" "${BRAI_DATABASE_URL:-}"' _ "$ENVS_ROOT/preview-${SLOT,,}/brai-api.env")"
  fi
  : "${SOURCE_POSTGRES_URL:?Preview BRAI_DATABASE_URL is required for accepted promotion}"
  TARGET_DOMAIN="app.brai.one"
  SOURCE_COMMIT="$("$NODE_BIN" -e '
const fs = require("node:fs");
const path = process.env.BRAI_PREVIEW_REGISTRY || `${process.env.BRAI_ENVS_ROOT || "/srv/projects/brai-envs"}/preview-slots.json`;
const slot = process.argv[1];
const registry = JSON.parse(fs.readFileSync(path, "utf8"));
console.log(registry[slot]?.commit || "");
' "$SLOT")"
else
  echo "Unsupported accepted promotion: $SOURCE_BRANCH -> $TARGET_ENVIRONMENT" >&2
  exit 1
fi

BRAI_SOURCE_DATABASE_URL="$SOURCE_POSTGRES_URL" BRAI_DATABASE_URL="$TARGET_POSTGRES_URL" "$NODE_BIN" "$SCRIPT_DIR/promote-deployment.mjs" \
  --source-branch "$SOURCE_BRANCH" \
  --target-environment "$TARGET_ENVIRONMENT" \
  --target-branch "$TARGET_BRANCH" \
  --target-commit "$TARGET_COMMIT" \
  --target-domain "$TARGET_DOMAIN" \
  --source-commit "$SOURCE_COMMIT" \
  --source-slot "${SLOT:-}" \
  --source-short-changes "$SOURCE_SHORT_CHANGES" \
  --source-details "$SOURCE_DETAILS" \
  --source-reason "$SOURCE_REASON" \
  --reason "$SOURCE_REASON" \
  --record-production-release "${BRAI_RECORD_PRODUCTION_RELEASE:-false}"
