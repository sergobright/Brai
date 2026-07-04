#!/usr/bin/env bash
set -euo pipefail

ROOT="${BRAI_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/permissions.sh"
SOURCE="$ROOT/apps/brai_app/out"
TARGET="${BRAI_WEB_TARGET:-$ROOT/deploy/web}"

if [[ ! -d "$SOURCE" ]]; then
  echo "Missing Next.js static export at $SOURCE" >&2
  exit 1
fi

mkdir -p "$TARGET"
if ! find "$TARGET" -mindepth 1 -maxdepth 1 -exec rm -rf {} +; then
  TARGET_PARENT="$(dirname "$TARGET")"
  STALE_ROOT="${BRAI_WEB_STALE_ROOT:-$(dirname "$TARGET_PARENT")/.stale-web}"
  STALE_TARGET="$STALE_ROOT/$(basename "$TARGET_PARENT").$(basename "$TARGET").$(date -u +%Y%m%d%H%M%S).$$"
  echo "Warning: unable to clean $TARGET; moving stale tree to $STALE_TARGET" >&2
  mkdir -p "$STALE_ROOT"
  mv "$TARGET" "$STALE_TARGET"
  mkdir -p "$TARGET"
fi
cp -R "$SOURCE"/. "$TARGET"/
normalize_public_tree "$TARGET"
