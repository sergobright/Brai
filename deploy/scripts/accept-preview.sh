#!/usr/bin/env bash
set -euo pipefail

BASE_BRANCH="${BRIGHT_OS_ACCEPT_BASE:-dev}"
BRANCH="${1:-}"

usage() {
  cat <<'USAGE'
usage: deploy/scripts/accept-preview.sh [codex/<task-branch>]

Creates or reuses a GitHub PR from a Bright OS preview branch into dev, then
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

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI is required: gh" >&2
  exit 1
fi

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

PR_NUMBER="$(gh pr list --base "$BASE_BRANCH" --head "$BRANCH" --state open --json number --jq ".[0].number // \"\"")"
if [[ -z "$PR_NUMBER" ]]; then
  PR_TITLE="Accept ${BRANCH#codex/}"
  PR_BODY="$(cat <<BODY
Accepted preview branch ${BRANCH}.

This PR was opened by deploy/scripts/accept-preview.sh after the project owner accepted the preview.
BODY
)"
  gh pr create --base "$BASE_BRANCH" --head "$BRANCH" --title "$PR_TITLE" --body "$PR_BODY" >/dev/null
  PR_NUMBER="$(gh pr view "$BRANCH" --json number --jq ".number")"
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

gh pr merge "$PR_NUMBER" --merge --auto --match-head-commit "$HEAD_SHA"

echo "Acceptance started for $BRANCH -> $BASE_BRANCH"
echo "PR: $PR_URL"
echo "Head: $HEAD_SHA"
