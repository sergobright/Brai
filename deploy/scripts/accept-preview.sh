#!/usr/bin/env bash
set -euo pipefail

BASE_BRANCH="${BRIGHT_OS_ACCEPT_BASE:-main}"
BRANCH="${1:-}"
INFRA_DOCS_LABEL="bright-delivery:infra-docs"
MERGE_METHOD="${BRIGHT_OS_ACCEPT_MERGE_METHOD:-squash}"

usage() {
  cat <<'USAGE'
usage: deploy/scripts/accept-preview.sh [codex/<task-branch>]

Creates or reuses a GitHub PR from a Bright OS preview branch into the accepted base, then
enables GitHub merge/auto-merge for the exact pushed head commit.
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

ROOT="$(git rev-parse --show-toplevel)"

run_bright_node() {
  local node_prefix="${BRIGHT_OS_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
  if [[ -x "$node_prefix/node" ]]; then
    "$ROOT/scripts/use-node22.sh" node "$@"
    return
  fi
  node "$ROOT/scripts/require-node22.mjs"
  node "$@"
}

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree must be clean before accepting preview work." >&2
  exit 1
fi

git fetch origin "$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH" "$BRANCH:refs/remotes/origin/$BRANCH"
HEAD_SHA="$(git rev-parse "origin/$BRANCH")"

if git merge-base --is-ancestor "$HEAD_SHA" "origin/$BASE_BRANCH"; then
  echo "Preview branch already accepted: $HEAD_SHA is included in origin/$BASE_BRANCH"
  exit 0
fi

DELIVERY_CLASS=""
REQUIRES_PREVIEW=""
while IFS='=' read -r key value; do
  case "$key" in
    delivery_class) DELIVERY_CLASS="$value" ;;
    requires_preview) REQUIRES_PREVIEW="$value" ;;
  esac
done < <(run_bright_node "$ROOT/deploy/scripts/classify-delivery.mjs" \
  --base-ref "origin/$BASE_BRANCH" \
  --head-ref "origin/$BRANCH" \
  --event-name push \
  --ref "refs/heads/$BRANCH")

if [[ "${BRIGHT_OS_ACCEPT_INFRA_DOCS_ONLY:-false}" == "true" && "$DELIVERY_CLASS" != "infra-docs" ]]; then
  echo "Expected infra-docs delivery branch, got: $DELIVERY_CLASS" >&2
  exit 1
fi

if [[ "$REQUIRES_PREVIEW" == "true" ]]; then
  run_bright_node "$ROOT/scripts/bright-task.mjs" require-preview "$BRANCH" "$HEAD_SHA"
fi

MERGED_PR_NUMBER="$(gh pr list --base "$BASE_BRANCH" --head "$BRANCH" --state merged --json number,headRefOid --jq "map(select(.headRefOid == \"$HEAD_SHA\"))[0].number // \"\"")"
if [[ -n "$MERGED_PR_NUMBER" ]]; then
  MERGED_PR_URL="$(gh pr view "$MERGED_PR_NUMBER" --json url --jq ".url")"
  echo "Preview branch already accepted: $MERGED_PR_URL"
  exit 0
fi

PR_NUMBER="$(gh pr list --base "$BASE_BRANCH" --head "$BRANCH" --state open --json number --jq ".[0].number // \"\"")"
if [[ -z "$PR_NUMBER" ]]; then
  if [[ "$DELIVERY_CLASS" == "infra-docs" ]]; then
    PR_TITLE="Accept infra/docs ${BRANCH#codex/}"
    PR_BODY="$(cat <<BODY
Accepted infra/docs branch ${BRANCH}.

This PR was opened by deploy/scripts/accept-preview.sh after CI classified the branch as infra/docs delivery.
BODY
)"
  else
    PR_TITLE="Accept ${BRANCH#codex/}"
    PR_BODY="$(cat <<BODY
Accepted preview branch ${BRANCH}.

This PR was opened by deploy/scripts/accept-preview.sh after the project owner accepted the preview.
BODY
)"
  fi
  gh pr create --base "$BASE_BRANCH" --head "$BRANCH" --title "$PR_TITLE" --body "$PR_BODY" >/dev/null
  PR_NUMBER="$(gh pr view "$BRANCH" --json number --jq ".number")"
fi

if [[ "$DELIVERY_CLASS" == "infra-docs" ]]; then
  gh label create "$INFRA_DOCS_LABEL" --color "6f42c1" --description "Infra/docs delivery path without preview cleanup" --force >/dev/null
  gh pr edit "$PR_NUMBER" --add-label "$INFRA_DOCS_LABEL" >/dev/null
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

gh pr merge "$PR_NUMBER" "--$MERGE_METHOD" --auto --match-head-commit "$HEAD_SHA"

echo "Acceptance started for $BRANCH -> $BASE_BRANCH"
echo "PR: $PR_URL"
echo "Head: $HEAD_SHA"
echo "Merge method: $MERGE_METHOD"
