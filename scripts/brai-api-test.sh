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
fi

exec "$ROOT/scripts/use-node22.sh" npm --prefix "$ROOT/services/brai_api" test -- "$@"
