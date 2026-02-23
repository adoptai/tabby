#!/usr/bin/env bash
set -euo pipefail

CMD="${1:-up}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${LOCAL_ENV_FILE:-${ROOT_DIR}/.env.local}"
STATE_DIR="${LOCAL_STATE_DIR:-/tmp/browser-hitl-local}"
PID_FILE="${STATE_DIR}/slack-soft-bridge.pid"
LOG_FILE="${STATE_DIR}/slack-soft-bridge.log"

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

load_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "ERROR: env file not found: ${ENV_FILE}" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a

  if [[ -z "${API_BASE_URL:-}" && -n "${API_URL:-}" ]]; then
    export API_BASE_URL="${API_URL%/}"
  fi
}

validate_env() {
  local missing=()
  [[ -n "${SLACK_BOT_TOKEN:-}" ]] || missing+=("SLACK_BOT_TOKEN")
  [[ -n "${SLACK_CHANNEL:-}" ]] || missing+=("SLACK_CHANNEL")
  [[ -n "${NATS_URL:-}" ]] || missing+=("NATS_URL")
  [[ -n "${API_BASE_URL:-}" ]] || missing+=("API_BASE_URL (or API_URL)")

  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "ERROR: missing required variables in ${ENV_FILE}: ${missing[*]}" >&2
    exit 1
  fi
}

wait_for_startup() {
  for _ in $(seq 1 30); do
    if [[ -f "${LOG_FILE}" ]] \
      && grep -qE "connected to NATS|Soft HITL bridge online|HITL bridge is online" "${LOG_FILE}"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

up() {
  require_bin pnpm
  require_bin node
  require_bin grep

  load_env_file
  validate_env

  local pid
  pid="$(read_pid || true)"
  if is_running "${pid}"; then
    echo "Slack soft bridge already running (pid=${pid})"
    return 0
  fi

  echo "Starting Slack soft bridge using ${ENV_FILE}"
  nohup bash -lc "
    cd '${ROOT_DIR}'
    set -a
    source '${ENV_FILE}'
    set +a
    if [[ -z \"\${API_BASE_URL:-}\" && -n \"\${API_URL:-}\" ]]; then
      export API_BASE_URL=\"\${API_URL%/}\"
    fi
    pnpm --filter @browser-hitl/slack-bot build
    exec pnpm --filter @browser-hitl/slack-bot start:soft
  " > "${LOG_FILE}" 2>&1 &
  echo "$!" > "${PID_FILE}"

  if ! wait_for_startup; then
    echo "ERROR: Slack soft bridge failed to start cleanly." >&2
    tail -n 120 "${LOG_FILE}" >&2 || true
    exit 1
  fi

  echo "Slack soft bridge started (pid=$(cat "${PID_FILE}"))"
  echo "Log: ${LOG_FILE}"
}

down() {
  local pid
  pid="$(read_pid || true)"
  if is_running "${pid}"; then
    echo "Stopping Slack soft bridge (pid=${pid})"
    kill "${pid}" >/dev/null 2>&1 || true
    sleep 1
    if is_running "${pid}"; then
      kill -9 "${pid}" >/dev/null 2>&1 || true
    fi
  fi

  # Best effort for unmanaged runs.
  pkill -f "pnpm --filter @browser-hitl/slack-bot start:soft" >/dev/null 2>&1 || true
  pkill -f "dist/soft-hitl-bridge.js" >/dev/null 2>&1 || true
  rm -f "${PID_FILE}"
  echo "Slack soft bridge stopped."
}

status() {
  local pid
  pid="$(read_pid || true)"
  local running=false

  echo "Slack soft bridge status"
  if is_running "${pid}"; then
    running=true
    echo "  process: running (pid=${pid})"
  else
    echo "  process: stopped"
  fi
  if [[ -f "${LOG_FILE}" ]]; then
    echo "  log: ${LOG_FILE}"
    if [[ "${running}" == "true" ]]; then
      tail -n 10 "${LOG_FILE}" || true
    fi
  fi
}

logs() {
  if [[ ! -f "${LOG_FILE}" ]]; then
    echo "No log file at ${LOG_FILE}" >&2
    exit 1
  fi
  tail -n 120 "${LOG_FILE}"
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
  logs)
    logs
    ;;
  *)
    echo "Usage: $0 {up|down|status|logs}" >&2
    exit 1
    ;;
esac
