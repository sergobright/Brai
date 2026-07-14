#!/usr/bin/env bash
set -euo pipefail

: "${BRAI_DEPLOY_HOST:?BRAI_DEPLOY_HOST is required}"
: "${BRAI_DEPLOY_USER:?BRAI_DEPLOY_USER is required}"
: "${BRAI_DEPLOY_SSH_KEY:?BRAI_DEPLOY_SSH_KEY is required}"
: "${BRAI_BRANCH:?BRAI_BRANCH is required}"
: "${BRAI_COMMIT:?BRAI_COMMIT is required}"

SSH_PORT="${BRAI_DEPLOY_SSH_PORT:-22}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-goal-agent-deploy-key.XXXXXX")"
cleanup() { rm -f "$KEY_FILE"; }
trap cleanup EXIT
printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

ssh -i "$KEY_FILE" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new \
  "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" \
  bash -s -- "$ENVS_ROOT" "$BRAI_BRANCH" "$BRAI_COMMIT" <<'REMOTE'
set -euo pipefail
ENVS_ROOT="$1"
BRAI_BRANCH="$2"
BRAI_COMMIT="$3"
NODE_PREFIX="${BRAI_NODE_PREFIX:-/srv/opt/node-v22.16.0/bin}"
[[ "$BRAI_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || { echo "Invalid deployment commit" >&2; exit 1; }
[[ "$BRAI_BRANCH" == "main" || "$BRAI_BRANCH" == "dev" || "$BRAI_BRANCH" == codex/* ]] || {
  echo "Unsupported deployment branch" >&2
  exit 1
}
[[ -d "$NODE_PREFIX" ]] && export PATH="$NODE_PREFIX:$PATH"

BRAI_PREVIEW_SLOT=""
case "$BRAI_BRANCH" in
  main) ENV_PATH="prod" ;;
  dev) ENV_PATH="dev" ;;
  codex/*)
    BRAI_PREVIEW_SLOT="$(node - "$ENVS_ROOT/preview-slots.json" "$BRAI_BRANCH" "$BRAI_COMMIT" <<'NODE'
const fs = require("node:fs");
const [registryPath, branch, commit] = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const slot = ["A", "B", "C", "D", "E"].find((key) =>
  registry[key]?.branch === branch && registry[key]?.commit === commit
);
if (!slot) throw new Error(`no exact Preview lease for ${branch}@${commit}`);
process.stdout.write(slot);
NODE
)"
    ENV_PATH="preview-${BRAI_PREVIEW_SLOT,,}"
    ;;
esac

SOURCE_ROOT="$ENVS_ROOT/$ENV_PATH/source"
case "$SOURCE_ROOT" in
  "$ENVS_ROOT"/prod/source|"$ENVS_ROOT"/dev/source|"$ENVS_ROOT"/preview-[a-e]/source) ;;
  *) echo "Unsafe Goal-agent source root: $SOURCE_ROOT" >&2; exit 1 ;;
esac
[[ -x "$SOURCE_ROOT/deploy/scripts/deploy-goal-agents.sh" ]] || {
  echo "Goal-agent deployment helper is missing from $SOURCE_ROOT" >&2
  exit 1
}

BRAI_ROOT="$SOURCE_ROOT" \
BRAI_ENVS_ROOT="$ENVS_ROOT" \
BRAI_BRANCH="$BRAI_BRANCH" \
BRAI_COMMIT="$BRAI_COMMIT" \
BRAI_PREVIEW_SLOT="$BRAI_PREVIEW_SLOT" \
  "$SOURCE_ROOT/deploy/scripts/deploy-goal-agents.sh"
REMOTE
