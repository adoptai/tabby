#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:8000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@browser-hitl.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-e2e-admin-password}"

echo "[e2e-smoke] API_URL=${API_URL}"

echo "[e2e-smoke] Checking metrics endpoint"
curl -sf "${API_URL}/metrics" >/dev/null

echo "[e2e-smoke] Logging in as bootstrap admin"
LOGIN_RESPONSE="$(curl -sf -X POST "${API_URL}/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}")"

TOKEN="$(node -e "const r = JSON.parse(process.argv[1]); process.stdout.write(r.token || '');" "${LOGIN_RESPONSE}")"
if [[ -z "${TOKEN}" ]]; then
  echo "[e2e-smoke] ERROR: login response did not include token"
  exit 1
fi

echo "[e2e-smoke] Verifying authenticated sessions endpoint"
SESSIONS_RESPONSE="$(curl -sf "${API_URL}/sessions?limit=10&offset=0" \
  -H "Authorization: Bearer ${TOKEN}")"

if [[ "${SESSIONS_RESPONSE}" != *"\"data\""* ]]; then
  echo "[e2e-smoke] ERROR: sessions response missing data field"
  exit 1
fi

echo "[e2e-smoke] PASS"
