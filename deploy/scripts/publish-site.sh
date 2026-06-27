#!/usr/bin/env bash
set -euo pipefail

ROOT="${BRIGHT_OS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SOURCE="$ROOT/apps/bright_os_site/public"
TARGET="${BRIGHT_OS_SITE_TARGET:-$ROOT/deploy/site}"
LOGO_SOURCE="$ROOT/assets/brand/bright-os-logo-source.png"

if [[ ! -d "$SOURCE" ]]; then
  echo "Missing Bright OS site source at $SOURCE" >&2
  exit 1
fi

if [[ ! -f "$LOGO_SOURCE" ]]; then
  echo "Missing Bright OS logo at $LOGO_SOURCE" >&2
  exit 1
fi

mkdir -p "$TARGET"
find "$TARGET" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R "$SOURCE"/. "$TARGET"/
cp "$LOGO_SOURCE" "$TARGET/bright-os-logo.png"
if [[ -O "$TARGET" ]]; then
  chmod -R u=rwX,go=rX "$TARGET"
fi
