#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRIGHT_OS_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
ENVS_ROOT="${BRIGHT_OS_ENVS_ROOT:-/srv/projects/bright-os-envs}"
SOURCE_BRANCH="${BRIGHT_OS_SOURCE_BRANCH:?BRIGHT_OS_SOURCE_BRANCH is required}"
TARGET_ENVIRONMENT="${BRIGHT_OS_TARGET_ENVIRONMENT:?BRIGHT_OS_TARGET_ENVIRONMENT is required}"
TARGET_BRANCH="${BRIGHT_OS_TARGET_BRANCH:?BRIGHT_OS_TARGET_BRANCH is required}"
TARGET_COMMIT="${BRIGHT_OS_TARGET_COMMIT:?BRIGHT_OS_TARGET_COMMIT is required}"

if [[ "$TARGET_ENVIRONMENT" == "dev" ]]; then
  if ! SLOT="$("$NODE_BIN" -e '
const fs = require("node:fs");
const path = process.env.BRIGHT_OS_PREVIEW_REGISTRY || `${process.env.BRIGHT_OS_ENVS_ROOT || "/srv/projects/bright-os-envs"}/preview-slots.json`;
const branch = process.argv[1];
const registry = JSON.parse(fs.readFileSync(path, "utf8"));
for (const slot of ["A", "B", "C", "D", "E"]) if (registry[slot]?.branch === branch) { console.log(slot); process.exit(0); }
process.exit(1);
' "$SOURCE_BRANCH")"; then
    echo "No preview slot found for $SOURCE_BRANCH; skipping metadata promotion."
    exit 0
  fi
  SOURCE_DB="$ENVS_ROOT/preview-${SLOT,,}/data/bright_os.sqlite"
  TARGET_DB="$ENVS_ROOT/dev/data/bright_os.sqlite"
  TARGET_DOMAIN="dev.brightos.world"
  SOURCE_COMMIT="$("$NODE_BIN" -e '
const fs = require("node:fs");
const path = process.env.BRIGHT_OS_PREVIEW_REGISTRY || `${process.env.BRIGHT_OS_ENVS_ROOT || "/srv/projects/bright-os-envs"}/preview-slots.json`;
const slot = process.argv[1];
const registry = JSON.parse(fs.readFileSync(path, "utf8"));
console.log(registry[slot]?.commit || "");
' "$SLOT")"
elif [[ "$TARGET_ENVIRONMENT" == "prod" ]]; then
  SOURCE_DB="$ENVS_ROOT/dev/data/bright_os.sqlite"
  TARGET_DB="${BRIGHT_OS_DB:-$ROOT/data/bright_os.sqlite}"
  TARGET_DOMAIN="app.brightos.world"
  SOURCE_COMMIT=""
else
  echo "Unsupported target environment: $TARGET_ENVIRONMENT" >&2
  exit 1
fi

SOURCE_SHORT_CHANGES=""
SOURCE_DETAILS=""
if [[ -n "$SOURCE_COMMIT" ]]; then
  NOTES_COMMIT="$SOURCE_COMMIT"
  for _ in 1 2 3 4 5; do
    SOURCE_SHORT_CHANGES="$(git -C "$ROOT" log -1 --format=%s "$NOTES_COMMIT" 2>/dev/null || true)"
    if [[ "$SOURCE_SHORT_CHANGES" == Merge\ branch\ *\ into\ codex/* || "$SOURCE_SHORT_CHANGES" == Merge\ remote-tracking\ branch\ *\ into\ codex/* ]]; then
      PARENT_COMMIT="$(git -C "$ROOT" rev-parse "$NOTES_COMMIT^1" 2>/dev/null || true)"
      if [[ -n "$PARENT_COMMIT" ]]; then
        NOTES_COMMIT="$PARENT_COMMIT"
        continue
      fi
    fi
    break
  done
  SOURCE_BODY="$(git -C "$ROOT" log -1 --format=%b "$NOTES_COMMIT" 2>/dev/null || true)"
  if [[ "$SOURCE_SHORT_CHANGES" == Merge\ pull\ request* && -n "$SOURCE_BODY" ]]; then
    while IFS= read -r line; do
      if [[ -n "${line//[[:space:]]/}" ]]; then
        SOURCE_SHORT_CHANGES="$line"
      fi
    done <<<"$SOURCE_BODY"
    SOURCE_BODY=""
  fi
  if [[ -n "$SOURCE_BODY" ]]; then
    SOURCE_DETAILS="$SOURCE_SHORT_CHANGES"$'\n\n'"$SOURCE_BODY"
  else
    SOURCE_DETAILS="$SOURCE_SHORT_CHANGES"
  fi
fi

"$NODE_BIN" "$SCRIPT_DIR/promote-deployment.mjs" \
  --source-db "$SOURCE_DB" \
  --target-db "$TARGET_DB" \
  --source-branch "$SOURCE_BRANCH" \
  --target-environment "$TARGET_ENVIRONMENT" \
  --target-branch "$TARGET_BRANCH" \
  --target-commit "$TARGET_COMMIT" \
  --target-domain "$TARGET_DOMAIN" \
  --source-commit "$SOURCE_COMMIT" \
  --source-short-changes "${SOURCE_SHORT_CHANGES:-Accepted preview changes without authored release notes.}" \
  --source-details "${SOURCE_DETAILS:-No authored preview release notes were available; audit metadata is stored separately.}" \
  --reason "${BRIGHT_OS_PROMOTE_REASON:-Accepted branch promotion}"
