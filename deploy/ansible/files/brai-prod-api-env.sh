#!/usr/bin/env bash
set -euo pipefail

readonly ATTEMPT_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  cat >&2 <<'EOF'
usage:
  brai-prod-api-env.sh stage <attempt-id>
  brai-prod-api-env.sh rollback <attempt-id>
  brai-prod-api-env.sh commit <attempt-id>
EOF
  exit 2
}

configure_paths() {
  local prefix=''
  if (( EUID == 0 )); then
    local name
    while IFS= read -r name; do
      [[ -z "${!name:-}" ]] || die 'BRAI_PROD_API_ENV_TEST_* overrides are forbidden for root execution.'
    done < <(compgen -A variable BRAI_PROD_API_ENV_TEST_ || true)
    TARGET_UID=0
    TARGET_GID="$(/usr/bin/getent group brai-deploy | /usr/bin/cut -d: -f3)"
    STATE_UID=0
    STATE_GID=0
    [[ "$TARGET_GID" =~ ^[0-9]+$ ]] || die 'The brai-deploy group is required.'
  else
    [[ "${BRAI_PROD_API_ENV_TEST_MODE:-}" == '1' ]] || die 'Production API environment mutations must run as root.'
    local allowed=' BRAI_PROD_API_ENV_TEST_MODE BRAI_PROD_API_ENV_TEST_ROOT BRAI_PROD_API_ENV_TEST_NODE_BIN '
    local name
    while IFS= read -r name; do
      [[ "$allowed" == *" $name "* ]] || die "Unsupported test override: $name"
    done < <(compgen -A variable BRAI_PROD_API_ENV_TEST_ || true)
    prefix="${BRAI_PROD_API_ENV_TEST_ROOT:?BRAI_PROD_API_ENV_TEST_ROOT is required in test mode}"
    TARGET_UID="$(/usr/bin/id -u)"
    TARGET_GID="$(/usr/bin/id -g)"
    STATE_UID="$TARGET_UID"
    STATE_GID="$TARGET_GID"
  fi

  TARGET="$prefix/etc/brai/brai-api.env"
  STATE_ROOT="$prefix/etc/brai/.brai-prod-api-env"
  LOCK_FILE="$STATE_ROOT/lock"
  ACTIVE_DIR="$STATE_ROOT/active"
  PENDING_DIR="$STATE_ROOT/pending"
  LAST_FILE="$STATE_ROOT/last"
  NODE_BIN="${BRAI_PROD_API_ENV_TEST_NODE_BIN:-/srv/opt/node-v22.16.0/bin/node}"
}

require_safe_dir() {
  local path="$1" mode="$2"
  [[ -d "$path" && ! -L "$path" ]] || die "Required fixed directory is missing or unsafe: $path"
  [[ "$(/usr/bin/stat -c '%a:%u:%g' -- "$path")" == "$mode:0:0" ]] \
    || die "Required fixed directory has unsafe metadata: $path"
}

require_safe_file() {
  local path="$1" mode="$2" uid="$3" gid="$4"
  [[ -f "$path" && ! -L "$path" ]] || die "Required fixed file is missing or unsafe: $path"
  [[ "$(/usr/bin/stat -c '%a:%u:%g' -- "$path")" == "$mode:$uid:$gid" ]] \
    || die "Required fixed file has unsafe metadata: $path"
}

require_executable() {
  [[ -f "$1" && ! -L "$1" && -x "$1" ]] || die "Required fixed executable is missing or unsafe: $1"
}

require_state_boundary() {
  if (( EUID == 0 )); then
    require_safe_dir "$STATE_ROOT" 700
    require_safe_file "$LOCK_FILE" 600 0 0
  else
    [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] || die "Required fixed directory is missing or unsafe: $STATE_ROOT"
    [[ "$(/usr/bin/stat -c '%a:%u:%g' -- "$STATE_ROOT")" == "700:$STATE_UID:$STATE_GID" ]] \
      || die "Required fixed directory has unsafe metadata: $STATE_ROOT"
    require_safe_file "$LOCK_FILE" 600 "$STATE_UID" "$STATE_GID"
  fi
  require_safe_file "$TARGET" 640 "$TARGET_UID" "$TARGET_GID"
  require_executable "$NODE_BIN"
}

assert_attempt() {
  [[ "$1" =~ $ATTEMPT_PATTERN ]] || die 'Invalid production API environment attempt id.' 2
}

read_marker() {
  local file="$1"
  [[ -e "$file" ]] || return 1
  require_safe_file "$file" 600 "$STATE_UID" "$STATE_GID"
  IFS=$'\t' read -r MARKER_ATTEMPT MARKER_STATE <"$file" || true
  [[ -n "${MARKER_ATTEMPT:-}" && -n "${MARKER_STATE:-}" ]] || die "Production API environment state marker is malformed: $file"
  [[ "$MARKER_ATTEMPT" =~ $ATTEMPT_PATTERN ]] || die "Production API environment state marker has an invalid attempt id: $file"
  [[ "$MARKER_STATE" == 'committed' || "$MARKER_STATE" == 'rolled-back' ]] \
    || die "Production API environment state marker has an invalid terminal state: $file"
}

write_marker() {
  local destination="$1" attempt="$2" state="$3" temporary="$STATE_ROOT/.last.tmp"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || /bin/rm -f -- "$temporary"
  ( umask 077; printf '%s\t%s\n' "$attempt" "$state" >"$temporary" )
  /bin/chmod 0600 "$temporary"
  if (( EUID == 0 )); then /bin/chown root:root "$temporary"; fi
  /bin/mv -f -- "$temporary" "$destination"
}

remove_pending() {
  [[ ! -e "$PENDING_DIR" && ! -L "$PENDING_DIR" ]] && return 0
  [[ -d "$PENDING_DIR" && ! -L "$PENDING_DIR" ]] || die "Pending production API environment state is unsafe: $PENDING_DIR"
  /bin/rm -f -- \
    "$PENDING_DIR/attempt" \
    "$PENDING_DIR/backup" \
    "$PENDING_DIR/candidate" \
    "$PENDING_DIR/target.new"
  /bin/rmdir -- "$PENDING_DIR"
}

read_candidate() {
  local destination="$1"
  ( umask 077; /usr/bin/head -c 16385 >"$destination" )
  /bin/chmod 0600 "$destination"
  if (( EUID == 0 )); then /bin/chown root:root "$destination"; fi
  [[ "$(/usr/bin/stat -c '%s' -- "$destination")" -le 16384 ]] || die 'Candidate production API DSN is too large.'
}

validate_and_render() {
  local current="$1" candidate="$2" output="$3"
  "$NODE_BIN" - validate "$current" "$candidate" "$output" <<'NODE'
const fs = require("node:fs");
const [mode, currentPath, candidatePath, outputPath] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function candidateValue(file) {
  let value = fs.readFileSync(file, "utf8");
  if (value.endsWith("\n")) value = value.slice(0, -1);
  if (value.endsWith("\r")) value = value.slice(0, -1);
  if (!value || /[\r\n\0]/.test(value)) fail("Candidate production API DSN must be exactly one non-empty line.");
  return value;
}

function envDatabaseUrl(contents) {
  const lines = contents.split("\n");
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*(?:export\s+)?BRAI_DATABASE_URL\s*=(.*)$/);
    if (match) matches.push({ index, value: parseEnvValue(match[1]) });
  }
  if (matches.length !== 1) fail("Production API env must contain exactly one BRAI_DATABASE_URL.");
  return { lines, match: matches[0] };
}

function parseEnvValue(value) {
  const trimmed = String(value).trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("'\\''", "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  return trimmed;
}

function postgresUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be a valid Postgres URL.`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") fail(`${label} must use the Postgres protocol.`);
  let password;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    fail(`${label} password encoding is invalid.`);
  }
  if (!password) fail(`${label} must contain a non-empty password.`);
  return url;
}

function decodedUsername(url) {
  try {
    return decodeURIComponent(url.username);
  } catch {
    fail("Candidate production API DSN username encoding is invalid.");
  }
}

function decodedDatabase(url, label) {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    fail(`${label} database encoding is invalid.`);
  }
}

function decodedFragment(url, label) {
  try {
    return decodeURIComponent(url.hash);
  } catch {
    fail(`${label} fragment encoding is invalid.`);
  }
}

function searchPath(url, label) {
  const values = [];
  for (const [key, value] of url.searchParams) {
    if (key === "search_path") values.push(value);
    for (const match of value.matchAll(/(?:^|\s|;)search_path=([^\s;]+)/g)) values.push(match[1]);
  }
  if (values.length !== 1 || !values[0]) fail(`${label} must contain exactly one decoded search_path.`);
  return values[0];
}

function queryParameterMultiset(url) {
  const compareText = (left, right) => (left === right ? 0 : left < right ? -1 : 1);
  return [...url.searchParams]
    .map(([key, value]) => [key, value])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      compareText(leftKey, rightKey) || compareText(leftValue, rightValue)
    ));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

if (mode !== "validate") fail("Unsupported production API environment validation mode.");
const currentContents = fs.readFileSync(currentPath, "utf8");
const current = envDatabaseUrl(currentContents);
const candidate = candidateValue(candidatePath);
if (/brightos/i.test(candidate) || /brightos/i.test(current.match.value)) {
  fail("Production API DSNs must not reference legacy BrightOS tenants.");
}
const currentUrl = postgresUrl(current.match.value, "Current production API DSN");
const candidateUrl = postgresUrl(candidate, "Candidate production API DSN");
if (decodedUsername(candidateUrl) !== "brai_api.brai-prod") {
  fail("Candidate production API DSN must use the exact brai_api.brai-prod role.");
}
if (
  candidateUrl.protocol !== currentUrl.protocol
  || candidateUrl.hostname !== currentUrl.hostname
  || candidateUrl.port !== currentUrl.port
  || decodedDatabase(candidateUrl, "Candidate production API DSN") !== decodedDatabase(currentUrl, "Current production API DSN")
  || decodedFragment(candidateUrl, "Candidate production API DSN") !== decodedFragment(currentUrl, "Current production API DSN")
  || searchPath(candidateUrl, "Candidate production API DSN") !== searchPath(currentUrl, "Current production API DSN")
  || JSON.stringify(queryParameterMultiset(candidateUrl)) !== JSON.stringify(queryParameterMultiset(currentUrl))
) {
  fail("Candidate production API DSN must preserve protocol, host, port, database, fragment, search_path, and the decoded query parameter multiset.");
}
current.lines[current.match.index] = `BRAI_DATABASE_URL=${shellQuote(candidate)}`;
fs.writeFileSync(outputPath, current.lines.join("\n"), { mode: 0o600 });
NODE
}

assert_candidate_matches() {
  local target="$1" candidate="$2"
  "$NODE_BIN" - compare "$target" "$candidate" <<'NODE'
const fs = require("node:fs");
const [mode, targetPath, candidatePath] = process.argv.slice(2);
function fail(message) { console.error(message); process.exit(1); }
function parseEnvValue(value) {
  const trimmed = String(value).trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("'\\''", "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  return trimmed;
}
function candidateValue(file) {
  let value = fs.readFileSync(file, "utf8");
  if (value.endsWith("\n")) value = value.slice(0, -1);
  if (value.endsWith("\r")) value = value.slice(0, -1);
  if (!value || /[\r\n\0]/.test(value)) fail("Candidate production API DSN must be exactly one non-empty line.");
  return value;
}
if (mode !== "compare") fail("Unsupported production API environment comparison mode.");
const matches = fs.readFileSync(targetPath, "utf8")
  .split("\n")
  .map((line) => line.match(/^\s*(?:export\s+)?BRAI_DATABASE_URL\s*=(.*)$/))
  .filter(Boolean);
if (matches.length !== 1) fail("Production API env must contain exactly one BRAI_DATABASE_URL.");
if (parseEnvValue(matches[0][1]) !== candidateValue(candidatePath)) {
  fail("Production API environment attempt does not match the staged candidate.");
}
NODE
}

prepare_target_file() {
  local file="$1"
  /bin/chmod 0640 "$file"
  if (( EUID == 0 )); then /bin/chown "root:$TARGET_GID" "$file"; fi
}

stage() (
  local attempt="$1" incoming="$STATE_ROOT/.incoming"
  # Invoked indirectly by the EXIT trap below.
  # shellcheck disable=SC2329
  cleanup_stage() {
    /bin/rm -f -- "$incoming"
    if [[ -d "$PENDING_DIR" && ! -L "$PENDING_DIR" ]]; then
      /bin/rm -f -- \
        "$PENDING_DIR/attempt" \
        "$PENDING_DIR/backup" \
        "$PENDING_DIR/candidate" \
        "$PENDING_DIR/target.new"
      /bin/rmdir -- "$PENDING_DIR" 2>/dev/null || true
    fi
  }
  [[ ! -e "$incoming" && ! -L "$incoming" ]] || /bin/rm -f -- "$incoming"
  trap cleanup_stage EXIT
  read_candidate "$incoming"

  if [[ -e "$ACTIVE_DIR" || -L "$ACTIVE_DIR" ]]; then
    [[ -d "$ACTIVE_DIR" && ! -L "$ACTIVE_DIR" ]] || die "Active production API environment state is unsafe: $ACTIVE_DIR"
    [[ "$(/usr/bin/stat -c '%a:%u:%g' -- "$ACTIVE_DIR")" == "700:$STATE_UID:$STATE_GID" ]] \
      || die "Active production API environment state has unsafe metadata: $ACTIVE_DIR"
    require_safe_file "$ACTIVE_DIR/attempt" 600 "$STATE_UID" "$STATE_GID"
    [[ "$(<"$ACTIVE_DIR/attempt")" == "$attempt" ]] || die 'A different production API environment attempt is already active.'
    if read_marker "$LAST_FILE" && [[ "$MARKER_ATTEMPT" == "$attempt" ]]; then
      die 'Production API environment attempt has already reached a terminal state.'
    fi
    require_safe_file "$ACTIVE_DIR/candidate" 600 "$STATE_UID" "$STATE_GID"
    /usr/bin/cmp -s -- "$incoming" "$ACTIVE_DIR/candidate" \
      || die 'Production API environment attempt does not match the staged candidate.'
    if [[ -e "$ACTIVE_DIR/target.new" || -L "$ACTIVE_DIR/target.new" ]]; then
      require_safe_file "$ACTIVE_DIR/target.new" 640 "$TARGET_UID" "$TARGET_GID"
      assert_candidate_matches "$ACTIVE_DIR/target.new" "$incoming"
      /bin/mv -f -- "$ACTIVE_DIR/target.new" "$TARGET"
    else
      assert_candidate_matches "$TARGET" "$incoming"
    fi
    /bin/rm -f -- "$incoming"
    return 0
  fi

  if read_marker "$LAST_FILE"; then
    [[ "$MARKER_ATTEMPT" != "$attempt" ]] || die 'Production API environment attempt id has already reached a terminal state.'
  fi
  remove_pending
  /bin/mkdir -- "$PENDING_DIR"
  /bin/chmod 0700 "$PENDING_DIR"
  if (( EUID == 0 )); then /bin/chown root:root "$PENDING_DIR"; fi
  ( umask 077; printf '%s\n' "$attempt" >"$PENDING_DIR/attempt" )
  /bin/chmod 0600 "$PENDING_DIR/attempt"
  /bin/cp -- "$TARGET" "$PENDING_DIR/backup"
  /bin/chmod 0600 "$PENDING_DIR/backup"
  /bin/mv -- "$incoming" "$PENDING_DIR/candidate"
  validate_and_render "$TARGET" "$PENDING_DIR/candidate" "$PENDING_DIR/target.new"
  prepare_target_file "$PENDING_DIR/target.new"
  if (( EUID == 0 )); then
    /bin/chown root:root "$PENDING_DIR/attempt" "$PENDING_DIR/backup" "$PENDING_DIR/candidate"
  fi
  /bin/mv -- "$PENDING_DIR" "$ACTIVE_DIR"
  /bin/mv -f -- "$ACTIVE_DIR/target.new" "$TARGET"
)

rollback() {
  local attempt="$1"
  if [[ ! -e "$ACTIVE_DIR" && ! -L "$ACTIVE_DIR" ]]; then
    read_marker "$LAST_FILE" || die 'No production API environment attempt is available for rollback.'
    [[ "$MARKER_ATTEMPT" == "$attempt" && "$MARKER_STATE" == 'rolled-back' ]] \
      || die 'Production API environment rollback attempt does not match terminal state.'
    return 0
  fi
  [[ -d "$ACTIVE_DIR" && ! -L "$ACTIVE_DIR" ]] || die "Active production API environment state is unsafe: $ACTIVE_DIR"
  [[ "$(/usr/bin/stat -c '%a:%u:%g' -- "$ACTIVE_DIR")" == "700:$STATE_UID:$STATE_GID" ]] \
    || die "Active production API environment state has unsafe metadata: $ACTIVE_DIR"
  require_safe_file "$ACTIVE_DIR/attempt" 600 "$STATE_UID" "$STATE_GID"
  [[ "$(<"$ACTIVE_DIR/attempt")" == "$attempt" ]] || die 'Production API environment rollback attempt does not match active state.'
  if read_marker "$LAST_FILE" && [[ "$MARKER_ATTEMPT" == "$attempt" ]]; then
    [[ "$MARKER_STATE" == 'rolled-back' ]] \
      || die 'Production API environment rollback attempt conflicts with committed terminal state.'
    /bin/rm -f -- "$ACTIVE_DIR/attempt" "$ACTIVE_DIR/backup" "$ACTIVE_DIR/candidate" "$ACTIVE_DIR/target.new"
    /bin/rmdir -- "$ACTIVE_DIR"
    return 0
  fi
  require_safe_file "$ACTIVE_DIR/backup" 600 "$STATE_UID" "$STATE_GID"
  /bin/cp -- "$ACTIVE_DIR/backup" "$ACTIVE_DIR/restore"
  prepare_target_file "$ACTIVE_DIR/restore"
  /bin/mv -f -- "$ACTIVE_DIR/restore" "$TARGET"
  write_marker "$LAST_FILE" "$attempt" rolled-back
  /bin/rm -f -- "$ACTIVE_DIR/attempt" "$ACTIVE_DIR/backup" "$ACTIVE_DIR/candidate" "$ACTIVE_DIR/target.new"
  /bin/rmdir -- "$ACTIVE_DIR"
}

commit() {
  local attempt="$1"
  if [[ ! -e "$ACTIVE_DIR" && ! -L "$ACTIVE_DIR" ]]; then
    read_marker "$LAST_FILE" || die 'No production API environment attempt is available for commit.'
    [[ "$MARKER_ATTEMPT" == "$attempt" && "$MARKER_STATE" == 'committed' ]] \
      || die 'Production API environment commit attempt does not match terminal state.'
    return 0
  fi
  [[ -d "$ACTIVE_DIR" && ! -L "$ACTIVE_DIR" ]] || die "Active production API environment state is unsafe: $ACTIVE_DIR"
  [[ "$(/usr/bin/stat -c '%a:%u:%g' -- "$ACTIVE_DIR")" == "700:$STATE_UID:$STATE_GID" ]] \
    || die "Active production API environment state has unsafe metadata: $ACTIVE_DIR"
  require_safe_file "$ACTIVE_DIR/attempt" 600 "$STATE_UID" "$STATE_GID"
  [[ "$(<"$ACTIVE_DIR/attempt")" == "$attempt" ]] || die 'Production API environment commit attempt does not match active state.'
  if read_marker "$LAST_FILE" && [[ "$MARKER_ATTEMPT" == "$attempt" ]]; then
    [[ "$MARKER_STATE" == 'committed' ]] \
      || die 'Production API environment commit attempt conflicts with rolled-back terminal state.'
    /bin/rm -f -- "$ACTIVE_DIR/attempt" "$ACTIVE_DIR/backup" "$ACTIVE_DIR/candidate" "$ACTIVE_DIR/target.new"
    /bin/rmdir -- "$ACTIVE_DIR"
    return 0
  fi
  [[ ! -e "$ACTIVE_DIR/target.new" && ! -L "$ACTIVE_DIR/target.new" ]] \
    || die 'Production API environment stage is incomplete; commit is forbidden.'
  write_marker "$LAST_FILE" "$attempt" committed
  /bin/rm -f -- "$ACTIVE_DIR/attempt" "$ACTIVE_DIR/backup" "$ACTIVE_DIR/candidate" "$ACTIVE_DIR/target.new"
  /bin/rmdir -- "$ACTIVE_DIR"
}

main() {
  configure_paths
  [[ $# -eq 2 ]] || usage
  local action="$1" attempt="$2"
  [[ "$action" == stage || "$action" == rollback || "$action" == commit ]] || usage
  assert_attempt "$attempt"
  require_state_boundary
  exec 9<>"$LOCK_FILE"
  /usr/bin/flock -x 9
  case "$action" in
    stage) stage "$attempt" ;;
    rollback) rollback "$attempt" ;;
    commit) commit "$attempt" ;;
  esac
  exec 9>&-
  printf '{"ok":true,"action":"%s","attempt":"%s"}\n' "$action" "$attempt"
}

main "$@"
