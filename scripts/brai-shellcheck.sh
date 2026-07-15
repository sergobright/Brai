#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHELLCHECK_BIN="${SHELLCHECK_BIN:-$(command -v shellcheck || true)}"
if [[ -z "$SHELLCHECK_BIN" ]]; then
  echo "ShellCheck is required. Install the pinned workspace tool first." >&2
  exit 1
fi

"$SHELLCHECK_BIN" --severity=warning --shell=bash "$ROOT"/scripts/*.sh "$ROOT"/deploy/scripts/*.sh
