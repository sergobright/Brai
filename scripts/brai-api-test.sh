#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_ENV_FILE="${BRAI_TEST_ENV_FILE:-/etc/brai/brai-test.env}"

if [[ -z "${BRAI_TEST_DATABASE_URL:-}" && -r "$TEST_ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$TEST_ENV_FILE"
  set +a
elif [[ -z "${BRAI_TEST_DATABASE_URL:-}" && "$TEST_ENV_FILE" != *"'"* ]] && command -v sg >/dev/null 2>&1 && sg brai-deploy -c "test -r '$TEST_ENV_FILE'"; then
  set -a
  # shellcheck source=/dev/null
  . <(sg brai-deploy -c "cat '$TEST_ENV_FILE'")
  set +a
fi

export BRAI_PG_POOL_MAX="${BRAI_PG_POOL_MAX:-1}"
export BRAI_TEST_BRANCH="${BRAI_TEST_BRANCH:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-$(git -C "$ROOT" branch --show-current)}}}"
export BRAI_TEST_BRANCH="${BRAI_TEST_BRANCH:-detached}"
export BRAI_TEST_RUN_ID="${BRAI_TEST_RUN_ID:-$(date -u +%Y%m%d%H%M%S)-$$}"

cleanup_test_schemas() {
  "$ROOT/scripts/use-node22.sh" node "$ROOT/deploy/scripts/cleanup-test-schemas.mjs" \
    --branch "$BRAI_TEST_BRANCH" \
    --run "$BRAI_TEST_RUN_ID"
}

finish() {
  local status=$?
  trap - EXIT
  if ! cleanup_test_schemas; then
    echo "API test schema cleanup failed for $BRAI_TEST_BRANCH run $BRAI_TEST_RUN_ID." >&2
    exit 1
  fi
  exit "$status"
}
trap finish EXIT

"$ROOT/scripts/use-node22.sh" npm --prefix "$ROOT/services/brai_api" test -- --test-concurrency=1 "$@"
