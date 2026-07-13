#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${BRAI_SUPAVISOR_CONTAINER:-supabase-pooler}"
SINCE="${1:-${BRAI_SUPAVISOR_DIAGNOSTICS_SINCE:-2h}}"
TAIL="${BRAI_SUPAVISOR_DIAGNOSTICS_TAIL:-1000}"
PATTERN='SCRAM|circuit breaker|too many authentication failures|auth_error'

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat >&2 <<USAGE
Usage: $0 [docker-logs-since]

Shows bounded Supavisor auth/SCRAM diagnostics without printing credentials.
Default since window: 2h. Override tail with BRAI_SUPAVISOR_DIAGNOSTICS_TAIL.
USAGE
  exit 0
fi

mapfile -t AUTH_LINES < <(docker logs --since "$SINCE" --tail "$TAIL" "$CONTAINER" 2>&1 | grep -Ei "$PATTERN" || true)

printf 'container=%s\n' "$CONTAINER"
printf 'since=%s\n' "$SINCE"
printf 'tail=%s\n' "$TAIL"
printf 'auth_events=%s\n' "${#AUTH_LINES[@]}"

if [[ "${#AUTH_LINES[@]}" -gt 0 ]]; then
  printf 'peer_ip_counts:\n'
  printf '%s\n' "${AUTH_LINES[@]}" |
    awk 'match($0, /peer_ip=([^ ]+)/, m) { counts[m[1]]++ } END { for (ip in counts) printf "  %s %s\n", ip, counts[ip] }' |
    sort
  printf 'recent_events:\n'
  printf '%s\n' "${AUTH_LINES[@]}" | tail -20 | sed 's/^/  /'
fi

printf 'pooler_connections:\n'
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  sudo -n ss -Htnp state established '( sport = :55432 or sport = :56543 or dport = :55432 or dport = :56543 )' || true
else
  ss -Htnp state established '( sport = :55432 or sport = :56543 or dport = :55432 or dport = :56543 )' || true
fi
