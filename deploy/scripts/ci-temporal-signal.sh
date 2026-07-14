#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="services/brai_temporal"
REQUIRED="${BRAI_TEMPORAL_REQUIRED:-false}"
KEY_FILE=""
TUNNEL_PID=""
WORKER_PID=""
WORKER_LOG=""
EXACT_BRANCH=""
EXACT_SHA=""
EXACT_DISPATCH_COMPLETE="false"
CLEANUP_TEMPORAL_ADDRESS=""

finish() {
  local code="$1"
  if [[ "$code" -ne 0 && "$REQUIRED" != "true" ]]; then
    echo "Temporal signal skipped/failed; continuing because BRAI_TEMPORAL_REQUIRED is not true." >&2
    exit 0
  fi
  exit "$code"
}

run() {
  need BRAI_DEPLOY_HOST || return 1
  need BRAI_DEPLOY_USER || return 1
  need BRAI_DEPLOY_SSH_KEY || return 1

  local ssh_port="${BRAI_DEPLOY_SSH_PORT:-22}"
  local local_port="${BRAI_TEMPORAL_LOCAL_PORT:-7233}"
  local remote_port="${BRAI_TEMPORAL_REMOTE_PORT:-7233}"
  KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-temporal-key.XXXXXX")"
  CLEANUP_TEMPORAL_ADDRESS="127.0.0.1:$local_port"

  cleanup() {
    if [[ -n "${WORKER_PID:-}" && "$EXACT_DISPATCH_COMPLETE" != "true" && -n "$EXACT_BRANCH" && -n "$EXACT_SHA" ]]; then
      if TEMPORAL_ADDRESS="$CLEANUP_TEMPORAL_ADDRESS" \
        npm --prefix "$SERVICE_DIR" run signal -- cancel-preview-deploy \
          --branch "$EXACT_BRANCH" --sha "$EXACT_SHA" >/dev/null 2>&1; then
        sleep 1
      fi
    fi
    if [[ -n "${WORKER_PID:-}" ]]; then
      kill "$WORKER_PID" >/dev/null 2>&1 || true
      wait "$WORKER_PID" >/dev/null 2>&1 || true
    fi
    if [[ -n "${TUNNEL_PID:-}" ]]; then
      kill "$TUNNEL_PID" >/dev/null 2>&1 || true
      wait "$TUNNEL_PID" >/dev/null 2>&1 || true
    fi
    if [[ -n "${WORKER_LOG:-}" ]]; then
      rm -f "$WORKER_LOG"
    fi
    rm -f "${KEY_FILE:-}"
  }
  trap cleanup EXIT

  printf '%s\n' "$BRAI_DEPLOY_SSH_KEY" >"$KEY_FILE"
  chmod 600 "$KEY_FILE"

  ssh \
    -i "$KEY_FILE" \
    -p "$ssh_port" \
    -N \
    -L "127.0.0.1:${local_port}:127.0.0.1:${remote_port}" \
    -o ExitOnForwardFailure=yes \
    -o StrictHostKeyChecking=accept-new \
    "$BRAI_DEPLOY_USER@$BRAI_DEPLOY_HOST" &
  TUNNEL_PID="$!"

  for _ in {1..25}; do
    if (echo >"/dev/tcp/127.0.0.1/$local_port") >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done

  if [[ ! -d "$SERVICE_DIR/node_modules/@temporalio/client" ]]; then
    npm --prefix "$SERVICE_DIR" ci
  fi

  if [[ "${1:-}" == "dispatch-preview-deploy" ]]; then
    local sha=""
    local branch=""
    local index
    local arguments=("$@")
    for ((index = 0; index < ${#arguments[@]}; index += 1)); do
      if [[ "${arguments[$index]}" == "--sha" ]]; then
        sha="${arguments[$((index + 1))]:-}"
      elif [[ "${arguments[$index]}" == "--branch" ]]; then
        branch="${arguments[$((index + 1))]:-}"
      fi
    done
    if ! [[ "$sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
      echo "dispatch-preview-deploy requires an exact 40-character --sha" >&2
      return 1
    fi
    if ! [[ "$branch" =~ ^codex/[A-Za-z0-9._-]+$ ]]; then
      echo "dispatch-preview-deploy requires a safe codex/* --branch" >&2
      return 1
    fi
    EXACT_BRANCH="$branch"
    EXACT_SHA="$sha"
    local task_queue="brai-preview-branch-$sha"
    WORKER_LOG="$(mktemp "${TMPDIR:-/tmp}/brai-temporal-branch-worker.XXXXXX")"
    TEMPORAL_ADDRESS="127.0.0.1:$local_port" \
      BRAI_TEMPORAL_WORKER_TASK_QUEUES="$task_queue" \
      npm --prefix "$SERVICE_DIR" start >"$WORKER_LOG" 2>&1 &
    WORKER_PID="$!"
    for _ in {1..50}; do
      if ! kill -0 "$WORKER_PID" >/dev/null 2>&1; then
        echo "Exact-SHA Temporal worker stopped before dispatch." >&2
        tail -n 40 "$WORKER_LOG" >&2 || true
        return 1
      fi
      if grep -q "Brai Temporal worker connected" "$WORKER_LOG"; then
        break
      fi
      sleep 0.2
    done
    if ! grep -q "Brai Temporal worker connected" "$WORKER_LOG"; then
      echo "Exact-SHA Temporal worker did not become ready." >&2
      tail -n 40 "$WORKER_LOG" >&2 || true
      return 1
    fi
    if ! TEMPORAL_ADDRESS="127.0.0.1:$local_port" \
      BRAI_TEMPORAL_PREVIEW_TASK_QUEUE="$task_queue" \
      BRAI_TEMPORAL_EXACT_SHA_PREVIEW="true" \
      npm --prefix "$SERVICE_DIR" run signal -- "$@"; then
      return 1
    fi
    EXACT_DISPATCH_COMPLETE="true"
    return
  fi

  TEMPORAL_ADDRESS="127.0.0.1:$local_port" npm --prefix "$SERVICE_DIR" run signal -- "$@"
}

need() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required" >&2
    return 1
  fi
}

run "$@" || finish "$?"
