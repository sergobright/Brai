#!/usr/bin/env bash
set -euo pipefail

ENVS_ROOT="${BRAI_ENVS_ROOT:-/srv/projects/brai-envs}"
RELEASE_DIR="${BRAI_RELEASE_DIR:-/srv/projects/brai/deploy/releases}"
SUPABASE_ROOT="${BRAI_SUPABASE_ROOT:-/srv/opt/supabase/docker}"
MANAGED_POOLER_CONFIG="${BRAI_SUPAVISOR_MANAGED_CONFIG:-/srv/opt/brai-supavisor-pooler.exs}"
LIVE_POOLER_CONFIG="${BRAI_SUPAVISOR_LIVE_CONFIG:-$SUPABASE_ROOT/volumes/pooler/pooler.exs}"
TENANT_TOOL="${BRAI_SUPAVISOR_TENANT_TOOL:-/srv/opt/brai-supavisor-tenants.mjs}"
NODE_BIN="${BRAI_NODE_BIN:-/srv/opt/node-v22.16.0/bin/node}"
PROD_ENV="${BRAI_PROD_ENV_FILE:-/etc/brai/brai-api.env}"
DEPLOY_ENV="${BRAI_SUPABASE_DEPLOY_ENV_FILE:-/etc/brai/supabase-deploy.env}"
POOLER_CONTAINER="${BRAI_SUPAVISOR_CONTAINER:-supabase-pooler}"
DATABASE_CONTAINER="${BRAI_SUPABASE_DATABASE_CONTAINER:-supabase-db}"
PROD_MONITOR_SECONDS="${BRAI_SUPAVISOR_PROD_MONITOR_SECONDS:-300}"
NONPROD_MONITOR_SECONDS="${BRAI_SUPAVISOR_NONPROD_MONITOR_SECONDS:-75}"
LOCKS_HELD_ENV="BRAI_SUPABASE_MAINTENANCE_LOCKS_HELD"

ENVIRONMENTS=(prod dev preview-a preview-b preview-c preview-d preview-e)
API_SERVICES=(brai-api.service brai-api-dev.service brai-api-preview-a.service brai-api-preview-b.service brai-api-preview-c.service brai-api-preview-d.service brai-api-preview-e.service)
API_PORTS=(3020 3030 3031 3032 3033 3034 3035)

APPLY=false
BACKUP_ROOT=""
ROLLBACK_NEEDED=false
ACTIVE_SERVICES=()
BACKUP_PATHS=()
BACKUP_FILES=()

usage() {
  echo "usage: supabase-maintenance.sh [--apply] reconfigure-pooler" >&2
}

require_safe_file() {
  [[ -f "$1" && ! -L "$1" ]] || { echo "Required regular file is missing or unsafe: $1" >&2; exit 1; }
}

lock_paths() {
  local environment lock
  for environment in "${ENVIRONMENTS[@]}"; do
    lock="$ENVS_ROOT/$environment/.source-operation.lock"
    require_safe_file "$lock"
    printf '%s\n' "$lock"
  done
  require_safe_file "$ENVS_ROOT/ci-uploads/.staging-operation.lock"
  printf '%s\n' "$ENVS_ROOT/ci-uploads/.staging-operation.lock"
  [[ -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]] || { echo "Release lock directory is missing or unsafe: $RELEASE_DIR" >&2; exit 1; }
  printf '%s\n' "$RELEASE_DIR"
  require_safe_file "$ENVS_ROOT/preview-slots.lock"
  printf '%s\n' "$ENVS_ROOT/preview-slots.lock"
}

acquire_locks_and_reexec() {
  [[ "${!LOCKS_HELD_ENV:-}" != "1" ]] || return 0
  local lock_output
  local -a locks locked_command
  lock_output="$(lock_paths)"
  mapfile -t locks <<<"$lock_output"
  locked_command=(/usr/bin/env "$LOCKS_HELD_ENV=1" "$0" --apply reconfigure-pooler)
  for ((index=${#locks[@]} - 1; index >= 0; index -= 1)); do
    locked_command=(/usr/bin/flock --exclusive "${locks[index]}" "${locked_command[@]}")
  done
  exec "${locked_command[@]}"
}

backup_file() {
  local source="$1" target="$BACKUP_ROOT/${#BACKUP_FILES[@]}"
  require_safe_file "$source"
  cp -a -- "$source" "$target"
  BACKUP_PATHS+=("$source")
  BACKUP_FILES+=("$target")
}

restore_backups() {
  for ((index=0; index < ${#BACKUP_FILES[@]}; index += 1)); do
    cp -a -- "${BACKUP_FILES[index]}" "${BACKUP_PATHS[index]}"
  done
}

compose_recreate_pooler() {
  (
    cd "$SUPABASE_ROOT"
    /usr/bin/docker compose -f docker-compose.yml -f docker-compose.brai.yml up -d --force-recreate supavisor
  )
}

wait_for_pooler() {
  for ((attempt=1; attempt <= 60; attempt += 1)); do
    if [[ "$(/usr/bin/docker inspect --format '{{.State.Health.Status}}' "$POOLER_CONTAINER" 2>/dev/null || true)" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done
  echo "Supavisor did not become healthy" >&2
  return 1
}

wait_for_pooler_connections_to_close() {
  local connections
  for ((attempt=1; attempt <= 30; attempt += 1)); do
    connections="$(/usr/bin/ss -Htan state established '( dport = :55432 or dport = :56543 )')" || {
      echo "Cannot inspect Supavisor connections" >&2
      return 1
    }
    [[ -n "$connections" ]] || return 0
    sleep 1
  done
  echo "Supavisor still has established API connections" >&2
  return 1
}

delete_legacy_tenant_metadata() {
  /usr/bin/docker exec -i "$DATABASE_CONTAINER" psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
    --username supabase_admin --dbname _supabase >/dev/null <<'SQL'
BEGIN;
DELETE FROM _supavisor.cluster_tenants
WHERE tenant_external_id IN ('brightos', 'brightos-prod', 'brightos-nonprod');
DELETE FROM _supavisor.tenants
WHERE external_id IN ('brightos', 'brightos-prod', 'brightos-nonprod');
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM _supavisor.tenants
    WHERE external_id IN ('brightos', 'brightos-prod', 'brightos-nonprod')
  ) THEN
    RAISE EXCEPTION 'Legacy Supavisor tenant metadata remains';
  END IF;
END
$$;
COMMIT;
SQL
}

assert_target_tenant_metadata() {
  /usr/bin/docker exec -i "$DATABASE_CONTAINER" psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
    --username supabase_admin --dbname _supabase >/dev/null <<'SQL'
DO $$
DECLARE
  actual_tenants text[];
BEGIN
  SELECT COALESCE(array_agg(external_id ORDER BY external_id), ARRAY[]::text[])
  INTO actual_tenants
  FROM _supavisor.tenants;

  IF actual_tenants IS DISTINCT FROM ARRAY['brai-nonprod', 'brai-prod']::text[] THEN
    RAISE EXCEPTION 'Supavisor tenant metadata is not restricted to Brai targets';
  END IF;
END
$$;
SQL
}

wait_for_auth_canary() {
  local port="$1"
  local response="$BACKUP_ROOT/auth-session-$port.json"
  for ((attempt=1; attempt <= 60; attempt += 1)); do
    if /usr/bin/curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
        "http://127.0.0.1:$port/health" >/dev/null \
      && /usr/bin/curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
        --header 'Cookie: better-auth.session_token=invalid-maintenance-canary' \
        "http://127.0.0.1:$port/auth/session" >"$response" \
      && grep -Eq '"authenticated"[[:space:]]*:[[:space:]]*false' "$response"; then
      return 0
    fi
    sleep 2
  done
  echo "Auth canary failed on localhost port $port" >&2
  return 1
}

assert_clean_pooler_logs() {
  local since="$1" logs
  logs="$(/usr/bin/docker logs --since "$since" "$POOLER_CONTAINER" 2>&1)" || {
    echo "Cannot inspect Supavisor logs" >&2
    return 1
  }
  if grep -Eqi 'SCRAM.*timeout|timeout.*SCRAM|Circuit breaker|ECIRCUITBREAKER' <<<"$logs"; then
    echo "Supavisor auth failure detected during maintenance canary" >&2
    return 1
  fi
}

monitor_pooler() {
  local since="$1" seconds="$2" elapsed=0
  while (( elapsed < seconds )); do
    sleep "$(( seconds - elapsed < 15 ? seconds - elapsed : 15 ))"
    elapsed=$((elapsed + 15))
    assert_clean_pooler_logs "$since"
  done
}

remember_active_services() {
  local service
  for service in "${API_SERVICES[@]}"; do
    if /bin/systemctl is-active --quiet "$service"; then ACTIVE_SERVICES+=("$service"); fi
  done
  [[ " ${ACTIVE_SERVICES[*]} " == *" brai-api.service "* ]] || {
    echo "Production API must be active before Supavisor maintenance" >&2
    exit 1
  }
}

was_active() {
  [[ " ${ACTIVE_SERVICES[*]} " == *" $1 "* ]]
}

rollback() {
  local status=$?
  trap - EXIT INT TERM HUP
  set +e
  if [[ "$ROLLBACK_NEEDED" == "true" ]]; then
    echo "Supavisor maintenance failed; restoring previous config and DSNs" >&2
    restore_backups
    compose_recreate_pooler
    wait_for_pooler
    local rollback_started_at
    rollback_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if /bin/systemctl start brai-api.service \
      && wait_for_auth_canary 3020 \
      && monitor_pooler "$rollback_started_at" "$PROD_MONITOR_SECONDS"; then
      echo "Rollback restored production; non-production APIs remain stopped for investigation" >&2
    else
      echo "Rollback could not restore a clean production auth canary; non-production APIs remain stopped" >&2
    fi
  fi
  [[ -z "$BACKUP_ROOT" ]] || rm -rf -- "$BACKUP_ROOT"
  exit "$status"
}

rewrite_runtime_tenants() {
  "$NODE_BIN" "$TENANT_TOOL" rewrite-env --file "$PROD_ENV" --tenant brai-prod
  "$NODE_BIN" "$TENANT_TOOL" rewrite-env --file "$DEPLOY_ENV" --key SUPABASE_SELF_HOSTED_DATABASE_URL --tenant brai-nonprod
  "$NODE_BIN" "$TENANT_TOOL" set-env --file "$DEPLOY_ENV" --key BRAI_SUPAVISOR_TENANT_ISOLATION --value true
  local environment env_file
  for environment in "${ENVIRONMENTS[@]:1}"; do
    env_file="$ENVS_ROOT/$environment/brai-api.env"
    [[ ! -f "$env_file" ]] || "$NODE_BIN" "$TENANT_TOOL" rewrite-env --file "$env_file" --tenant brai-nonprod --if-present
  done
}

reconfigure_pooler() {
  [[ "$(id -u)" == "0" ]] || { echo "--apply must run as root" >&2; exit 1; }
  [[ "$PROD_MONITOR_SECONDS" =~ ^[0-9]+$ && "$NONPROD_MONITOR_SECONDS" =~ ^[0-9]+$ ]] || {
    echo "Supavisor monitor durations must be non-negative integers" >&2
    exit 1
  }
  require_safe_file "$MANAGED_POOLER_CONFIG"
  require_safe_file "$LIVE_POOLER_CONFIG"
  require_safe_file "$TENANT_TOOL"
  require_safe_file "$PROD_ENV"
  require_safe_file "$DEPLOY_ENV"
  [[ -d "$SUPABASE_ROOT" && ! -L "$SUPABASE_ROOT" ]] || { echo "Supabase root is missing or unsafe" >&2; exit 1; }

  remember_active_services
  BACKUP_ROOT="$(mktemp -d /tmp/brai-supabase-maintenance.XXXXXX)"
  trap rollback EXIT INT TERM HUP
  backup_file "$LIVE_POOLER_CONFIG"
  backup_file "$PROD_ENV"
  backup_file "$DEPLOY_ENV"
  local environment env_file
  for environment in "${ENVIRONMENTS[@]:1}"; do
    env_file="$ENVS_ROOT/$environment/brai-api.env"
    [[ ! -f "$env_file" ]] || backup_file "$env_file"
  done
  ROLLBACK_NEEDED=true

  /bin/systemctl stop "${API_SERVICES[@]}"
  wait_for_pooler_connections_to_close
  /usr/bin/install -o root -g root -m 0644 "$MANAGED_POOLER_CONFIG" "$LIVE_POOLER_CONFIG"
  delete_legacy_tenant_metadata
  local started_at
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  compose_recreate_pooler
  wait_for_pooler
  assert_target_tenant_metadata
  rewrite_runtime_tenants

  /bin/systemctl start brai-api.service
  wait_for_auth_canary 3020
  monitor_pooler "$started_at" "$PROD_MONITOR_SECONDS"

  for ((index=1; index < ${#API_SERVICES[@]}; index += 1)); do
    if was_active "${API_SERVICES[index]}"; then
      /bin/systemctl start "${API_SERVICES[index]}"
      wait_for_auth_canary "${API_PORTS[index]}"
      monitor_pooler "$started_at" "$NONPROD_MONITOR_SECONDS"
    fi
  done
  assert_clean_pooler_logs "$started_at"
  ROLLBACK_NEEDED=false
  trap - EXIT INT TERM HUP
  rm -rf -- "$BACKUP_ROOT"
  BACKUP_ROOT=""
  echo '{"ok":true,"operation":"reconfigure-pooler","tenantIsolation":true,"legacyTenantsRemoved":true}'
}

main() {
  local parsed_command=""
  for arg in "$@"; do
    case "$arg" in
      --apply) APPLY=true ;;
      reconfigure-pooler) [[ -z "$parsed_command" ]] || { usage; exit 2; }; parsed_command="$arg" ;;
      *) usage; exit 2 ;;
    esac
  done
  [[ "$parsed_command" == "reconfigure-pooler" ]] || { usage; exit 2; }
  if [[ "$APPLY" != "true" ]]; then
    echo '{"ok":true,"mode":"dry-run","operation":"reconfigure-pooler","changes":false}'
    return 0
  fi
  [[ "$(id -u)" == "0" ]] || { echo "--apply must run as root" >&2; exit 1; }
  acquire_locks_and_reexec
  reconfigure_pooler
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
