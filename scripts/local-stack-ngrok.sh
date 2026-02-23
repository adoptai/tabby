#!/usr/bin/env bash
set -euo pipefail

CMD="${1:-up}"

NAMESPACE="${LOCAL_NAMESPACE:-browser-hitl}"
RELEASE="${LOCAL_RELEASE:-browser-hitl}"
API_SERVICE="${LOCAL_API_SERVICE:-${RELEASE}-api}"
LOCAL_API_PORT="${LOCAL_API_PORT:-18080}"
REMOTE_API_PORT="${REMOTE_API_PORT:-8080}"
NGROK_API_ADDR="${NGROK_API_ADDR:-127.0.0.1:4040}"
STATE_DIR="${LOCAL_STATE_DIR:-/tmp/browser-hitl-local}"
APPLY_STREAM_ENV="${LOCAL_APPLY_STREAM_ENV:-false}"

PF_LOG="${STATE_DIR}/api-port-forward.log"
NGROK_LOG="${STATE_DIR}/ngrok.log"
PF_PID_FILE="${STATE_DIR}/api-port-forward.pid"
NGROK_PID_FILE="${STATE_DIR}/ngrok.pid"
NGROK_TUNNELS_JSON="${STATE_DIR}/ngrok-tunnels.json"
NGROK_URL_FILE="${STATE_DIR}/ngrok-public-url.txt"
NGROK_HOST_FILE="${STATE_DIR}/ngrok-public-host.txt"

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
  local pid_file="$1"
  if [[ -f "${pid_file}" ]]; then
    tr -d ' \n\r\t' < "${pid_file}"
  fi
}

wait_for_local_api() {
  local url="http://127.0.0.1:${LOCAL_API_PORT}/metrics"
  for _ in $(seq 1 40); do
    if curl -fsS -m 2 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_ngrok_upstream() {
  local public_url
  public_url="$(cat "${NGROK_URL_FILE}" 2>/dev/null || true)"
  if [[ -z "${public_url}" ]]; then
    return 1
  fi

  local metrics_url="${public_url%/}/metrics"
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 "${metrics_url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_port_forward() {
  if wait_for_local_api; then
    echo "Local API already reachable on http://127.0.0.1:${LOCAL_API_PORT}"
    return 0
  fi

  local pid
  pid="$(read_pid "${PF_PID_FILE}")"
  if is_running "${pid}"; then
    echo "API port-forward already running (pid=${pid})"
  else
    echo "Starting API port-forward: svc/${API_SERVICE} ${LOCAL_API_PORT}:${REMOTE_API_PORT}"
    nohup kubectl -n "${NAMESPACE}" port-forward "svc/${API_SERVICE}" "${LOCAL_API_PORT}:${REMOTE_API_PORT}" >"${PF_LOG}" 2>&1 &
    echo "$!" > "${PF_PID_FILE}"
  fi

  if ! wait_for_local_api; then
    echo "ERROR: API not reachable on localhost:${LOCAL_API_PORT}" >&2
    tail -n 40 "${PF_LOG}" >&2 || true
    exit 1
  fi
}

fetch_ngrok_url() {
  local tunnels_api="http://${NGROK_API_ADDR}/api/tunnels"
  curl -fsS -m 5 "${tunnels_api}" > "${NGROK_TUNNELS_JSON}"

  local url
  url="$(jq -r '.tunnels[] | select(.proto == "https") | .public_url' "${NGROK_TUNNELS_JSON}" | head -n 1)"
  if [[ -z "${url}" ]]; then
    url="$(jq -r '.tunnels[0].public_url // ""' "${NGROK_TUNNELS_JSON}")"
  fi

  if [[ -z "${url}" ]]; then
    echo "ERROR: ngrok started but no public tunnel URL found" >&2
    return 1
  fi

  local host="${url#https://}"
  host="${host#http://}"
  host="${host%%/*}"

  printf '%s\n' "${url}" > "${NGROK_URL_FILE}"
  printf '%s\n' "${host}" > "${NGROK_HOST_FILE}"
}

start_ngrok() {
  if curl -fsS -m 2 "http://${NGROK_API_ADDR}/api/tunnels" >/dev/null 2>&1; then
    echo "Reusing existing ngrok agent at ${NGROK_API_ADDR}"
    fetch_ngrok_url
    return 0
  fi

  local pid
  pid="$(read_pid "${NGROK_PID_FILE}")"
  if is_running "${pid}"; then
    echo "ngrok already running (pid=${pid})"
  else
    echo "Starting ngrok tunnel: http ${LOCAL_API_PORT}"
    nohup ngrok http "${LOCAL_API_PORT}" > "${NGROK_LOG}" 2>&1 &
    echo "$!" > "${NGROK_PID_FILE}"
  fi

  for _ in $(seq 1 40); do
    if curl -fsS -m 2 "http://${NGROK_API_ADDR}/api/tunnels" >/dev/null 2>&1; then
      fetch_ngrok_url
      return 0
    fi
    sleep 1
  done

  echo "ERROR: ngrok API not reachable at ${NGROK_API_ADDR}" >&2
  tail -n 60 "${NGROK_LOG}" >&2 || true
  exit 1
}

apply_stream_env() {
  local host
  host="$(cat "${NGROK_HOST_FILE}")"
  if [[ -z "${host}" ]]; then
    echo "ERROR: missing ngrok host in ${NGROK_HOST_FILE}" >&2
    exit 1
  fi

  echo "Applying API stream env: STREAM_HOST=${host}, STREAM_PROTOCOL=https, PUBLIC_BASE_URL=https://${host}"
  kubectl -n "${NAMESPACE}" set env "deployment/${RELEASE}-api" \
    STREAM_HOST="${host}" \
    STREAM_PROTOCOL=https \
    PUBLIC_BASE_URL="https://${host}" \
    >/dev/null
  kubectl -n "${NAMESPACE}" rollout status "deployment/${RELEASE}-api" --timeout=180s >/dev/null
}

print_summary() {
  local url host
  url="$(cat "${NGROK_URL_FILE}" 2>/dev/null || true)"
  host="$(cat "${NGROK_HOST_FILE}" 2>/dev/null || true)"

  echo ""
  echo "Local test tunnel ready"
  echo "  Namespace:      ${NAMESPACE}"
  echo "  API local:      http://127.0.0.1:${LOCAL_API_PORT}"
  echo "  ngrok URL:      ${url}"
  echo "  ngrok host:     ${host}"
  echo "  State dir:      ${STATE_DIR}"
  echo ""
  echo "Exports for test commands:"
  echo "  export API_URL=http://localhost:${LOCAL_API_PORT}"
  if [[ -n "${url}" ]]; then
    echo "  export LOCAL_NGROK_URL=${url}"
  fi
}

stop_process_from_pid_file() {
  local label="$1"
  local pid_file="$2"
  local pid
  pid="$(read_pid "${pid_file}")"
  if is_running "${pid}"; then
    echo "Stopping ${label} (pid=${pid})"
    kill "${pid}" >/dev/null 2>&1 || true
    sleep 1
    if is_running "${pid}"; then
      kill -9 "${pid}" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "${pid_file}"
}

status() {
  local pf_pid ngrok_pid
  pf_pid="$(read_pid "${PF_PID_FILE}")"
  ngrok_pid="$(read_pid "${NGROK_PID_FILE}")"

  echo "Local stack ngrok status"
  if is_running "${pf_pid}"; then
    echo "  API port-forward: running (pid=${pf_pid})"
  elif curl -fsS -m 2 "http://127.0.0.1:${LOCAL_API_PORT}/metrics" >/dev/null 2>&1; then
    echo "  API port-forward: reachable on localhost:${LOCAL_API_PORT} (external process)"
  else
    echo "  API port-forward: stopped"
  fi

  if is_running "${ngrok_pid}"; then
    echo "  ngrok:            running (pid=${ngrok_pid})"
  elif curl -fsS -m 2 "http://${NGROK_API_ADDR}/api/tunnels" >/dev/null 2>&1; then
    echo "  ngrok:            running (external process)"
  else
    echo "  ngrok:            stopped"
  fi

  if [[ -f "${NGROK_URL_FILE}" ]]; then
    echo "  ngrok URL:        $(cat "${NGROK_URL_FILE}")"
  fi
  if [[ -f "${NGROK_HOST_FILE}" ]]; then
    echo "  ngrok host:       $(cat "${NGROK_HOST_FILE}")"
  fi
}

url() {
  if [[ -f "${NGROK_URL_FILE}" ]]; then
    cat "${NGROK_URL_FILE}"
    return 0
  fi

  if curl -fsS -m 2 "http://${NGROK_API_ADDR}/api/tunnels" >/dev/null 2>&1; then
    fetch_ngrok_url
    cat "${NGROK_URL_FILE}"
    return 0
  fi

  echo "ERROR: ngrok URL not available; run '$0 up' first" >&2
  exit 1
}

up() {
  require_bin kubectl
  require_bin curl
  require_bin ngrok
  require_bin jq

  start_port_forward
  start_ngrok

  if [[ "${APPLY_STREAM_ENV}" == "true" ]]; then
    apply_stream_env

    # API rollout can invalidate an existing port-forward connection.
    # Re-establish it if local health dropped during env apply.
    if ! wait_for_local_api; then
      echo "API became unreachable after stream env rollout; restarting port-forward"
      stop_process_from_pid_file "API port-forward" "${PF_PID_FILE}"
      start_port_forward
    fi
  fi

  # Ensure the public tunnel is actually forwarding to a live local API.
  if ! wait_for_ngrok_upstream; then
    echo "ngrok upstream check failed; restarting API port-forward once"
    stop_process_from_pid_file "API port-forward" "${PF_PID_FILE}"
    start_port_forward
  fi

  if ! wait_for_ngrok_upstream; then
    echo "ERROR: ngrok tunnel is up but upstream API is not reachable." >&2
    tail -n 40 "${PF_LOG}" >&2 || true
    tail -n 40 "${NGROK_LOG}" >&2 || true
    exit 1
  fi

  print_summary
}

down() {
  stop_process_from_pid_file "ngrok" "${NGROK_PID_FILE}"
  stop_process_from_pid_file "API port-forward" "${PF_PID_FILE}"

  # Best-effort cleanup when pids were not recorded by this script.
  pkill -f "kubectl -n ${NAMESPACE} port-forward svc/${API_SERVICE} ${LOCAL_API_PORT}:${REMOTE_API_PORT}" >/dev/null 2>&1 || true
  pkill -f "ngrok http ${LOCAL_API_PORT}" >/dev/null 2>&1 || true

  rm -f "${NGROK_TUNNELS_JSON}" "${NGROK_URL_FILE}" "${NGROK_HOST_FILE}"
  echo "Local ngrok stack stopped."
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
  url)
    url
    ;;
  *)
    echo "Usage: $0 {up|down|status|url}" >&2
    exit 1
    ;;
esac
