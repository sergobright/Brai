#!/usr/bin/env bash
set -euo pipefail

PREFIX="${1:-}"
shift || true

case "$PREFIX" in
  .|admin|apps/brai_app|services/brai_api|services/brai_temporal) ;;
  *) echo "usage: scripts/brai-npm-update.sh <.|admin|apps/brai_app|services/brai_api|services/brai_temporal> <package...>" >&2; exit 2 ;;
esac

[[ "$#" -gt 0 ]] || { echo "at least one package is required" >&2; exit 2; }
exec npm --prefix "$PREFIX" install --package-lock-only --ignore-scripts "$@"
