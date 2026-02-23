#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${LOCAL_ENV_FILE:-${ROOT_DIR}/.env.local}"
AUTO_FIX=false
KEEP_APP_ID="${KEEP_APP_ID:-}"
REQUIRE_NATS=false

NAMESPACE="${LOCAL_NAMESPACE:-browser-hitl}"
RELEASE="${LOCAL_RELEASE:-browser-hitl}"
LOCAL_NATS_PORT="${LOCAL_NATS_PORT:-4222}"
LOCAL_STATE_DIR="${LOCAL_STATE_DIR:-/tmp/browser-hitl-local}"

log_step() {
  echo ""
  echo "==> $1"
}

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required binary not found: $1" >&2
    exit 1
  }
}

is_local_port_open() {
  local port="$1"
  timeout 1 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/${port}" >/dev/null 2>&1
}

usage() {
  cat <<EOF
Usage: $0 [--env-file PATH] [--auto-fix] [--keep-app-id APP_ID] [--require-nats]

Options:
  --env-file PATH     Path to local env file (default: ${ENV_FILE})
  --auto-fix          Apply deterministic fixes (refresh ngrok/apply stream host, scale down stale apps)
  --keep-app-id ID    Keep one active app while scaling down stale apps
  --require-nats      Require local NATS on 127.0.0.1:${LOCAL_NATS_PORT}
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --auto-fix)
      AUTO_FIX=true
      shift
      ;;
    --keep-app-id)
      KEEP_APP_ID="$2"
      shift 2
      ;;
    --require-nats)
      REQUIRE_NATS=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_bin curl
require_bin jq
require_bin kubectl
require_bin make
require_bin rg

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: env file not found: ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

API_URL="${API_URL:-${API_BASE_URL:-http://localhost:18080}}"
API_URL="${API_URL%/}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@browser-hitl.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-e2e-admin-password}"

if [[ -z "${ADMIN_EMAIL}" || -z "${ADMIN_PASSWORD}" ]]; then
  echo "ERROR: ADMIN_EMAIL and ADMIN_PASSWORD are required (set in ${ENV_FILE})" >&2
  exit 1
fi

log_step "API reachability check (${API_URL})"
if ! curl -fsS -m 5 "${API_URL}/metrics" >/dev/null 2>&1; then
  if ! curl -fsS -m 5 "${API_URL}/health" >/dev/null 2>&1; then
    echo "ERROR: API is not reachable at ${API_URL} (/metrics and /health failed)" >&2
    exit 1
  fi
fi
echo "OK: API reachable."

log_step "Admin login check"
TOKEN="$(
  curl -sS -X POST "${API_URL}/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
    | jq -r '.token // empty'
)"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: admin login failed at ${API_URL}/login" >&2
  exit 1
fi
echo "OK: admin login token issued."

resolve_ngrok_url() {
  local url
  url="$(cd "${ROOT_DIR}" && make -s local-ngrok-url 2>/dev/null || true)"
  if [[ -z "${url}" && -f "${LOCAL_STATE_DIR}/ngrok-public-url.txt" ]]; then
    url="$(cat "${LOCAL_STATE_DIR}/ngrok-public-url.txt")"
  fi
  printf "%s" "${url}"
}

log_step "ngrok URL + API stream host consistency"
NGROK_URL="$(resolve_ngrok_url)"
if [[ -z "${NGROK_URL}" ]]; then
  if [[ "${AUTO_FIX}" == "true" ]]; then
    echo "ngrok URL missing; auto-fix enabled -> refreshing ngrok + stream host"
    (cd "${ROOT_DIR}" && make local-ngrok-refresh-apply-stream-host >/dev/null)
    NGROK_URL="$(resolve_ngrok_url)"
  fi
fi
if [[ -z "${NGROK_URL}" ]]; then
  echo "ERROR: ngrok URL unavailable. Run 'make local-ngrok-refresh-apply-stream-host'." >&2
  exit 1
fi

NGROK_HOST="${NGROK_URL#https://}"
NGROK_HOST="${NGROK_HOST#http://}"
NGROK_HOST="${NGROK_HOST%%/*}"

read_api_env() {
  local env_name="$1"
  kubectl -n "${NAMESPACE}" get deployment "${RELEASE}-api" -o json \
    | jq -r --arg key "${env_name}" '
      .spec.template.spec.containers[]
      | select(.name=="api" or ((.name // "") | test("api")))
      | .env[]?
      | select(.name==$key)
      | .value
    ' | head -n 1
}

STREAM_HOST="$(read_api_env STREAM_HOST)"
STREAM_PROTOCOL="$(read_api_env STREAM_PROTOCOL)"
PUBLIC_BASE_URL="$(read_api_env PUBLIC_BASE_URL)"
EXPECTED_PUBLIC_BASE_URL="https://${NGROK_HOST}"

if [[ "${STREAM_HOST}" != "${NGROK_HOST}" || "${STREAM_PROTOCOL}" != "https" || "${PUBLIC_BASE_URL}" != "${EXPECTED_PUBLIC_BASE_URL}" ]]; then
  if [[ "${AUTO_FIX}" == "true" ]]; then
    echo "API stream env mismatch; auto-fix enabled -> reapplying stream host"
    (cd "${ROOT_DIR}" && make local-ngrok-refresh-apply-stream-host >/dev/null)
    NGROK_URL="$(resolve_ngrok_url)"
    NGROK_HOST="${NGROK_URL#https://}"
    NGROK_HOST="${NGROK_HOST#http://}"
    NGROK_HOST="${NGROK_HOST%%/*}"
    EXPECTED_PUBLIC_BASE_URL="https://${NGROK_HOST}"
    STREAM_HOST="$(read_api_env STREAM_HOST)"
    STREAM_PROTOCOL="$(read_api_env STREAM_PROTOCOL)"
    PUBLIC_BASE_URL="$(read_api_env PUBLIC_BASE_URL)"
  fi
fi

if [[ "${STREAM_HOST}" != "${NGROK_HOST}" || "${STREAM_PROTOCOL}" != "https" || "${PUBLIC_BASE_URL}" != "${EXPECTED_PUBLIC_BASE_URL}" ]]; then
  echo "ERROR: API stream env does not match ngrok host." >&2
  echo "  ngrok host:      ${NGROK_HOST}" >&2
  echo "  STREAM_HOST:     ${STREAM_HOST}" >&2
  echo "  STREAM_PROTOCOL: ${STREAM_PROTOCOL}" >&2
  echo "  PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}" >&2
  exit 1
fi
echo "OK: API stream env matches ngrok host (${NGROK_HOST})."

log_step "Viewer asset probes"
RFB_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${NGROK_URL%/}/vnc/assets/rfb.js" || true)"
INFLATE_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${NGROK_URL%/}/vnc/vendor/pako/lib/zlib/inflate.js" || true)"
if [[ "${RFB_CODE}" != "200" || "${INFLATE_CODE}" != "200" ]]; then
  echo "ERROR: viewer assets not healthy via ngrok URL." >&2
  echo "  /vnc/assets/rfb.js => ${RFB_CODE}" >&2
  echo "  /vnc/vendor/pako/lib/zlib/inflate.js => ${INFLATE_CODE}" >&2
  exit 1
fi
echo "OK: viewer assets reachable through ngrok."

log_step "Active-app and worker-capacity hygiene"
active_rows="$(
  curl -sS -H "authorization: Bearer ${TOKEN}" "${API_URL}/apps?limit=200&offset=0" \
    | jq -r '.data[] | select((.desired_session_count // 0) > 0) | [.id, (.name // "<unnamed>"), (.desired_session_count | tostring)] | @tsv'
)"

if [[ -n "${active_rows}" ]]; then
  echo "Detected active apps:"
  printf '%s\n' "${active_rows}" | sed 's/\t/ | /g'
  if [[ "${AUTO_FIX}" == "true" ]]; then
    echo "Auto-fix enabled -> scaling stale active apps to zero."
    (
      cd "${ROOT_DIR}"
      KEEP_APP_ID="${KEEP_APP_ID}" API_URL="${API_URL}" ADMIN_EMAIL="${ADMIN_EMAIL}" ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
        ./scripts/hitl-scale-down-active-apps.sh >/dev/null
    )
    kubectl -n "${NAMESPACE}" delete pod -l app=browser-worker --wait=false >/dev/null 2>&1 || true
    sleep 3
    active_rows="$(
      curl -sS -H "authorization: Bearer ${TOKEN}" "${API_URL}/apps?limit=200&offset=0" \
        | jq -r --arg keep "${KEEP_APP_ID}" '
            .data[]
            | select((.desired_session_count // 0) > 0)
            | select(($keep == "") or (.id != $keep))
            | [.id, (.name // "<unnamed>"), (.desired_session_count | tostring)]
            | @tsv
          '
    )"
  fi
fi

if [[ -n "${active_rows}" ]]; then
  echo "ERROR: active apps remain with desired_session_count > 0." >&2
  printf '%s\n' "${active_rows}" | sed 's/\t/ | /g' >&2
  exit 1
fi
echo "OK: no stale active apps detected."

worker_pending="$(kubectl -n "${NAMESPACE}" get pods --no-headers 2>/dev/null | rg '^worker-' | rg 'Pending|ContainerCreating|CrashLoopBackOff|Error|ImagePullBackOff' || true)"
if [[ -n "${worker_pending}" ]]; then
  echo "ERROR: worker pods are not healthy/schedulable." >&2
  echo "${worker_pending}" >&2
  exit 1
fi
echo "OK: no unhealthy worker pod states detected."

if [[ "${REQUIRE_NATS}" == "true" ]]; then
  log_step "Local NATS port check"
  if ! is_local_port_open "${LOCAL_NATS_PORT}"; then
    echo "ERROR: local NATS port 127.0.0.1:${LOCAL_NATS_PORT} not reachable." >&2
    echo "Run: scripts/local-nats-port-forward.sh up" >&2
    exit 1
  fi
  echo "OK: local NATS reachable."
fi

log_step "Preflight summary"
echo "PASS: reliability preflight checks completed."
echo "  API_URL:         ${API_URL}"
echo "  ngrok URL:       ${NGROK_URL}"
echo "  namespace:       ${NAMESPACE}"
echo "  release:         ${RELEASE}"
echo "  auto-fix mode:   ${AUTO_FIX}"
