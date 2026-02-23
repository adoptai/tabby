#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:18080}"
API_URL="${API_URL%/}"
UAT_NAMESPACE="${UAT_NAMESPACE:-browser-hitl}"
API_CHECK_PATH="${API_CHECK_PATH:-/metrics}"
PF_PID=""

cleanup() {
  if [[ -n "${PF_PID}" ]]; then
    kill "${PF_PID}" >/dev/null 2>&1 || true
    wait "${PF_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if ! curl -fsS "${API_URL}${API_CHECK_PATH}" >/dev/null 2>&1; then
  if [[ "${API_URL}" =~ ^http://(localhost|127\.0\.0\.1):([0-9]+)$ ]]; then
    local_port="${BASH_REMATCH[2]}"
    kubectl -n "${UAT_NAMESPACE}" port-forward svc/browser-hitl-api "${local_port}:8080" >/tmp/e2e-uat-22-4-port-forward.log 2>&1 &
    PF_PID=$!
    for _ in $(seq 1 30); do
      if curl -fsS "${API_URL}${API_CHECK_PATH}" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
  fi
fi

if ! curl -fsS "${API_URL}${API_CHECK_PATH}" >/dev/null 2>&1; then
  echo "UAT preflight failed: API not reachable at ${API_URL}" >&2
  exit 1
fi

export API_URL
python3 scripts/e2e_uat_22_4.py
