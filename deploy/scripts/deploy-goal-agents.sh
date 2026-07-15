#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BRAI_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
BRANCH="${BRAI_BRANCH:?BRAI_BRANCH is required}"
COMMIT="${BRAI_COMMIT:?BRAI_COMMIT is required}"
GOAL_AGENT_USER="${BRAI_GOAL_AGENT_USER:-brai-goal-agent}"
GOAL_AGENT_RUNTIME_PREPARE="/srv/opt/brai-goal-agent-runtime-prepare.sh"
GOAL_AGENT_IDS=(
  activity.classifier
  goal.item-matcher
  goal.member-finder
  goal.discovery
  goal.planner
)

mapfile -t DEPLOY_META < <("$NODE_BIN" "$SCRIPT_DIR/resolve-deploy-env.mjs" "$BRANCH")
ENVIRONMENT="${DEPLOY_META[0]}"
ENV_PATH="${DEPLOY_META[3]}"
SERVICE_NAME="${DEPLOY_META[4]}"
EXPECTED_ROOT="$ENVS_ROOT/$ENV_PATH/source"
[[ "$ROOT" == "$EXPECTED_ROOT" ]] || {
  echo "Goal-agent gate source mismatch: expected $EXPECTED_ROOT, got $ROOT" >&2
  exit 1
}
[[ -x "$GOAL_AGENT_RUNTIME_PREPARE" ]] || {
  echo "Goal-agent runtime preparation helper is missing; apply deploy/ansible/brai.yml." >&2
  exit 1
}
"${BRAI_SUDO:-sudo}" "$GOAL_AGENT_RUNTIME_PREPARE"
"$SCRIPT_DIR/goal-agent-infrastructure-preflight.sh" "$ENVIRONMENT"

exec 8>"$ENVS_ROOT/.deploy-$ENV_PATH.lock"
flock 8
SOURCE_OPERATION_LOCK="$ENVS_ROOT/$ENV_PATH/.source-operation.lock"
[[ -f "$SOURCE_OPERATION_LOCK" && ! -L "$SOURCE_OPERATION_LOCK" ]] || {
  echo "Goal-agent gate source-operation lock is missing or unsafe: $SOURCE_OPERATION_LOCK" >&2
  exit 1
}
exec 9<>"$SOURCE_OPERATION_LOCK"
flock 9

[[ -r "$ROOT/.brai-deploy-commit" && "$(<"$ROOT/.brai-deploy-commit")" == "$COMMIT" ]] || {
  echo "Goal-agent gate source commit does not match $COMMIT" >&2
  exit 1
}
[[ -r "$ROOT/.brai-deploy-branch" && "$(<"$ROOT/.brai-deploy-branch")" == "$BRANCH" ]] || {
  echo "Goal-agent gate source branch does not match $BRANCH" >&2
  exit 1
}

assert_preview_owned() {
  [[ "$ENVIRONMENT" == preview-* ]] || return 0
  "$SCRIPT_DIR/preview-slots.sh" assert-owned "$BRANCH" "$COMMIT" >/dev/null
}

goal_agent_unit() {
  local suffix=""
  [[ "$ENVIRONMENT" == "prod" ]] || suffix="-$ENVIRONMENT"
  printf 'brai-agent-%s%s.service\n' "${1//./-}" "$suffix"
}

normalized_numeric_ids() {
  tr ' ' '\n' | sed '/^$/d' | sort -n -u | paste -sd, -
}

verify_goal_agent_process_identity() {
  local process_id="$1"
  local status_file="/proc/$process_id/status"
  [[ -r "$status_file" ]] || {
    echo "Cannot read Goal-agent process identity: $status_file" >&2
    return 1
  }
  local expected_uid expected_groups actual_uid actual_gid actual_groups
  expected_uid="$(id -u "$GOAL_AGENT_USER")"
  expected_groups="$(printf '%s\n' "$(id -g "$GOAL_AGENT_USER") $(id -G "$GOAL_AGENT_USER")" | normalized_numeric_ids)"
  actual_uid="$(awk '$1 == "Uid:" { print $3 }' "$status_file")"
  actual_gid="$(awk '$1 == "Gid:" { print $3 }' "$status_file")"
  actual_groups="$(printf '%s\n' "$actual_gid $(awk '$1 == "Groups:" { $1 = ""; sub(/^ /, ""); print }' "$status_file")" | normalized_numeric_ids)"
  [[ "$actual_uid" == "$expected_uid" && "$actual_groups" == "$expected_groups" ]] || {
    echo "Goal-agent process $process_id has unexpected effective UID/groups." >&2
    return 1
  }
}

run_goal_agent_health() {
  local agent_id="$1"
  local process_id="$2"
  TEMPORAL_ADDRESS="127.0.0.1:7233" TEMPORAL_NAMESPACE="default" \
    "$NODE_BIN" "$ROOT/services/brai_goal_agents/src/health.mjs" \
      --agent "$agent_id" --environment "$ENVIRONMENT" --pid "$process_id"
}

wait_for_goal_agent() {
  local agent_id="$1"
  local unit="$2"
  local process_id=""
  for _ in {1..40}; do
    process_id="$(systemctl show --property MainPID --value "$unit")"
    if systemctl is-active --quiet "$unit" && [[ "$process_id" =~ ^[1-9][0-9]*$ ]] \
      && verify_goal_agent_process_identity "$process_id" \
      && run_goal_agent_health "$agent_id" "$process_id"; then
      return 0
    fi
    sleep 0.5
  done
  echo "Goal-agent exact poller health check failed ($agent_id, $ENVIRONMENT)." >&2
  journalctl -u "$unit" -n 80 --no-pager >&2 || true
  return 1
}

promote_goal_agent_deployment() {
  TEMPORAL_ADDRESS="127.0.0.1:7233" TEMPORAL_NAMESPACE="default" \
    "$NODE_BIN" "$ROOT/services/brai_goal_agents/src/deployment.mjs" \
      --agent "$1" --environment "$ENVIRONMENT"
}

wait_for_context_poller() {
  local process_id=""
  for _ in {1..40}; do
    process_id="$(systemctl show --property MainPID --value "$SERVICE_NAME")"
    if systemctl is-active --quiet "$SERVICE_NAME" && [[ "$process_id" =~ ^[1-9][0-9]*$ ]] \
      && run_goal_agent_health api.context "$process_id"; then
      return 0
    fi
    sleep 0.5
  done
  echo "API-owned Goal-agent context poller health check failed ($ENVIRONMENT)." >&2
  journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
  return 1
}

assert_preview_owned
for agent_id in "${GOAL_AGENT_IDS[@]}"; do
  unit="$(goal_agent_unit "$agent_id")"
  if [[ "$ENVIRONMENT" == "prod" || "$ENVIRONMENT" == "dev" ]]; then
    echo "Enabling and restarting $unit..."
    "${BRAI_SUDO:-sudo}" systemctl enable --now "$unit"
  fi
  "${BRAI_SUDO:-sudo}" systemctl restart "$unit"
  wait_for_goal_agent "$agent_id" "$unit"
  promote_goal_agent_deployment "$agent_id"
done

wait_for_context_poller
assert_preview_owned
TEMPORAL_ADDRESS="127.0.0.1:7233" TEMPORAL_NAMESPACE="default" \
  "$NODE_BIN" "$ROOT/services/brai_goal_agents/src/context-smoke-cli.mjs" --environment "$ENVIRONMENT"

if [[ "$ENVIRONMENT" == preview-* ]]; then
  assert_preview_owned
  "$SCRIPT_DIR/preview-slots.sh" ready "$BRANCH" "$COMMIT" >/dev/null
  printf 'BRAI_PREVIEW_SLOT_OUTPUT=%s\n' "${BRAI_PREVIEW_SLOT:?BRAI_PREVIEW_SLOT is required}"
fi

DEPLOY_ATTEMPT_FILE="$ROOT/.brai-deploy-attempt"
[[ -f "$DEPLOY_ATTEMPT_FILE" && ! -L "$DEPLOY_ATTEMPT_FILE" ]] || {
  echo "Goal-agent gate deploy-attempt marker is missing or unsafe: $DEPLOY_ATTEMPT_FILE" >&2
  exit 1
}
DEPLOY_ATTEMPT_SUFFIX="$(<"$DEPLOY_ATTEMPT_FILE")"
[[ "$DEPLOY_ATTEMPT_SUFFIX" =~ ^[0-9]{14}-[0-9]+$ \
  || "$DEPLOY_ATTEMPT_SUFFIX" =~ ^(local|[0-9]+)-[0-9]+-[A-Za-z0-9._-]+-[0-9]+-[0-9]+$ ]] || {
  echo "Goal-agent gate deploy-attempt marker is invalid" >&2
  exit 1
}
READY_MARKER="$ROOT/.brai-goal-agent-ready.json"
READY_MARKER_TMP="$READY_MARKER.tmp-$$"
"$NODE_BIN" -e 'const [attempt, branch, commit] = process.argv.slice(1); process.stdout.write(`${JSON.stringify({ attempt, branch, commit, readyAt: new Date().toISOString() })}\n`);' \
  "$DEPLOY_ATTEMPT_SUFFIX" "$BRANCH" "$COMMIT" >"$READY_MARKER_TMP"
mv -f -- "$READY_MARKER_TMP" "$READY_MARKER"
exec 9>&-
if ! "${BRAI_SUDO:-sudo}" systemctl --no-block start brai-storage-maintenance.service; then
  echo "Warning: immediate previous-source cleanup did not start; the maintenance timer remains the fallback." >&2
fi

echo "Goal-agent deployment gate passed for $BRANCH@$COMMIT in $ENVIRONMENT."
