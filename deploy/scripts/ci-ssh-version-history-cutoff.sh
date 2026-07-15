#!/usr/bin/env bash
set -euo pipefail

: "${BRAI_DEPLOY_HOST:?BRAI_DEPLOY_HOST is required}"
: "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
: "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"

SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-cutoff-key.XXXXXX")"
trap 'rm -f "$KEY_FILE"' EXIT
printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" bash -s <<'REMOTE'
set -euo pipefail
set -a
# shellcheck source=/dev/null
. /etc/brai/brai-api.env
set +a
node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
const require = createRequire('/srv/projects/brai/services/brai_api/package.json');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.BRAI_DATABASE_URL, ssl: /supabase\.(?:co|com)|pooler\.supabase\.com/.test(process.env.BRAI_DATABASE_URL) ? { rejectUnauthorized: false } : false });
try {
  const result = await pool.query('SELECT applied_at_utc FROM schema_migrations WHERE version = 67');
  if (result.rowCount !== 1 || !Number.isFinite(Date.parse(result.rows[0].applied_at_utc))) throw new Error('version-history rollout cutoff is unavailable');
  console.log(result.rows[0].applied_at_utc);
} finally {
  await pool.end();
}
NODE
REMOTE
