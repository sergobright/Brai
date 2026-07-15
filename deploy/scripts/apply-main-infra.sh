#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
TARGET="${2:-}"
ROOT="${BRAI_MAIN_ROOT:-/srv/projects/brai}"
INVENTORY="${BRAI_ANSIBLE_INVENTORY:-}"

if [[ "$MODE" != "--check" && "$MODE" != "--apply" ]] || [[ "$TARGET" != "brai-caddy" && "$TARGET" != "brai-vault" ]]; then
  echo "usage: apply-main-infra.sh --check|--apply brai-caddy|brai-vault" >&2
  exit 2
fi
GIT=(git -c "safe.directory=$ROOT" -C "$ROOT")
if [[ "$("${GIT[@]}" branch --show-current)" != "main" ]] || [[ -n "$("${GIT[@]}" status --porcelain)" ]]; then
  echo "Targeted infra apply requires a clean canonical main checkout." >&2
  exit 1
fi
if [[ "$("${GIT[@]}" rev-parse HEAD)" != "$("${GIT[@]}" rev-parse origin/main)" ]]; then
  echo "Canonical main must match origin/main before targeted infra apply." >&2
  exit 1
fi
if [[ -z "$INVENTORY" ]]; then
  INVENTORY="$(mktemp "${TMPDIR:-/tmp}/brai-ansible-inventory.XXXXXX")"
  trap 'rm -f "$INVENTORY"' EXIT
  printf '[brai]\nlocalhost ansible_connection=local\n' >"$INVENTORY"
elif [[ ! -r "$INVENTORY" ]]; then
  echo "Ansible inventory is missing: $INVENTORY" >&2
  exit 1
fi
ANSIBLE_ARGS=(-i "$INVENTORY")

cd "$ROOT"
LIST_HOSTS="$(/srv/opt/ansible/bin/ansible-playbook "${ANSIBLE_ARGS[@]}" deploy/ansible/brai.yml --tags "$TARGET" --list-hosts 2>&1)"
if ! grep -Eq 'hosts \([1-9][0-9]*\):' <<<"$LIST_HOSTS"; then
  echo "Targeted infra apply matched no Ansible hosts." >&2
  exit 1
fi
/srv/opt/ansible/bin/ansible-playbook "${ANSIBLE_ARGS[@]}" deploy/ansible/brai.yml --tags "$TARGET" --check --diff
if [[ "$MODE" == "--apply" ]]; then
  /srv/opt/ansible/bin/ansible-playbook "${ANSIBLE_ARGS[@]}" deploy/ansible/brai.yml --tags "$TARGET"
fi
