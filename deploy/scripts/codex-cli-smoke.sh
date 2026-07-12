#!/usr/bin/env bash
set -euo pipefail

CODEX_BIN="${BRAI_CODEX_BIN:-/srv/opt/codex-cli/bin/codex}"
MODEL="${BRAI_CODEX_MODEL:-gpt-5.4-mini}"
NODE_BIN="${BRAI_NODE_BIN:-/srv/opt/node-v22.16.0/bin/node}"
RUNTIME_HOME="${BRAI_CODEX_HOME:-/srv/opt/codex-runtime/brai}"
export HOME="$RUNTIME_HOME"
export CODEX_HOME="$RUNTIME_HOME"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/brai-codex-smoke.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

"$CODEX_BIN" --version
cat >"$TMP/schema.json" <<'JSON'
{
  "type": "object",
  "properties": { "ok": { "type": "boolean", "const": true } },
  "required": ["ok"],
  "additionalProperties": false
}
JSON

"$CODEX_BIN" exec \
  --ephemeral \
  --ignore-rules \
  --skip-git-repo-check \
  --sandbox read-only \
  --cd "$TMP" \
  --model "$MODEL" \
  --output-schema "$TMP/schema.json" \
  --output-last-message "$TMP/result.json" \
  'Return exactly the JSON object {"ok":true}. Do not use tools.' >/dev/null

"$NODE_BIN" -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (value?.ok !== true || Object.keys(value).length !== 1) process.exit(1);
' "$TMP/result.json"

echo "Codex CLI service smoke passed with $MODEL."
