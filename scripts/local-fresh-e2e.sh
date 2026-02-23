#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${LOCAL_ENV_FILE:-${ROOT_DIR}/.env.local}"

START_NATS=true
START_SLACK_BRIDGE=true
RUN_SCENARIO=false
AUTO_FIX=true
KEEP_APP_ID=""

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --env-file PATH          Path to env file (default: ${ENV_FILE})
  --skip-nats              Do not start managed local NATS port-forward
  --skip-slack-bridge      Do not start managed local Slack soft bridge
  --run-scenario           Run scripts/hitl_manual_slack_scenario.py at the end
  --no-auto-fix            Disable preflight auto-fix mode
  --keep-app-id APP_ID     Preserve one active app during cleanup
  -h, --help               Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --skip-nats)
      START_NATS=false
      shift
      ;;
    --skip-slack-bridge)
      START_SLACK_BRIDGE=false
      shift
      ;;
    --run-scenario)
      RUN_SCENARIO=true
      shift
      ;;
    --no-auto-fix)
      AUTO_FIX=false
      shift
      ;;
    --keep-app-id)
      KEEP_APP_ID="$2"
      shift 2
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

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: env file not found: ${ENV_FILE}" >&2
  exit 1
fi

echo "==> Reliability hardening fresh-run orchestration"
echo "    env file: ${ENV_FILE}"

echo ""
echo "==> Step 1/6: Refresh ngrok + apply stream host"
(cd "${ROOT_DIR}" && LOCAL_ENV_FILE="${ENV_FILE}" make local-ngrok-refresh-apply-stream-host)

echo ""
echo "==> Step 2/6: Scale down stale active apps"
(
  cd "${ROOT_DIR}"
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
  KEEP_APP_ID="${KEEP_APP_ID}" ./scripts/hitl-scale-down-active-apps.sh || true
)

echo ""
echo "==> Step 3/6: Drop stale worker pods"
kubectl -n "${LOCAL_NAMESPACE:-browser-hitl}" delete pod -l app=browser-worker --wait=false >/dev/null 2>&1 || true
sleep 3

if [[ "${START_NATS}" == "true" ]]; then
  echo ""
  echo "==> Step 4/6: Ensure local NATS port-forward"
  LOCAL_ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/local-nats-port-forward.sh" up
else
  echo ""
  echo "==> Step 4/6: Skip NATS port-forward (requested)"
fi

if [[ "${START_SLACK_BRIDGE}" == "true" ]]; then
  echo ""
  echo "==> Step 5/6: Ensure Slack soft bridge"
  LOCAL_ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/local-slack-soft-bridge.sh" up
else
  echo ""
  echo "==> Step 5/6: Skip Slack soft bridge (requested)"
fi

echo ""
echo "==> Step 6/6: Reliability preflight"
PREFLIGHT_ARGS=(--env-file "${ENV_FILE}")
if [[ "${AUTO_FIX}" == "true" ]]; then
  PREFLIGHT_ARGS+=(--auto-fix)
fi
if [[ -n "${KEEP_APP_ID}" ]]; then
  PREFLIGHT_ARGS+=(--keep-app-id "${KEEP_APP_ID}")
fi
if [[ "${START_NATS}" == "true" ]]; then
  PREFLIGHT_ARGS+=(--require-nats)
fi
"${ROOT_DIR}/scripts/local-reliability-preflight.sh" "${PREFLIGHT_ARGS[@]}"

echo ""
echo "==> Fresh-run stack is ready."
if [[ "${RUN_SCENARIO}" == "true" ]]; then
  echo "Running manual Slack HITL scenario..."
  (
    cd "${ROOT_DIR}"
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
    python3 scripts/hitl_manual_slack_scenario.py
  )
else
  cat <<EOF
Next command:
  set -a; source ${ENV_FILE}; set +a
  python3 ${ROOT_DIR}/scripts/hitl_manual_slack_scenario.py

Useful status commands:
  ${ROOT_DIR}/scripts/local-nats-port-forward.sh status
  ${ROOT_DIR}/scripts/local-slack-soft-bridge.sh status
  make -C ${ROOT_DIR} local-ngrok-status
EOF
fi

