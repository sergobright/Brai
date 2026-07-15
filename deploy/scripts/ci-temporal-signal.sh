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
CLIENT_PID=""
REQUESTED_EXIT_CODE=""
CLEANING_UP="false"

finish() {
  local code="$1"
  if [[ "$code" -ne 0 && "$REQUIRED" != "true" ]]; then
    echo "Temporal signal skipped/failed; continuing because BRAI_TEMPORAL_REQUIRED is not true." >&2
    exit 0
  fi
  exit "$code"
}

run_temporal_client() {
  node "$SERVICE_DIR/src/client.mjs" "$@" &
  CLIENT_PID="$!"
  local pid="$CLIENT_PID"
  local status
  while true; do
    if wait "$pid"; then
      status=0
    else
      status="$?"
    fi
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      break
    fi
  done
  CLIENT_PID=""
  return "$status"
}

stop_local_resources() {
  if [[ -n "${WORKER_PID:-}" ]]; then
    local worker_pid="$WORKER_PID"
    kill -TERM "$worker_pid" >/dev/null 2>&1 || true
    while kill -0 "$worker_pid" >/dev/null 2>&1; do
      wait "$worker_pid" >/dev/null 2>&1 || true
    done
    WORKER_PID=""
  fi
  if [[ -n "${TUNNEL_PID:-}" ]]; then
    local tunnel_pid="$TUNNEL_PID"
    kill -TERM "$tunnel_pid" >/dev/null 2>&1 || true
    while kill -0 "$tunnel_pid" >/dev/null 2>&1; do
      wait "$tunnel_pid" >/dev/null 2>&1 || true
    done
    TUNNEL_PID=""
  fi
  if [[ -n "${WORKER_LOG:-}" ]]; then
    rm -f "$WORKER_LOG"
    WORKER_LOG=""
  fi
  rm -f "${KEY_FILE:-}"
  KEY_FILE=""
}

forward_signal() {
  local signal="$1"
  local exit_code="$2"
  if [[ -n "$REQUESTED_EXIT_CODE" || "$CLEANING_UP" == "true" ]]; then
    if [[ -z "$REQUESTED_EXIT_CODE" ]]; then
      REQUESTED_EXIT_CODE="$exit_code"
    fi
    echo "Temporal cleanup is already in progress; coalescing $signal until cancellation and process cleanup finish." >&2
    trap '' HUP INT TERM
    return
  fi
  REQUESTED_EXIT_CODE="$exit_code"
  trap '' HUP INT TERM
  if [[ -n "${CLIENT_PID:-}" ]]; then
    local client_pid="$CLIENT_PID"
    kill -s "$signal" "$client_pid" >/dev/null 2>&1 || true
    while kill -0 "$client_pid" >/dev/null 2>&1; do
      wait "$client_pid" >/dev/null 2>&1 || true
    done
    CLIENT_PID=""
  fi
  exit "$exit_code"
}

run() {
  if [[ "${BRAI_TEMPORAL_DIRECT:-false}" == "true" ]]; then
    if [[ "${1:-}" != "query-preview-deploy" ]]; then
      echo "BRAI_TEMPORAL_DIRECT only permits read-only query-preview-deploy." >&2
      return 1
    fi
    TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-127.0.0.1:7233}" run_temporal_client "$@"
    return
  fi

  need BRAI_DEPLOY_HOST || return 1
  need BRAI_DEPLOY_USER || return 1
  need BRAI_DEPLOY_SSH_KEY || return 1

  local ssh_port="${BRAI_DEPLOY_SSH_PORT:-22}"
  local local_port="${BRAI_TEMPORAL_LOCAL_PORT:-7233}"
  local remote_port="${BRAI_TEMPORAL_REMOTE_PORT:-7233}"
  KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/brai-temporal-key.XXXXXX")"
  CLEANUP_TEMPORAL_ADDRESS="127.0.0.1:$local_port"

  cleanup() {
    local original_status="$?"
    CLEANING_UP="true"
    trap - EXIT
    if [[ -n "${WORKER_PID:-}" && "$EXACT_DISPATCH_COMPLETE" != "true" && -n "$EXACT_BRANCH" && -n "$EXACT_SHA" ]]; then
      if ! TEMPORAL_ADDRESS="$CLEANUP_TEMPORAL_ADDRESS" \
        run_temporal_client cancel-preview-deploy \
          --branch "$EXACT_BRANCH" --sha "$EXACT_SHA"; then
        echo "BLOCKER: Temporal cancellation for exact Preview $EXACT_BRANCH@$EXACT_SHA did not reach a terminal result. The local worker will shut down gracefully; inspect Temporal inventory before retrying delivery." >&2
      fi
    fi
    stop_local_resources
    return "$original_status"
  }
  trap cleanup EXIT
  trap 'forward_signal HUP 129' HUP
  trap 'forward_signal INT 130' INT
  trap 'forward_signal TERM 143' TERM

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
      node "$SERVICE_DIR/src/worker.mjs" >"$WORKER_LOG" 2>&1 &
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
      run_temporal_client "$@"; then
      return 1
    fi
    EXACT_DISPATCH_COMPLETE="true"
    return
  fi

  TEMPORAL_ADDRESS="127.0.0.1:$local_port" run_temporal_client "$@"
}

need() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required" >&2
    return 1
  fi
}

run "$@" || finish "$?"
