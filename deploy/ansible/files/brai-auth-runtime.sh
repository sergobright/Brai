#!/usr/bin/env bash
set -euo pipefail

readonly AUTH_IMAGE_PATTERN='^ghcr\.io/sergobright/brai-auth@sha256:[0-9a-f]{64}$'
readonly SOURCE_SHA_PATTERN='^[0-9a-f]{40}$'
readonly AUTH_IMAGE_SOURCE='https://github.com/sergobright/Brai'
readonly ABSENT_IMAGE='absent'

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  cat >&2 <<'EOF'
usage:
  brai-auth-runtime.sh pull-only <digest> <source-sha>
  brai-auth-runtime.sh deploy <environment> <digest> <source-sha> [<branch> <commit> <lease>]
  brai-auth-runtime.sh route-enable <environment> [<branch> <commit> <lease>]
  brai-auth-runtime.sh route-disable <environment> [<branch> <commit> <lease>]
  brai-auth-runtime.sh preflight-rollback <environment> <digest|absent> <enabled|disabled> [<branch> <commit> <lease>]
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
  PROD_ENV_FILE="$ENVS_ROOT/prod/brai-auth.env"
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

verify_image_identity() {
  local image="$1" expected_sha="$2" revision='' source=''
  if ! revision="$("$DOCKER_BIN" image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"; then
    die 'Could not inspect auth image revision label.'
  fi
  if ! source="$("$DOCKER_BIN" image inspect --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' "$image")"; then
    die 'Could not inspect auth image source label.'
  fi
  [[ "$revision" == "$expected_sha" ]] || die 'Auth image revision label does not match the exact expected source SHA.'
  [[ "$source" == "$AUTH_IMAGE_SOURCE" ]] || die 'Auth image source label does not match the canonical Brai repository.'
}

pull_only() (
  local image="$1" expected_sha="$2" registry_token='' docker_config=''
  # Invoked indirectly by the EXIT trap below.
  # shellcheck disable=SC2329
  cleanup_registry_login() {
    registry_token=''
    [[ -z "$docker_config" ]] || /bin/rm -rf -- "$docker_config"
  }
  trap cleanup_registry_login EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  require_safe_dir "$AUTH_ROOT"
  require_executable "$DOCKER_BIN"
  IFS= read -r registry_token || die 'A short-lived GHCR token is required on stdin for pull-only.'
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
  if ! DOCKER_CONFIG="$docker_config" "$DOCKER_BIN" pull "$image" >/dev/null; then
    die 'Exact-digest GHCR pull failed.'
  fi
  verify_image_identity "$image" "$expected_sha"
)

start_local_image() {
  local image="$1"
  require_executable "$DOCKER_BIN"
  "$DOCKER_BIN" image inspect "$image" >/dev/null 2>&1 \
    || die 'Auth image is not local; trusted CI must run pull-only before deploy.'
  compose "$image" up -d --no-build auth
}

deploy_image() {
  local image="$1" expected_sha="$2"
  require_executable "$DOCKER_BIN"
  "$DOCKER_BIN" image inspect "$image" >/dev/null 2>&1 \
    || die 'Auth image is not local; trusted CI must run pull-only before deploy.'
  verify_image_identity "$image" "$expected_sha"
  start_local_image "$image"
}

remove_container() {
  local placeholder='ghcr.io/sergobright/brai-auth@sha256:0000000000000000000000000000000000000000000000000000000000000000'
  compose "$placeholder" rm --stop --force auth
}

preflight_rollback() {
  local image="$1" prior_route="$2"
  require_safe_dir "$AUTH_ROOT"
  require_safe_file "$COMPOSE_FILE"
  require_safe_dir "$CADDY_ROOT"
  require_safe_dir "$ROUTE_DIR"
  require_safe_file "$CADDY_LOCK"
  require_safe_file "$CADDYFILE"
  require_executable "$DOCKER_BIN"
  require_executable "$CADDY_BIN"
  require_executable "$SYSTEMCTL_BIN"
  [[ -f "$ROUTE_FILE" && ! -L "$ROUTE_FILE" ]] || die "Auth route fragment is missing or unsafe: $ROUTE_FILE"
  "$CADDY_BIN" validate --adapter caddyfile --config "$CADDYFILE" >/dev/null
  if [[ "$image" == "$ABSENT_IMAGE" ]]; then
    [[ "$prior_route" == 'disabled' ]] || die 'An absent prior auth image cannot have an enabled route.'
  else
    require_safe_file "$ENV_FILE"
    [[ "$(/usr/bin/stat -c '%a' -- "$ENV_FILE")" == '600' ]] \
      || die "Prior auth environment file must have exact mode 600: $ENV_FILE"
    "$DOCKER_BIN" image inspect "$image" >/dev/null 2>&1 \
      || die 'Prior auth image is not local, so tokenless rollback cannot be guaranteed.'
  fi
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
    printf 'Caddy auth route update failed and the previous fragment was restored.\n' >&2
    return 1
  fi
  /bin/rm -f -- "$backup"
  exec 7>&-
}

run_action() {
  local action="$1" image="${2:-}" prior_route="${3:-}" source_sha="${4:-}"
  assert_preview_lease "$action"
  acquire_environment_lock
  case "$action" in
    deploy) deploy_image "$image" "$source_sha" ;;
    route-enable) set_route_state enabled ;;
    route-disable) set_route_state disabled ;;
    preflight-rollback) preflight_rollback "$image" "$prior_route" ;;
    rollback)
      if set_route_state disabled; then
        if [[ "$image" == "$ABSENT_IMAGE" ]]; then remove_container; else start_local_image "$image"; fi
        [[ "$prior_route" != 'enabled' ]] || set_route_state enabled
      else
        printf 'Caddy route disable failed; restoring the prior served runtime or removing the incoming container.\n' >&2
        if [[ "$image" != "$ABSENT_IMAGE" ]]; then
          if ! start_local_image "$image"; then
            remove_container || die 'Could not restore the prior auth image or remove the incoming container.'
            die 'Prior auth image restore failed; incoming container was removed fail-closed.'
          fi
        else
          remove_container || die 'Could not remove the incoming auth container after route-disable failure.'
        fi
        die 'Caddy route disable failed; runtime recovery completed but rollback did not succeed.'
      fi
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
  [[ $# -ge 1 ]] || usage
  local action="$1" environment='' image='' prior_route='' source_sha=''
  shift
  if [[ "$action" == pull-only ]]; then
    [[ $# -eq 2 ]] || usage
    image="$1"
    source_sha="$2"
    require_image "$image"
    [[ "$source_sha" =~ $SOURCE_SHA_PATTERN ]] || die 'Auth image source SHA must be an exact lowercase 40-character SHA.' 2
    pull_only "$image" "$source_sha"
    printf '{"ok":true,"action":"pull-only"}\n'
    return 0
  fi
  [[ $# -ge 1 ]] || usage
  environment="$1"
  shift
  case "$action" in deploy|route-enable|route-disable|preflight-rollback|rollback|remove) ;; *) usage ;; esac
  load_environment "$environment"
  case "$action" in
    deploy)
      [[ $# -ge 2 ]] || usage
      image="$1"
      source_sha="$2"
      shift 2
      require_image "$image"
      [[ "$source_sha" =~ $SOURCE_SHA_PATTERN ]] || die 'Auth image source SHA must be an exact lowercase 40-character SHA.' 2
      parse_lease "$@"
      [[ -z "$PREVIEW_SLOT" || "$source_sha" == "$LEASE_COMMIT" ]] \
        || die 'Preview auth image source SHA must match the exact Preview lease commit.' 2
      ;;
    route-enable|route-disable|remove) parse_lease "$@" ;;
    preflight-rollback|rollback)
      [[ $# -ge 2 ]] || usage
      image="$1"
      prior_route="$2"
      shift 2
      [[ "$image" == "$ABSENT_IMAGE" ]] || require_image "$image"
      [[ "$prior_route" == 'enabled' || "$prior_route" == 'disabled' ]] || usage
      [[ "$image" != "$ABSENT_IMAGE" || "$prior_route" == 'disabled' ]] \
        || die 'An absent prior auth image cannot have an enabled route.' 2
      parse_lease "$@"
      ;;
  esac
  run_action "$action" "$image" "$prior_route" "$source_sha"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
