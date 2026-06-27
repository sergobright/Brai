#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRIGHT_OS_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
TARGET_BRANCH="${BRIGHT_OS_TARGET_BRANCH:-main}"
TARGET_ENVIRONMENT="${BRIGHT_OS_TARGET_ENVIRONMENT:-prod}"
TARGET_COMMIT="${BRIGHT_OS_TARGET_COMMIT:-${GITHUB_SHA:-}}"
MODE="${BRIGHT_OS_ACCEPTED_PREVIEWS_MODE:-all}"

: "${TARGET_COMMIT:?BRIGHT_OS_TARGET_COMMIT or GITHUB_SHA is required}"

case "$MODE" in
  all | promote | release) ;;
  *)
    echo "Unsupported BRIGHT_OS_ACCEPTED_PREVIEWS_MODE: $MODE" >&2
    exit 1
    ;;
esac

signal_temporal_preview() {
  local branch="$1"
  local event="$2"
  if [[ ! -x "$SCRIPT_DIR/ci-temporal-signal.sh" ]]; then
    if [[ "${BRIGHT_TEMPORAL_REQUIRED:-false}" == "true" ]]; then
      echo "deploy/scripts/ci-temporal-signal.sh is required but not executable." >&2
      return 1
    fi
    return 0
  fi

  if [[ "${BRIGHT_TEMPORAL_REQUIRED:-false}" == "true" ]]; then
    "$SCRIPT_DIR/ci-temporal-signal.sh" preview \
      --branch "$branch" \
      --sha "$TARGET_COMMIT" \
      --event "$event" \
      --source complete-accepted-previews
  else
    "$SCRIPT_DIR/ci-temporal-signal.sh" preview \
      --branch "$branch" \
      --sha "$TARGET_COMMIT" \
      --event "$event" \
      --source complete-accepted-previews || true
  fi
}

REQUIRED_BRANCH_LIST="$(
  cd "$ROOT"
  BRIGHT_OS_TARGET_BRANCH="$TARGET_BRANCH" "$NODE_BIN" "$SCRIPT_DIR/accepted-preview-branches.mjs" "$TARGET_COMMIT"
)"
CLEANUP_BRANCH_LIST="$(
  cd "$ROOT"
  BRIGHT_OS_TARGET_BRANCH="$TARGET_BRANCH" "$NODE_BIN" "$SCRIPT_DIR/accepted-preview-branches.mjs" --recent-merged
)"

REQUIRED_BRANCHES=()
declare -A SEEN=()
while IFS= read -r branch; do
  if [[ -n "$branch" && -z "${SEEN[$branch]:-}" ]]; then
    REQUIRED_BRANCHES+=("$branch")
    SEEN[$branch]=required
  fi
done <<<"$REQUIRED_BRANCH_LIST"

CLEANUP_BRANCHES=()
while IFS= read -r branch; do
  if [[ -n "$branch" && -z "${SEEN[$branch]:-}" ]]; then
    CLEANUP_BRANCHES+=("$branch")
    SEEN[$branch]=cleanup
  fi
done <<<"$CLEANUP_BRANCH_LIST"

if [[ "${#REQUIRED_BRANCHES[@]}" -eq 0 && "${#CLEANUP_BRANCHES[@]}" -eq 0 ]]; then
  echo "No accepted codex/* preview branches associated with $TARGET_BRANCH@$TARGET_COMMIT."
  exit 0
fi

for index in "${!REQUIRED_BRANCHES[@]}"; do
  branch="${REQUIRED_BRANCHES[$index]}"
  echo "Completing accepted preview $branch -> $TARGET_BRANCH@$TARGET_COMMIT."
  if [[ "$MODE" == "all" || "$MODE" == "promote" ]]; then
    RECORD_PRODUCTION_RELEASE=true
    if [[ "$TARGET_ENVIRONMENT" == "prod" && "$index" -lt "$((${#REQUIRED_BRANCHES[@]} - 1))" ]]; then
      RECORD_PRODUCTION_RELEASE=false
    fi
    signal_temporal_preview "$branch" pr_merged
    signal_temporal_preview "$branch" accepted_preview_started
    if BRIGHT_OS_SOURCE_BRANCH="$branch" \
      BRIGHT_OS_TARGET_ENVIRONMENT="$TARGET_ENVIRONMENT" \
      BRIGHT_OS_TARGET_BRANCH="$TARGET_BRANCH" \
      BRIGHT_OS_TARGET_COMMIT="$TARGET_COMMIT" \
      BRIGHT_OS_RECORD_PRODUCTION_RELEASE="$RECORD_PRODUCTION_RELEASE" \
        "$SCRIPT_DIR/ci-ssh-promote-deployment.sh"; then
      signal_temporal_preview "$branch" accepted_preview_promoted
    else
      signal_temporal_preview "$branch" accepted_preview_failed
      exit 1
    fi
  fi

  if [[ "$MODE" == "all" || "$MODE" == "release" ]]; then
    signal_temporal_preview "$branch" slot_release_started
    if BRIGHT_OS_BRANCH="$branch" \
      BRIGHT_OS_ACCEPTED_PREVIEW=true \
      BRIGHT_OS_REQUIRE_PREVIEW_SLOT_RELEASE=true \
        "$SCRIPT_DIR/ci-ssh-release-slot.sh"; then
      signal_temporal_preview "$branch" slot_released
    else
      signal_temporal_preview "$branch" slot_release_failed
      exit 1
    fi
  fi
done

if [[ "$MODE" == "promote" ]]; then
  exit 0
fi

for branch in "${CLEANUP_BRANCHES[@]}"; do
  echo "Cleaning up previously accepted preview $branch."
  if [[ "$MODE" == "all" ]]; then
    signal_temporal_preview "$branch" accepted_preview_started
    signal_temporal_preview "$branch" accepted_preview_promoted
  fi

  signal_temporal_preview "$branch" slot_release_started
  if BRIGHT_OS_BRANCH="$branch" BRIGHT_OS_ACCEPTED_PREVIEW=true "$SCRIPT_DIR/ci-ssh-release-slot.sh"; then
    signal_temporal_preview "$branch" slot_released
  else
    signal_temporal_preview "$branch" slot_release_failed
    exit 1
  fi
done
