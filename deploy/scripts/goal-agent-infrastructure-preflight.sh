#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT="${1:-}"
GOAL_AGENT_USER="${BRAI_GOAL_AGENT_USER:-brai-goal-agent}"
GOAL_AGENT_GROUP="${BRAI_GOAL_AGENT_GROUP:-brai-goal-agent}"
API_SERVICE_USER="${BRAI_SERVICE_USER:-brai}"
GOAL_AGENT_ENV_FILE="${BRAI_GOAL_AGENT_ENV_FILE:-/etc/brai/brai-goal-agents.env}"
SYSTEMD_UNIT_DIR="${BRAI_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
AGENT_SLUGS=(
  activity-classifier
  goal-item-matcher
  goal-member-finder
  goal-discovery
  goal-planner
)

case "$ENVIRONMENT" in
  prod) UNIT_SUFFIX="" ;;
  dev) UNIT_SUFFIX="-dev" ;;
  preview-[a-e]) UNIT_SUFFIX="-$ENVIRONMENT" ;;
  *)
    echo "Unsupported Goal-agent deployment environment: $ENVIRONMENT" >&2
    exit 1
    ;;
esac

failures=()
if ! getent passwd "$GOAL_AGENT_USER" >/dev/null; then
  failures+=("missing user $GOAL_AGENT_USER")
fi
if ! getent group "$GOAL_AGENT_GROUP" >/dev/null; then
  failures+=("missing group $GOAL_AGENT_GROUP")
fi
if ! getent passwd "$API_SERVICE_USER" >/dev/null; then
  failures+=("missing API service user $API_SERVICE_USER")
else
  api_service_groups=" $(id -Gn "$API_SERVICE_USER") "
  [[ "$api_service_groups" == *" $GOAL_AGENT_GROUP "* ]] || \
    failures+=("API service user $API_SERVICE_USER cannot read shared Goal-agent runtime contracts")
fi
if ((EUID != 0)); then
  deploy_groups=" $(id -Gn) "
  [[ "$deploy_groups" == *" $GOAL_AGENT_GROUP "* ]] || \
    failures+=("deploy identity $(id -un) cannot publish Goal-agent source to $GOAL_AGENT_GROUP")
fi
if getent passwd "$GOAL_AGENT_USER" >/dev/null; then
  primary_group="$(id -gn "$GOAL_AGENT_USER" 2>/dev/null || true)"
  login_shell="$(getent passwd "$GOAL_AGENT_USER" | cut -d: -f7)"
  [[ "$primary_group" == "$GOAL_AGENT_GROUP" ]] || failures+=("$GOAL_AGENT_USER primary group is not $GOAL_AGENT_GROUP")
  [[ "$login_shell" == */nologin || "$login_shell" == */false ]] || failures+=("$GOAL_AGENT_USER is not a non-login identity")
fi

if [[ ! -f "$GOAL_AGENT_ENV_FILE" ]]; then
  failures+=("missing $GOAL_AGENT_ENV_FILE")
else
  env_contract="$(stat -c '%U:%G:%a' "$GOAL_AGENT_ENV_FILE" 2>/dev/null || true)"
  [[ "$env_contract" == "root:$GOAL_AGENT_GROUP:640" ]] || \
    failures+=("$GOAL_AGENT_ENV_FILE must be root:$GOAL_AGENT_GROUP 0640 (found ${env_contract:-unreadable})")
fi

units=()
for slug in "${AGENT_SLUGS[@]}"; do
  unit="$SYSTEMD_UNIT_DIR/brai-agent-$slug$UNIT_SUFFIX.service"
  units+=("$unit")
  [[ -f "$unit" ]] || failures+=("missing $unit")
done
[[ "${#units[@]}" == 5 ]] || failures+=("expected exactly five Goal-agent units for $ENVIRONMENT")

if ((${#failures[@]} > 0)); then
  printf 'Goal-agent infrastructure preflight failed for %s:\n' "$ENVIRONMENT" >&2
  printf ' - %s\n' "${failures[@]}" >&2
  echo "Apply deploy/ansible/brai.yml with the server-admin inventory before retrying this deployment." >&2
  exit 1
fi

printf 'Goal-agent infrastructure preflight passed for %s (5 units, isolated identity, protected env contract).\n' "$ENVIRONMENT"
