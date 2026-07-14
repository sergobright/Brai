#!/usr/bin/env bash
set -euo pipefail

: "${BRAI_BRANCH:?BRAI_BRANCH is required}"
: "${BRAI_COMMIT:?BRAI_COMMIT is required}"

GATE_COMMIT="${BRAI_GOAL_AGENT_GATE_COMMIT:-0af2bff5d916f0e224d734cd1d2faffddfd38835}"

[[ "$BRAI_BRANCH" == codex/* ]] || {
  echo "Legacy Goal-agent compatibility is Preview-only." >&2
  exit 1
}
[[ "$BRAI_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || {
  echo "Invalid deployment commit." >&2
  exit 1
}
[[ "$(git rev-parse HEAD)" == "$BRAI_COMMIT" ]] || {
  echo "Legacy Goal-agent compatibility must run from the exact deployment commit." >&2
  exit 1
}

set +e
git merge-base --is-ancestor "$GATE_COMMIT" "$BRAI_COMMIT"
ancestor_status=$?
set -e

case "$ancestor_status" in
  0)
    echo "Goal-agent gate is required for $BRAI_COMMIT, but its deploy helper is missing." >&2
    exit 1
    ;;
  1)
    echo "Goal-agent gate is not applicable: $BRAI_COMMIT predates $GATE_COMMIT."
    ;;
  *)
    echo "Could not verify Goal-agent gate ancestry for $BRAI_COMMIT." >&2
    exit "$ancestor_status"
    ;;
esac
