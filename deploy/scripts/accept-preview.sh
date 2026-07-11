#!/usr/bin/env bash
set -euo pipefail

BASE_BRANCH="${BRAI_ACCEPT_BASE:-main}"
MODE="accept"
if [[ "${1:-}" == "--cancel" ]]; then
  MODE="cancel"
  shift
fi
BRANCH="${1:-}"
INFRA_DOCS_LABEL="brai-delivery:infra-docs"
TECHNICAL_NO_PREVIEW_LABEL="brai-delivery:technical-no-preview"
MERGE_METHOD="${BRAI_ACCEPT_MERGE_METHOD:-squash}"

usage() {
  cat <<'USAGE'
usage: deploy/scripts/accept-preview.sh [--cancel] [codex/<task-branch>]

Creates or reuses a GitHub PR from a Brai preview branch into the accepted base, then
enables GitHub merge/auto-merge for the exact pushed head commit.

With --cancel, disables auto-merge for the branch's open acceptance PR and records an
idempotent local cancellation receipt.
USAGE
}

if [[ "$BRANCH" == "-h" || "$BRANCH" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git branch --show-current)"
fi

if [[ "$BRANCH" != codex/* ]]; then
  echo "Acceptance requires a codex/* preview branch, got: ${BRANCH:-<empty>}" >&2
  exit 1
fi

case "$MERGE_METHOD" in
  merge | squash | rebase) ;;
  *)
    echo "Unsupported merge method: $MERGE_METHOD" >&2
    exit 1
    ;;
esac

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI is required: gh" >&2
  exit 1
fi

CALL_ROOT="$(git rev-parse --show-toplevel)"

find_acceptance_root() {
  if [[ "${BRAI_ACCEPT_ALLOW_DETACHED_ROOT:-false}" == "true" ]]; then
    echo "$CALL_ROOT"
    return
  fi

  local current_branch
  current_branch="$(git -C "$CALL_ROOT" branch --show-current)"
  if [[ "$current_branch" == "$BRANCH" ]]; then
    echo "$CALL_ROOT"
    return
  fi

  local path=""
  local line
  while IFS= read -r line; do
    if [[ "$line" == worktree\ * ]]; then
      path="${line#worktree }"
      continue
    fi
    if [[ "$line" == branch\ refs/heads/* && "${line#branch refs/heads/}" == "$BRANCH" ]]; then
      echo "$path"
      return
    fi
  done < <(git -C "$CALL_ROOT" worktree list --porcelain)

  echo "Cannot find local worktree for $BRANCH. Run accept-preview from that task worktree or keep the official task worktree available." >&2
  exit 1
}

ROOT="$(find_acceptance_root)"
cd "$ROOT"

run_brai_node() {
  local node_prefix="${BRAI_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
  if [[ -x "$node_prefix/node" ]]; then
    "$ROOT/scripts/use-node22.sh" node "$@"
    return
  fi
  node "$ROOT/scripts/require-node22.mjs"
  node "$@"
}

ensure_acceptance_marker_writable() {
  local dir="$ROOT/.brai-task"
  local probe
  if [[ -L "$dir" ]]; then
    echo "Brai task state must not be a symlink: $dir" >&2
    exit 1
  fi
  if ! mkdir -p "$dir"; then
    echo "Cannot create Brai task state directory: $dir" >&2
    exit 1
  fi
  if ! probe="$(mktemp "$dir/.acceptance-write.XXXXXX")"; then
    echo "Cannot write Brai acceptance receipt under $dir; repair task-state permissions before accepting preview work." >&2
    exit 1
  fi
  rm -f "$probe"
}

write_acceptance_marker() {
  local status="$1"
  local pr_number="${2:-}"
  local pr_url="${3:-}"
  local accepted_at
  accepted_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  run_brai_node -e '
const fs = require("node:fs");
const path = require("node:path");
const [root, branch, commit, baseBranch, prNumber, prUrl, mergeMethod, status, deliveryClass, acceptedAt] = process.argv.slice(1);
const dir = path.join(root, ".brai-task");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "acceptance.json"), `${JSON.stringify({
  receiptType: "brai-acceptance-v1",
  branch,
  commit,
  baseBranch,
  prNumber: prNumber || null,
  prUrl: prUrl || null,
  mergeMethod,
  status,
  deliveryClass: deliveryClass || null,
  acceptedAt,
}, null, 2)}\n`);
' "$ROOT" "$BRANCH" "$HEAD_SHA" "$BASE_BRANCH" "$pr_number" "$pr_url" "$MERGE_METHOD" "$status" "${DELIVERY_CLASS:-}" "$accepted_at"
}

is_no_preview_delivery() {
  [[ "${REQUIRES_PREVIEW:-}" == "false" && ( "${DELIVERY_CLASS:-}" == "infra-docs" || "${DELIVERY_CLASS:-}" == "technical-no-preview" ) ]]
}

delivery_label() {
  case "${DELIVERY_CLASS:-}" in
    infra-docs) echo "$INFRA_DOCS_LABEL" ;;
    technical-no-preview) echo "$TECHNICAL_NO_PREVIEW_LABEL" ;;
    *) echo "" ;;
  esac
}

build_acceptance_pr_body() {
  if is_no_preview_delivery; then
    cat <<BODY
Accepted no-preview branch ${BRANCH}.

Delivery class: ${DELIVERY_CLASS}.

This PR was opened by deploy/scripts/accept-preview.sh after CI classified the branch as not requiring a browser preview.
BODY
    return
  fi
  run_brai_node -e '
const fs = require("node:fs");
const path = require("node:path");
const [root, branch, commit] = process.argv.slice(1);
const receiptPath = path.join(root, ".brai-task", "preview-handoff.json");
const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
if (receipt.branch !== branch || receipt.commit !== commit) {
  throw new Error(`Preview receipt mismatch for ${branch}@${commit}`);
}
const notes = receipt.releaseNotes || {};
for (const field of ["short_changes", "detailed_changes", "reason"]) {
  const text = String(notes[field] || "").trim();
  if (!text) throw new Error(`Preview release notes missing ${field}`);
  if (!/[А-Яа-яЁё]/.test(text)) throw new Error(`Preview release notes ${field} must be Russian`);
}
const payload = JSON.stringify({
  receiptType: "brai-release-notes-v1",
  short_changes: notes.short_changes.trim(),
  detailed_changes: notes.detailed_changes.trim(),
  reason: notes.reason.trim(),
});
console.log(`Accepted preview branch ${branch}.

Release notes:
- Short: ${notes.short_changes.trim()}
- Details: ${notes.detailed_changes.trim()}
- Reason: ${notes.reason.trim()}

<!-- brai-release-notes-v1
${payload}
-->`);
' "$ROOT" "$BRANCH" "$HEAD_SHA"
}

mark_reconcile_required() {
  local pr_number="$1"
  local pr_url="$2"
  local merge_state="$3"
  write_acceptance_marker "reconcile_required" "$pr_number" "$pr_url"
  echo "Acceptance requires same-branch reconcile for $BRANCH -> $BASE_BRANCH"
  echo "PR: $pr_url"
  echo "Head: $HEAD_SHA"
  echo "mergeStateStatus: $merge_state"
  echo "Run: node scripts/brai-task.mjs acceptance-reconcile $BRANCH"
}

cancel_acceptance() {
  local pr_number pr_url
  pr_number="$(gh pr list --base "$BASE_BRANCH" --head "$BRANCH" --state open --json number --jq ".[0].number // \"\"")"
  if [[ -z "$pr_number" ]]; then
    echo "No open acceptance PR for $BRANCH; acceptance is already absent."
    write_acceptance_marker "cancelled"
    return
  fi
  pr_url="$(gh pr view "$pr_number" --json url --jq ".url")"
  gh pr merge "$pr_number" --disable-auto >/dev/null 2>&1 || true
  write_acceptance_marker "cancelled" "$pr_number" "$pr_url"
  echo "Acceptance cancelled for $BRANCH"
  echo "PR: $pr_url"
}

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree must be clean before accepting preview work." >&2
  exit 1
fi

ensure_acceptance_marker_writable

git fetch origin "$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH" "$BRANCH:refs/remotes/origin/$BRANCH"
HEAD_SHA="$(git rev-parse "origin/$BRANCH")"

if [[ "$MODE" == "cancel" ]]; then
  cancel_acceptance
  exit 0
fi

if git merge-base --is-ancestor "$HEAD_SHA" "origin/$BASE_BRANCH"; then
  echo "Preview branch already accepted: $HEAD_SHA is included in origin/$BASE_BRANCH"
  write_acceptance_marker "already_in_base"
  exit 0
fi

DELIVERY_CLASS=""
REQUIRES_PREVIEW=""
while IFS='=' read -r key value; do
  case "$key" in
    delivery_class) DELIVERY_CLASS="$value" ;;
    requires_preview) REQUIRES_PREVIEW="$value" ;;
  esac
done < <(run_brai_node "$ROOT/deploy/scripts/classify-delivery.mjs" \
  --base-ref "origin/$BASE_BRANCH" \
  --head-ref "origin/$BRANCH" \
  --event-name push \
  --ref "refs/heads/$BRANCH")

if [[ "${BRAI_ACCEPT_INFRA_DOCS_ONLY:-false}" == "true" && "$DELIVERY_CLASS" != "infra-docs" ]]; then
  echo "Expected infra-docs delivery branch, got: $DELIVERY_CLASS" >&2
  exit 1
fi

if [[ "${BRAI_ACCEPT_NO_PREVIEW_ONLY:-false}" == "true" ]] && ! is_no_preview_delivery; then
  echo "Expected no-preview delivery branch, got: $DELIVERY_CLASS" >&2
  exit 1
fi

if [[ "$REQUIRES_PREVIEW" == "true" ]]; then
  run_brai_node "$ROOT/scripts/brai-task.mjs" require-preview "$BRANCH" "$HEAD_SHA"
fi

MERGED_PR_NUMBER="$(gh pr list --base "$BASE_BRANCH" --head "$BRANCH" --state merged --json number,headRefOid --jq "map(select(.headRefOid == \"$HEAD_SHA\"))[0].number // \"\"")"
if [[ -n "$MERGED_PR_NUMBER" ]]; then
  MERGED_PR_URL="$(gh pr view "$MERGED_PR_NUMBER" --json url --jq ".url")"
  echo "Preview branch already accepted: $MERGED_PR_URL"
  write_acceptance_marker "merged" "$MERGED_PR_NUMBER" "$MERGED_PR_URL"
  exit 0
fi

PR_NUMBER="$(gh pr list --base "$BASE_BRANCH" --head "$BRANCH" --state open --json number --jq ".[0].number // \"\"")"
PR_BODY="$(build_acceptance_pr_body)"

if [[ -z "$PR_NUMBER" ]]; then
  if is_no_preview_delivery; then
    PR_TITLE="Accept no-preview ${BRANCH#codex/}"
  else
    PR_TITLE="Accept ${BRANCH#codex/}"
  fi
  gh pr create --base "$BASE_BRANCH" --head "$BRANCH" --title "$PR_TITLE" --body "$PR_BODY" >/dev/null
  PR_NUMBER="$(gh pr view "$BRANCH" --json number --jq ".number")"
else
  gh pr edit "$PR_NUMBER" --body "$PR_BODY" >/dev/null
fi

NO_PREVIEW_LABEL="$(delivery_label)"
if [[ -n "$NO_PREVIEW_LABEL" ]]; then
  gh label create "$NO_PREVIEW_LABEL" --color "6f42c1" --description "Delivery path without browser preview" --force >/dev/null
  gh pr edit "$PR_NUMBER" --add-label "$NO_PREVIEW_LABEL" >/dev/null
fi

PR_STATE="$(gh pr view "$PR_NUMBER" --json state --jq ".state")"
PR_BASE="$(gh pr view "$PR_NUMBER" --json baseRefName --jq ".baseRefName")"
PR_HEAD="$(gh pr view "$PR_NUMBER" --json headRefOid --jq ".headRefOid")"
PR_URL="$(gh pr view "$PR_NUMBER" --json url --jq ".url")"

if [[ "$PR_BASE" != "$BASE_BRANCH" ]]; then
  echo "PR #$PR_NUMBER targets $PR_BASE, expected $BASE_BRANCH: $PR_URL" >&2
  exit 1
fi

if [[ "$PR_STATE" == "MERGED" ]]; then
  echo "Preview branch already accepted: $PR_URL"
  write_acceptance_marker "merged" "$PR_NUMBER" "$PR_URL"
  exit 0
fi

if [[ "$PR_STATE" != "OPEN" ]]; then
  echo "PR #$PR_NUMBER is $PR_STATE and cannot be accepted: $PR_URL" >&2
  exit 1
fi

if [[ "$PR_HEAD" != "$HEAD_SHA" ]]; then
  echo "PR head mismatch for $BRANCH: PR has $PR_HEAD, origin has $HEAD_SHA" >&2
  exit 1
fi

PR_MERGE_STATE="$(gh pr view "$PR_NUMBER" --json mergeStateStatus --jq ".mergeStateStatus // \"\"")"
if [[ "$PR_MERGE_STATE" == "DIRTY" || "$PR_MERGE_STATE" == "BEHIND" ]]; then
  mark_reconcile_required "$PR_NUMBER" "$PR_URL" "$PR_MERGE_STATE"
  exit 2
fi

if ! gh pr merge "$PR_NUMBER" "--$MERGE_METHOD" --auto --match-head-commit "$HEAD_SHA"; then
  PR_MERGE_STATE="$(gh pr view "$PR_NUMBER" --json mergeStateStatus --jq ".mergeStateStatus // \"\"")"
  if [[ "$PR_MERGE_STATE" == "DIRTY" || "$PR_MERGE_STATE" == "BEHIND" ]]; then
    mark_reconcile_required "$PR_NUMBER" "$PR_URL" "$PR_MERGE_STATE"
    exit 2
  fi
  exit 1
fi
write_acceptance_marker "acceptance_started" "$PR_NUMBER" "$PR_URL"

echo "Acceptance started for $BRANCH -> $BASE_BRANCH"
echo "PR: $PR_URL"
echo "Head: $HEAD_SHA"
echo "Merge method: $MERGE_METHOD"
