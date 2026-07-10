#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
EXPLICIT_BRANCH=false
for arg in "$@"; do
  if [[ "$arg" == "--branch" ]]; then
    EXPLICIT_BRANCH=true
  fi
done

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
    --status failed \
    --severity WARN \
    --reason active_preview_inspection_failed \
    --message "Accepted branch cleanup failed because active previews could not be inspected" \
    --json "{}" >/dev/null 2>&1 || true
  echo "Could not inspect active preview branches; accepted branch cleanup cannot continue safely." >&2
  exit 1
fi

CLEANUP_BRANCH_LIST="$(
  BRAI_ACTIVE_PREVIEW_BRANCHES_JSON="$ACTIVE_BRANCHES_JSON" "$NODE_BIN" "$SCRIPT_DIR/cleanup-accepted-branches.mjs" --dry-run "$@"
)"
CLEANUP_BRANCHES=()
while IFS= read -r branch; do
  [[ -n "$branch" ]] && CLEANUP_BRANCHES+=("$branch")
done <<<"$CLEANUP_BRANCH_LIST"

if [[ "${#CLEANUP_BRANCHES[@]}" -eq 0 ]]; then
  if [[ "$EXPLICIT_BRANCH" == "true" ]]; then
    echo "Explicit accepted branch cleanup found no merged candidate; retry after GitHub merge state is consistent." >&2
    exit 1
  fi
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
for branch in "${CLEANUP_BRANCHES[@]}"; do
  BRAI_BRANCH="$branch" BRAI_ACCEPTED_PREVIEW=true "$SCRIPT_DIR/ci-ssh-release-slot.sh" >/dev/null
done

DELETE_ARGS=()
for branch in "${CLEANUP_BRANCHES[@]}"; do
  DELETE_ARGS+=(--branch "$branch")
done
BRAI_ACTIVE_PREVIEW_BRANCHES_JSON="$ACTIVE_BRANCHES_JSON" "$NODE_BIN" "$SCRIPT_DIR/cleanup-accepted-branches.mjs" "${DELETE_ARGS[@]}" >/dev/null

if ! "$SCRIPT_DIR/ci-ssh-prune-accepted-branches.sh" "${CLEANUP_BRANCHES[@]}"; then
  "$NODE_BIN" "$SCRIPT_DIR/record-runtime-log.mjs" \
    --source deploy \
    --operation accepted_branch.cleanup \
    --status failed \
    --severity WARN \
    --reason local_cleanup_failed \
    --message "Accepted branch cleanup failed after remote cleanup" \
    --json "$cleanup_json" >/dev/null 2>&1 || true
  echo "Local accepted worktree cleanup failed after database and remote branch cleanup." >&2
  exit 1
else
  "$NODE_BIN" "$SCRIPT_DIR/record-runtime-log.mjs" \
    --source deploy \
    --operation accepted_branch.cleanup \
    --status done \
    --message "Accepted branches cleaned up" \
    --json "$cleanup_json" >/dev/null 2>&1 || true
fi
