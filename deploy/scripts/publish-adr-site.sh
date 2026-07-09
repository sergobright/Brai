#!/usr/bin/env bash
set -euo pipefail

ROOT="${BRAI_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/permissions.sh"

OUT="${BRAI_ADR_BUILD_DIR:-$ROOT/.log4brains/out}"
TARGET="${BRAI_ADR_TARGET:-/srv/projects/brai-envs/prod/adr}"

"$ROOT/scripts/use-node22.sh" npx --no-install log4brains build --out "$OUT"

if [[ ! -d "$OUT" ]]; then
  echo "Missing Log4brains static output at $OUT" >&2
  exit 1
fi

mkdir -p "$TARGET"
if ! find "$TARGET" -mindepth 1 -maxdepth 1 -exec rm -rf {} +; then
  TARGET_PARENT="$(dirname "$TARGET")"
  STALE_ROOT="${BRAI_ADR_STALE_ROOT:-$(dirname "$TARGET_PARENT")/.stale-adr}"
  STALE_TARGET="$STALE_ROOT/$(basename "$TARGET_PARENT").$(basename "$TARGET").$(date -u +%Y%m%d%H%M%S).$$"
  echo "Warning: unable to clean $TARGET; moving stale tree to $STALE_TARGET" >&2
  mkdir -p "$STALE_ROOT"
  mv "$TARGET" "$STALE_TARGET"
  mkdir -p "$TARGET"
fi
cp -R "$OUT"/. "$TARGET"/
normalize_public_tree "$TARGET"
