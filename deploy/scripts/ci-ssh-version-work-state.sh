#!/usr/bin/env bash
set -euo pipefail

: "${BRAI_DEPLOY_HOST:?BRAI_DEPLOY_HOST is required}"
: "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
: "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"

DEPLOY_REPO="${BRAI_DEPLOY_REPO:-/srv/projects/brai}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
NODE_BIN="${NODE_BIN:-node}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-version-state-key.XXXXXX")"
trap 'rm -f "$KEY_FILE"' EXIT
printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

REMOTE_STATE="$(ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
  bash -s -- "$DEPLOY_REPO" "$ENVS_ROOT" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
ENVS_ROOT="$2"
RUN_ROOT="$ENVS_ROOT/prod/source"
[[ -r "$RUN_ROOT/services/brai_api/src/store.js" ]] || RUN_ROOT="$DEPLOY_REPO"
[[ -r /etc/brai/brai-api.env ]] || { echo "Production API environment is missing" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. /etc/brai/brai-api.env
set +a
cd "$RUN_ROOT"
node --input-type=module <<'NODE'
import { BraiStore } from "./services/brai_api/src/store.js";
const store = new BraiStore(process.env.BRAI_DATABASE_URL || "");
try {
  const latestBuildVersion = Number(store.latestVersion("build")?.version || 0);
  const rows = store.db.prepare(`
    SELECT
      works.work_key,
      works.status,
      EXISTS (
        SELECT 1 FROM build_versions AS versions
        WHERE versions.release_works_id = works.id AND versions.version_type_id = 'build'
      ) AS has_build,
      EXISTS (
        SELECT 1 FROM build_versions AS versions
        WHERE versions.release_works_id = works.id AND versions.version_type_id = 'apk'
      ) AS has_apk,
      pulls.repository,
      pulls.pull_number,
      pulls.body
    FROM release_works AS works
    LEFT JOIN github_pull_requests AS pulls ON pulls.release_works_id = works.id
    WHERE works.status = 'finalized'
    ORDER BY works.work_key, pulls.pull_number
  `).all();
  const works = new Map();
  for (const row of rows) {
    const current = works.get(row.work_key) ?? {
      workKey: row.work_key,
      status: row.status,
      hasBuild: Boolean(row.has_build),
      hasApk: Boolean(row.has_apk),
      nativeBoundary: false,
      pulls: [],
    };
    if (row.repository && row.pull_number) current.pulls.push({ repository: row.repository, pullNumber: row.pull_number });
    const marker = String(row.body ?? "").match(/<!--\s*brai-work-v1\s*([\s\S]*?)\s*-->/);
    if (marker) {
      try {
        current.nativeBoundary ||= Boolean(JSON.parse(marker[1]).nativeBoundary);
      } catch {
        // Accepted-preview receipt validation remains the fail-closed authority for malformed markers.
      }
    }
    works.set(row.work_key, current);
  }
  // Keep the established raw pull receipt transport contract. The local
  // classifier below is the authority that excludes a native work whose APK
  // receipt is still missing, so this unfiltered value is not used to decide
  // whether a work is fully complete.
  const finalizedPulls = store.db.prepare(`
    SELECT pulls.repository, pulls.pull_number
    FROM github_pull_requests AS pulls
    JOIN release_works AS works ON works.id = pulls.release_works_id
    WHERE works.status = 'finalized'
    ORDER BY LOWER(pulls.repository), pulls.pull_number
  `).all().map((row) => ({ repository: row.repository, pullNumber: row.pull_number }));
  console.log(JSON.stringify({ latestBuildVersion, works: [...works.values()], finalizedPulls }));
} finally {
  store.close();
}
NODE
REMOTE
)"

printf '%s' "$REMOTE_STATE" | "$NODE_BIN" "$SCRIPT_DIR/version-work-state.mjs"
