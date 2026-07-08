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
  "$NODE_BIN" "$SCRIPT_DIR/record-runtime-log.mjs" \
    --source deploy \
    --operation accepted_branch.cleanup \
    --status skipped \
    --severity WARN \
    --reason active_preview_inspection_failed \
    --message "Skipped accepted branch cleanup because active previews could not be inspected" \
    --json "{}" >/dev/null 2>&1 || true
  echo "Warning: could not inspect active preview branches; skipping accepted branch cleanup." >&2
  exit 0
fi

mapfile -t CLEANUP_BRANCHES < <(
  BRAI_ACTIVE_PREVIEW_BRANCHES_JSON="$ACTIVE_BRANCHES_JSON" "$NODE_BIN" "$SCRIPT_DIR/cleanup-accepted-branches.mjs" "$@"
)

if [[ "${#CLEANUP_BRANCHES[@]}" -eq 0 ]]; then
  "$NODE_BIN" "$SCRIPT_DIR/record-runtime-log.mjs" \
    --source deploy \
    --operation accepted_branch.cleanup \
    --status skipped \
    --reason no_eligible_branches \
    --message "No accepted branches eligible for cleanup" \
    --json "{}" >/dev/null 2>&1 || true
  echo "No accepted branches eligible for cleanup."
  exit 0
fi

cleanup_json="{}"
cleanup_json="$("$NODE_BIN" -e 'const branches = process.argv.slice(1); console.log(JSON.stringify({ branch_count: branches.length, branches }));' "${CLEANUP_BRANCHES[@]}")" || cleanup_json="{}"
if ! "$SCRIPT_DIR/ci-ssh-prune-accepted-branches.sh" "${CLEANUP_BRANCHES[@]}"; then
  "$NODE_BIN" "$SCRIPT_DIR/record-runtime-log.mjs" \
    --source deploy \
    --operation accepted_branch.cleanup \
    --status failed \
    --severity WARN \
    --reason local_cleanup_failed \
    --message "Accepted branch cleanup failed after remote cleanup" \
    --json "$cleanup_json" >/dev/null 2>&1 || true
  echo "Warning: local accepted worktree cleanup failed; remote branch cleanup already completed where possible." >&2
else
  "$NODE_BIN" "$SCRIPT_DIR/record-runtime-log.mjs" \
    --source deploy \
    --operation accepted_branch.cleanup \
    --status done \
    --message "Accepted branches cleaned up" \
    --json "$cleanup_json" >/dev/null 2>&1 || true
fi
