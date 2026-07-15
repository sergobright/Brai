#!/usr/bin/env bash
set -euo pipefail

readonly AUTH_IMAGE_PATTERN='^ghcr\.io/sergobright/brai-auth@sha256:[0-9a-f]{64}$'
readonly ABSENT_IMAGE='absent'

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  cat >&2 <<'EOF'
usage:
  brai-auth-runtime.sh deploy <environment> <digest> [<branch> <commit> <lease>]
  brai-auth-runtime.sh route-enable <environment> [<branch> <commit> <lease>]
  brai-auth-runtime.sh route-disable <environment> [<branch> <commit> <lease>]
  brai-auth-runtime.sh rollback <environment> <digest|absent> <enabled|disabled> [<branch> <commit> <lease>]
  brai-auth-runtime.sh remove <environment> [<branch> <commit> <lease>]
EOF
  exit 2
}

configure_paths() {
  local prefix='' bin_root=''
  if (( EUID == 0 )); then
    local name
    while IFS= read -r name; do
      [[ -z "${!name:-}" ]] || die 'BRAI_AUTH_TEST_* overrides are forbidden for root execution.'
    done < <(compgen -A variable BRAI_AUTH_TEST_ || true)
  else
    [[ "${BRAI_AUTH_TEST_MODE:-}" == '1' ]] || die 'Brai auth runtime mutations must run as root.'
    local allowed=' BRAI_AUTH_TEST_MODE BRAI_AUTH_TEST_ROOT BRAI_AUTH_TEST_BIN BRAI_AUTH_TEST_NODE_BIN '
    local name
    while IFS= read -r name; do
      [[ "$allowed" == *" $name "* ]] || die "Unsupported test override: $name"
    done < <(compgen -A variable BRAI_AUTH_TEST_ || true)
    prefix="${BRAI_AUTH_TEST_ROOT:?BRAI_AUTH_TEST_ROOT is required in test mode}"
    bin_root="${BRAI_AUTH_TEST_BIN:?BRAI_AUTH_TEST_BIN is required in test mode}"
  fi

  AUTH_ROOT="$prefix/srv/opt/brai-auth"
  COMPOSE_FILE="$AUTH_ROOT/compose.yml"
  CADDY_LOCK="$AUTH_ROOT/caddy.lock"
  CADDY_ROOT="$prefix/etc/caddy/brai-auth"
  CADDYFILE="$prefix/etc/caddy/Caddyfile"
  ENVS_ROOT="$prefix/srv/projects/brai-envs"
  PROD_ENV_FILE="$prefix/etc/brai/brai-auth.env"
  PREVIEW_REGISTRY="$ENVS_ROOT/preview-slots.json"
  PREVIEW_LOCK="$ENVS_ROOT/preview-slots.lock"
  DOCKER_BIN="${bin_root:-/usr/bin}/docker"
  CADDY_BIN="${bin_root:-/usr/bin}/caddy"
  SYSTEMCTL_BIN="${bin_root:-/bin}/systemctl"
  NODE_BIN="${BRAI_AUTH_TEST_NODE_BIN:-/srv/opt/node-v22.16.0/bin/node}"
}

require_safe_file() {
  [[ -f "$1" && ! -L "$1" ]] || die "Required fixed file is missing or unsafe: $1"
}

require_safe_dir() {
  [[ -d "$1" && ! -L "$1" ]] || die "Required fixed directory is missing or unsafe: $1"
}

require_executable() {
  [[ -f "$1" && ! -L "$1" && -x "$1" ]] || die "Required fixed executable is missing or unsafe: $1"
}

load_environment() {
  ENVIRONMENT="$1"
  case "$ENVIRONMENT" in
    prod)
      AUTH_PORT=3050
      COMPOSE_PROJECT=brai
      ENV_PATH=prod
      PREVIEW_SLOT=''
      ENV_FILE="$PROD_ENV_FILE"
      ;;
    dev)
      AUTH_PORT=3051
      COMPOSE_PROJECT=dev-brai
      ENV_PATH=dev
      PREVIEW_SLOT=''
      ENV_FILE="$ENVS_ROOT/dev/brai-auth.env"
      ;;
    preview-a|preview-b|preview-c|preview-d|preview-e)
      local slot="${ENVIRONMENT#preview-}"
      local offset=$(( $(printf '%d' "'$slot") - $(printf '%d' "'a") ))
      AUTH_PORT=$((3052 + offset))
      COMPOSE_PROJECT="preview-$slot-brai"
      ENV_PATH="$ENVIRONMENT"
      PREVIEW_SLOT="${slot^^}"
      ENV_FILE="$ENVS_ROOT/$ENVIRONMENT/brai-auth.env"
      ;;
    *) die "Unsupported Brai auth environment: $ENVIRONMENT" 2 ;;
  esac
  AUTH_LOCK="$ENVS_ROOT/$ENV_PATH/.auth-operation.lock"
  ROUTE_DIR="$CADDY_ROOT/$ENVIRONMENT"
  ROUTE_FILE="$ROUTE_DIR/route.caddy"
}

require_image() {
  [[ "$1" =~ $AUTH_IMAGE_PATTERN ]] || die 'Auth image must be the exact immutable ghcr.io/sergobright/brai-auth@sha256 digest.' 2
}

parse_lease() {
  LEASE_BRANCH=''
  LEASE_COMMIT=''
  LEASE_GENERATION=''
  if [[ -n "$PREVIEW_SLOT" ]]; then
    [[ $# -eq 3 ]] || usage
    LEASE_BRANCH="$1"
    LEASE_COMMIT="$2"
    LEASE_GENERATION="$3"
    [[ "$LEASE_BRANCH" =~ ^codex/[A-Za-z0-9._/-]+$ && "$LEASE_BRANCH" != *'..'* ]] || die 'Invalid Preview branch.' 2
    [[ "$LEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die 'Invalid Preview commit.' 2
    [[ "$LEASE_GENERATION" =~ ^[1-9][0-9]*$ ]] || die 'Invalid Preview lease generation.' 2
  else
    [[ $# -eq 0 ]] || usage
  fi
}

assert_preview_lease() {
  local action="$1"
  [[ -n "$PREVIEW_SLOT" ]] || return 0
  require_safe_file "$PREVIEW_LOCK"
  require_safe_file "$PREVIEW_REGISTRY"
  require_executable "$NODE_BIN"
  exec 9<"$PREVIEW_LOCK"
  /usr/bin/flock -s 9
  if ! "$NODE_BIN" - "$PREVIEW_REGISTRY" "$PREVIEW_SLOT" "$LEASE_BRANCH" "$LEASE_COMMIT" "$LEASE_GENERATION" "$action" <<'NODE'
const fs = require('node:fs');
const [registryPath, slot, branch, commit, generation, action] = process.argv.slice(2);
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const entry = registry[slot];
const allowedStatuses = ['route-disable', 'rollback', 'remove'].includes(action)
  ? ['deploying', 'ready', 'failed', 'releasing', 'cleanup_failed']
  : ['deploying', 'ready'];
const valid = entry
  && entry.branch === branch
  && entry.commit === commit
  && String(entry.lease_generation) === generation
  && allowedStatuses.includes(entry.status);
process.exit(valid ? 0 : 1);
NODE
  then
    exec 9>&-
    die 'Preview auth mutation rejected: branch, commit, lease, or slot does not match.'
  fi
  exec 9>&-
}

acquire_environment_lock() {
  require_safe_file "$AUTH_LOCK"
  exec 8<>"$AUTH_LOCK"
  /usr/bin/flock -x 8
}

compose() {
  require_safe_file "$COMPOSE_FILE"
  require_safe_file "$ENV_FILE"
  require_executable "$DOCKER_BIN"
  BRAI_AUTH_IMAGE="$1" BRAI_AUTH_ENV_FILE="$ENV_FILE" BRAI_AUTH_PORT="$AUTH_PORT" \
    "$DOCKER_BIN" compose --project-name "$COMPOSE_PROJECT" --file "$COMPOSE_FILE" "${@:2}"
}

pull_image_if_missing() (
  local image="$1" registry_token='' docker_config=''
  cleanup_registry_login() {
    registry_token=''
    [[ -z "$docker_config" ]] || /bin/rm -rf -- "$docker_config"
  }
  trap cleanup_registry_login EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if "$DOCKER_BIN" image inspect "$image" >/dev/null 2>&1; then
    return 0
  fi

  IFS= read -r registry_token || die 'A short-lived GHCR token is required on stdin for a missing auth image.'
  [[ -n "$registry_token" && ${#registry_token} -le 1024 && "$registry_token" != *[[:space:]]* ]] \
    || die 'The GHCR token supplied on stdin is empty or malformed.'
  docker_config="$(/usr/bin/mktemp -d "$AUTH_ROOT/.registry-login.XXXXXX")"
  /bin/chmod 0700 "$docker_config"
  if ! printf '%s\n' "$registry_token" \
    | DOCKER_CONFIG="$docker_config" "$DOCKER_BIN" login ghcr.io --username sergobright --password-stdin \
      >/dev/null 2>&1; then
    die 'Short-lived GHCR authentication failed.'
  fi
  registry_token=''
  if ! DOCKER_CONFIG="$docker_config" compose "$image" pull auth; then
    die 'Exact-digest GHCR pull failed.'
  fi
)

deploy_image() {
  local image="$1"
  pull_image_if_missing "$image"
  compose "$image" up -d --no-build auth
}

remove_container() {
  local placeholder='ghcr.io/sergobright/brai-auth@sha256:0000000000000000000000000000000000000000000000000000000000000000'
  compose "$placeholder" rm --stop --force auth
}

render_enabled_route() {
  cat <<'EOF'
@brai_auth_compatibility path {args.0} {args.1} {args.2} {args.3} {args.4} {args.5}
handle @brai_auth_compatibility {
  uri strip_prefix {args.6}
  reverse_proxy 127.0.0.1:{args.8}
}

@brai_auth_official path {args.7}
handle @brai_auth_official {
  reverse_proxy 127.0.0.1:{args.9} {
    header_up Host {args.10}
    header_up X-Forwarded-Host {args.10}
    header_up X-Forwarded-Proto https
  }
}

handle {args.11} {
  import brai_unified_basic_auth
  reverse_proxy 127.0.0.1:{args.8}
}
EOF
}

render_disabled_route() {
  printf '# Brai auth route is disabled until an exact-digest runtime deployment.\n'
}

restore_route() {
  local backup="$1" had_route="$2"
  if [[ "$had_route" == 'true' ]]; then
    if ! /bin/mv -f -- "$backup" "$ROUTE_FILE"; then
      printf 'Caddy route rollback could not restore the previous fragment.\n' >&2
      return 1
    fi
  else
    if ! /bin/rm -f -- "$ROUTE_FILE" "$backup"; then
      printf 'Caddy route rollback could not remove the failed fragment.\n' >&2
      return 1
    fi
  fi
  if ! "$CADDY_BIN" validate --adapter caddyfile --config "$CADDYFILE" >/dev/null \
    || ! "$SYSTEMCTL_BIN" reload caddy >/dev/null; then
    printf 'Caddy route rollback could not be verified.\n' >&2
    return 1
  fi
}

set_route_state() {
  local state="$1" candidate backup had_route=false
  require_safe_dir "$CADDY_ROOT"
  require_safe_dir "$ROUTE_DIR"
  require_safe_file "$CADDY_LOCK"
  require_safe_file "$CADDYFILE"
  require_executable "$CADDY_BIN"
  require_executable "$SYSTEMCTL_BIN"
  [[ ! -e "$ROUTE_FILE" || (-f "$ROUTE_FILE" && ! -L "$ROUTE_FILE") ]] || die "Auth route fragment is unsafe: $ROUTE_FILE"

  exec 7<>"$CADDY_LOCK"
  /usr/bin/flock -x 7
  candidate="$(/usr/bin/mktemp "$CADDY_ROOT/.route-candidate.XXXXXX")"
  backup="$(/usr/bin/mktemp "$CADDY_ROOT/.route-backup.XXXXXX")"
  if [[ "$state" == 'enabled' ]]; then render_enabled_route >"$candidate"; else render_disabled_route >"$candidate"; fi
  /bin/chmod 0644 "$candidate"
  if [[ -f "$ROUTE_FILE" ]] && /usr/bin/cmp -s -- "$candidate" "$ROUTE_FILE"; then
    /bin/rm -f -- "$candidate" "$backup"
    exec 7>&-
    return 0
  fi
  if [[ -f "$ROUTE_FILE" ]]; then
    /bin/cp -p -- "$ROUTE_FILE" "$backup"
    had_route=true
  fi
  /bin/mv -f -- "$candidate" "$ROUTE_FILE"
  if ! "$CADDY_BIN" validate --adapter caddyfile --config "$CADDYFILE" >/dev/null \
    || ! "$SYSTEMCTL_BIN" reload caddy >/dev/null; then
    if ! restore_route "$backup" "$had_route"; then
      exec 7>&-
      die 'Caddy auth route update failed and rollback could not be verified; operator intervention is required.'
    fi
    exec 7>&-
    die 'Caddy auth route update failed and the previous fragment was restored.'
  fi
  /bin/rm -f -- "$backup"
  exec 7>&-
}

run_action() {
  local action="$1" image="${2:-}" prior_route="${3:-}"
  assert_preview_lease "$action"
  acquire_environment_lock
  case "$action" in
    deploy) deploy_image "$image" ;;
    route-enable) set_route_state enabled ;;
    route-disable) set_route_state disabled ;;
    rollback)
      set_route_state disabled
      if [[ "$image" == "$ABSENT_IMAGE" ]]; then remove_container; else deploy_image "$image"; fi
      [[ "$prior_route" != 'enabled' ]] || set_route_state enabled
      ;;
    remove)
      set_route_state disabled
      remove_container
      ;;
    *) usage ;;
  esac
  exec 8>&-
  printf '{"ok":true,"action":"%s","environment":"%s"}\n' "$action" "$ENVIRONMENT"
}

main() {
  configure_paths
  [[ $# -ge 2 ]] || usage
  local action="$1" environment="$2" image='' prior_route=''
  shift 2
  case "$action" in deploy|route-enable|route-disable|rollback|remove) ;; *) usage ;; esac
  load_environment "$environment"
  case "$action" in
    deploy)
      [[ $# -ge 1 ]] || usage
      image="$1"
      shift
      require_image "$image"
      parse_lease "$@"
      ;;
    route-enable|route-disable|remove) parse_lease "$@" ;;
    rollback)
      [[ $# -ge 2 ]] || usage
      image="$1"
      prior_route="$2"
      shift 2
      [[ "$image" == "$ABSENT_IMAGE" ]] || require_image "$image"
      [[ "$prior_route" == 'enabled' || "$prior_route" == 'disabled' ]] || usage
      parse_lease "$@"
      ;;
  esac
  run_action "$action" "$image" "$prior_route"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
