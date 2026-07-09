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

exec "$ROOT/scripts/use-node22.sh" npm --prefix "$ROOT/services/brai_api" test -- --test-concurrency=1 "$@"
