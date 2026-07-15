#!/usr/bin/env bash
set -euo pipefail

: "${BRAI_DEPLOY_HOST:?BRAI_DEPLOY_HOST is required}"
: "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
: "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"
: "${BRAI_SOURCE_BRANCH:?BRAI_SOURCE_BRANCH is required}"
: "${BRAI_TARGET_ENVIRONMENT:?BRAI_TARGET_ENVIRONMENT is required}"
: "${BRAI_TARGET_BRANCH:?BRAI_TARGET_BRANCH is required}"
: "${BRAI_TARGET_COMMIT:?BRAI_TARGET_COMMIT is required}"
if [[ -z "${BRAI_VERSION_WORK_JSON:-}" ]]; then
  : "${BRAI_SOURCE_SHORT_CHANGES:?BRAI_SOURCE_SHORT_CHANGES is required}"
  : "${BRAI_SOURCE_DETAILED_CHANGES:?BRAI_SOURCE_DETAILED_CHANGES is required}"
  : "${BRAI_SOURCE_REASON:?BRAI_SOURCE_REASON is required}"
fi

DEPLOY_REPO="${BRAI_DEPLOY_REPO:-/srv/projects/brai}"
SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-deploy-key.XXXXXX")"
cleanup() {
  rm -f "$KEY_FILE"
}
trap cleanup EXIT

printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

SOURCE_SHORT_CHANGES_B64="$(printf '%s' "${BRAI_SOURCE_SHORT_CHANGES:-}" | base64 -w0)"
SOURCE_DETAILED_CHANGES_B64="$(printf '%s' "${BRAI_SOURCE_DETAILED_CHANGES:-}" | base64 -w0)"
SOURCE_REASON_B64="$(printf '%s' "${BRAI_SOURCE_REASON:-}" | base64 -w0)"
VERSION_WORK_B64="$(printf '%s' "${BRAI_VERSION_WORK_JSON:-}" | base64 -w0)"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
  bash -s -- "$DEPLOY_REPO" "$BRAI_SOURCE_BRANCH" "$BRAI_TARGET_ENVIRONMENT" "$BRAI_TARGET_BRANCH" "$BRAI_TARGET_COMMIT" "$SOURCE_SHORT_CHANGES_B64" "$SOURCE_DETAILED_CHANGES_B64" "$SOURCE_REASON_B64" "${BRAI_RECORD_PRODUCTION_RELEASE:-false}" "$VERSION_WORK_B64" <<'REMOTE'
set -euo pipefail
DEPLOY_REPO="$1"
BRAI_SOURCE_BRANCH="$2"
BRAI_TARGET_ENVIRONMENT="$3"
BRAI_TARGET_BRANCH="$4"
BRAI_TARGET_COMMIT="$5"
BRAI_SOURCE_SHORT_CHANGES="$(printf '%s' "$6" | base64 -d)"
BRAI_SOURCE_DETAILED_CHANGES="$(printf '%s' "$7" | base64 -d)"
BRAI_SOURCE_REASON="$(printf '%s' "$8" | base64 -d)"
BRAI_RECORD_PRODUCTION_RELEASE="$9"
BRAI_VERSION_WORK_JSON="$(printf '%s' "${10}" | base64 -d)"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
NODE_PREFIX="${BRAI_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
if [[ -d "$NODE_PREFIX" ]]; then
  export PATH="$NODE_PREFIX:$PATH"
fi
if [[ "$BRAI_TARGET_ENVIRONMENT" == "prod" && -f "/etc/brai/brai-api.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  . /etc/brai/brai-api.env
  set +a
fi

accepted_build_recorded() {
  local source_root="$1"
  [[ -n "${BRAI_DATABASE_URL:-}" ]] || return 1
  [[ -r "$source_root/services/brai_api/package.json" ]] || return 1
  node --input-type=module - "$source_root" "$BRAI_DATABASE_URL" "$BRAI_SOURCE_BRANCH" "$BRAI_TARGET_BRANCH" "$BRAI_TARGET_COMMIT" <<'NODE'
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

RUN_ROOT="$DEPLOY_REPO"
if [[ -n "$BRAI_VERSION_WORK_JSON" ]]; then
  if [[ -r "$ENVS_ROOT/prod/source/services/brai_api/src/store.js" ]]; then
    RUN_ROOT="$ENVS_ROOT/prod/source"
  fi
elif [[ "$BRAI_SOURCE_BRANCH" == codex/* && "$BRAI_TARGET_ENVIRONMENT" == "prod" ]]; then
  if ! SLOT="$(node -e '
const fs = require("node:fs");
const path = process.env.BRAI_PREVIEW_REGISTRY || `${process.env.BRAI_ENVS_ROOT || "/srv/projects/brai-envs"}/preview-slots.json`;
const branch = process.argv[1];
const registry = JSON.parse(fs.readFileSync(path, "utf8"));
for (const slot of ["A", "B", "C", "D", "E"]) {
  if (registry[slot]?.branch === branch) {
    console.log(slot.toLowerCase());
    process.exit(0);
  }
}
process.exit(1);
' "$BRAI_SOURCE_BRANCH")"; then
    CHECK_ROOT="$ENVS_ROOT/prod/source"
    if [[ ! -r "$CHECK_ROOT/services/brai_api/src/store.js" ]]; then
      CHECK_ROOT="$DEPLOY_REPO"
    fi
    if accepted_build_recorded "$CHECK_ROOT"; then
      echo "Accepted production branch $BRAI_SOURCE_BRANCH is already promoted for $BRAI_TARGET_BRANCH@$BRAI_TARGET_COMMIT; no preview slot remains."
      exit 0
    fi
    echo "No preview slot found for accepted production branch $BRAI_SOURCE_BRANCH." >&2
    exit 1
  fi
  RUN_ROOT="$ENVS_ROOT/preview-$SLOT/source"
fi
cd "$RUN_ROOT"
BRAI_SOURCE_BRANCH="$BRAI_SOURCE_BRANCH" \
BRAI_TARGET_ENVIRONMENT="$BRAI_TARGET_ENVIRONMENT" \
BRAI_TARGET_BRANCH="$BRAI_TARGET_BRANCH" \
BRAI_TARGET_COMMIT="$BRAI_TARGET_COMMIT" \
BRAI_SOURCE_SHORT_CHANGES="$BRAI_SOURCE_SHORT_CHANGES" \
BRAI_SOURCE_DETAILED_CHANGES="$BRAI_SOURCE_DETAILED_CHANGES" \
BRAI_SOURCE_REASON="$BRAI_SOURCE_REASON" \
BRAI_VERSION_WORK_JSON="$BRAI_VERSION_WORK_JSON" \
BRAI_RELEASE_TARGET="$DEPLOY_REPO/deploy/releases" \
BRAI_RECORD_PRODUCTION_RELEASE="$BRAI_RECORD_PRODUCTION_RELEASE" \
  deploy/scripts/promote-accepted-deployment.sh
REMOTE
