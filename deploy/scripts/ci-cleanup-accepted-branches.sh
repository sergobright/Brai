#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"

active_preview_branches_json() {
  : "${BRAI_DEPLOY_HOST:?BRAI_DEPLOY_HOST is required}"
  : "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
  : "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"

  local key_file
  key_file="$(mktemp "${TMPDIR:-/tmp}/brai-preview-registry-key.XXXXXX")"
  local ssh_status
  printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$key_file"
  chmod 600 "$key_file"
  set +e
  ssh -i "$key_file" -p "${BRAI_DEPLOY_SSH_PORT:-22}" -o StrictHostKeyChecking=accept-new "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
    bash -s -- "$ENVS_ROOT" "${BRAI_PREVIEW_REGISTRY:-}" <<'REMOTE'
set -euo pipefail
ENVS_ROOT="$1"
REGISTRY="${2:-$ENVS_ROOT/preview-slots.json}"
[[ -f "$REGISTRY" ]] || { printf '[]\n'; exit 0; }
node - "$REGISTRY" <<'NODE'
const fs = require("node:fs");
const registry = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const branches = [];
for (const slot of ["A", "B", "C", "D", "E"]) {
  const entry = registry[slot] || {};
  if (entry.branch && (entry.status || "free") !== "free") branches.push(entry.branch);
}
for (const entry of registry.queue || []) if (entry.branch) branches.push(entry.branch);
console.log(JSON.stringify(branches));
NODE
REMOTE
  ssh_status="$?"
  set -e
  rm -f "$key_file"
  return "$ssh_status"
}

if ! ACTIVE_BRANCHES_JSON="$(active_preview_branches_json)"; then
  echo "Warning: could not inspect active preview branches; skipping accepted branch cleanup." >&2
  exit 0
fi

mapfile -t CLEANUP_BRANCHES < <(
  BRAI_ACTIVE_PREVIEW_BRANCHES_JSON="$ACTIVE_BRANCHES_JSON" "$NODE_BIN" "$SCRIPT_DIR/cleanup-accepted-branches.mjs" "$@"
)

if [[ "${#CLEANUP_BRANCHES[@]}" -eq 0 ]]; then
  echo "No accepted branches eligible for cleanup."
  exit 0
fi

if ! "$SCRIPT_DIR/ci-ssh-prune-accepted-branches.sh" "${CLEANUP_BRANCHES[@]}"; then
  echo "Warning: local accepted worktree cleanup failed; remote branch cleanup already completed where possible." >&2
fi
