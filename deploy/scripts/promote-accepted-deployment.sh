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
elif [[ "$TARGET_ENVIRONMENT" == "prod" ]]; then
  SOURCE_DB="$ENVS_ROOT/dev/data/bright_os.sqlite"
  TARGET_DB="${BRIGHT_OS_DB:-$ROOT/data/bright_os.sqlite}"
  TARGET_DOMAIN="app.brightos.world"
else
  echo "Unsupported target environment: $TARGET_ENVIRONMENT" >&2
  exit 1
fi

"$NODE_BIN" "$SCRIPT_DIR/promote-deployment.mjs" \
  --source-db "$SOURCE_DB" \
  --target-db "$TARGET_DB" \
  --source-branch "$SOURCE_BRANCH" \
  --target-environment "$TARGET_ENVIRONMENT" \
  --target-branch "$TARGET_BRANCH" \
  --target-commit "$TARGET_COMMIT" \
  --target-domain "$TARGET_DOMAIN" \
  --accepted-pr-number "${BRIGHT_OS_ACCEPTED_PR_NUMBER:-}" \
  --reason "${BRIGHT_OS_PROMOTE_REASON:-Accepted branch promotion}"
