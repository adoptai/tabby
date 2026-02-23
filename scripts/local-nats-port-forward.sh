#!/usr/bin/env bash
set -euo pipefail

CMD="${1:-up}"

NAMESPACE="${LOCAL_NAMESPACE:-browser-hitl}"
NATS_SERVICE="${LOCAL_NATS_SERVICE:-browser-hitl-nats}"
LOCAL_NATS_PORT="${LOCAL_NATS_PORT:-4222}"
REMOTE_NATS_PORT="${REMOTE_NATS_PORT:-4222}"
STATE_DIR="${LOCAL_STATE_DIR:-/tmp/browser-hitl-local}"

PID_FILE="${STATE_DIR}/nats-port-forward.pid"
LOG_FILE="${STATE_DIR}/nats-port-forward.log"

mkdir -p "${STATE_DIR}"

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required binary not found: $1" >&2
    exit 1
  }
}

is_running() {
  local pid="${1:-}"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

read_pid() {
  if [[ -f "${PID_FILE}" ]]; then
    tr -d ' \n\r\t' < "${PID_FILE}"
  fi
}

is_local_nats_reachable() {
  timeout 1 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/${LOCAL_NATS_PORT}" >/dev/null 2>&1
}

wait_for_nats() {
  for _ in $(seq 1 30); do
    if is_local_nats_reachable; then
      return 0
    fi
    sleep 1
  done
  return 1
}

up() {
  require_bin kubectl

  if is_local_nats_reachable; then
    echo "Local NATS already reachable on 127.0.0.1:${LOCAL_NATS_PORT}"
    return 0
  fi

  local pid
  pid="$(read_pid || true)"
  if is_running "${pid}"; then
    echo "NATS port-forward already running (pid=${pid})"
  else
    echo "Starting NATS port-forward: svc/${NATS_SERVICE} ${LOCAL_NATS_PORT}:${REMOTE_NATS_PORT}"
    nohup kubectl -n "${NAMESPACE}" port-forward "svc/${NATS_SERVICE}" \
      "${LOCAL_NATS_PORT}:${REMOTE_NATS_PORT}" > "${LOG_FILE}" 2>&1 &
    echo "$!" > "${PID_FILE}"
  fi

  if ! wait_for_nats; then
    echo "ERROR: local NATS did not become reachable on 127.0.0.1:${LOCAL_NATS_PORT}" >&2
    tail -n 80 "${LOG_FILE}" >&2 || true
    exit 1
  fi

  echo "NATS port-forward ready on 127.0.0.1:${LOCAL_NATS_PORT}"
}

down() {
  local pid
  pid="$(read_pid || true)"

  if is_running "${pid}"; then
    echo "Stopping NATS port-forward (pid=${pid})"
    kill "${pid}" >/dev/null 2>&1 || true
    sleep 1
    if is_running "${pid}"; then
      kill -9 "${pid}" >/dev/null 2>&1 || true
    fi
  fi

  # Best effort for unmanaged/older runs.
  pkill -f "kubectl -n ${NAMESPACE} port-forward svc/${NATS_SERVICE} ${LOCAL_NATS_PORT}:${REMOTE_NATS_PORT}" >/dev/null 2>&1 || true
  rm -f "${PID_FILE}"

  echo "NATS port-forward stopped."
}

status() {
  local pid
  pid="$(read_pid || true)"

  echo "Local NATS port-forward status"
  if is_running "${pid}"; then
    echo "  process: running (pid=${pid})"
  else
    echo "  process: stopped"
  fi

  if is_local_nats_reachable; then
    echo "  endpoint: reachable at 127.0.0.1:${LOCAL_NATS_PORT}"
  else
    echo "  endpoint: unreachable at 127.0.0.1:${LOCAL_NATS_PORT}"
  fi

  if [[ -f "${LOG_FILE}" ]]; then
    echo "  log: ${LOG_FILE}"
  fi
}

case "${CMD}" in
  up)
    up
    ;;
  down)
    down
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 {up|down|status}" >&2
    exit 1
    ;;
esac

