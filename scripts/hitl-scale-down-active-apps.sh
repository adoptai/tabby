#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:18080}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@browser-hitl.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-e2e-admin-password}"
KEEP_APP_ID="${KEEP_APP_ID:-}"

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required binary not found: $1" >&2
    exit 1
  }
}

require_bin curl
require_bin jq

login_payload="$(jq -nc \
  --arg email "${ADMIN_EMAIL}" \
  --arg password "${ADMIN_PASSWORD}" \
  '{email: $email, password: $password}')"

login_response="$(curl -sS -X POST "${API_URL%/}/login" \
  -H 'content-type: application/json' \
  -d "${login_payload}")"

token="$(printf '%s' "${login_response}" | jq -r '.token // empty')"
if [[ -z "${token}" ]]; then
  echo "ERROR: login failed against ${API_URL%/}/login" >&2
  echo "Response: ${login_response}" >&2
  exit 1
fi

apps_response="$(curl -sS -H "authorization: Bearer ${token}" "${API_URL%/}/apps?limit=200&offset=0")"
if ! printf '%s' "${apps_response}" | jq -e '.data | type == "array"' >/dev/null 2>&1; then
  echo "ERROR: unexpected /apps response" >&2
  echo "Response: ${apps_response}" >&2
  exit 1
fi

mapfile -t active_rows < <(
  printf '%s' "${apps_response}" | jq -r '
    .data[]
    | select((.desired_session_count // 0) > 0)
    | [.id, (.name // "<unnamed>"), (.desired_session_count | tostring)]
    | @tsv
  '
)

if [[ "${#active_rows[@]}" -eq 0 ]]; then
  echo "No active apps found (desired_session_count > 0)."
  exit 0
fi

echo "Active apps with desired_session_count > 0:"
for row in "${active_rows[@]}"; do
  IFS=$'\t' read -r app_id app_name desired_count <<< "${row}"
  echo "  - ${app_id} (${app_name}) desired=${desired_count}"
done

scaled_count=0
skipped_count=0
for row in "${active_rows[@]}"; do
  IFS=$'\t' read -r app_id app_name _ <<< "${row}"
  if [[ -n "${KEEP_APP_ID}" && "${app_id}" == "${KEEP_APP_ID}" ]]; then
    echo "Skipping ${app_id} (${app_name}) due to KEEP_APP_ID"
    ((skipped_count+=1))
    continue
  fi

  status_code="$(
    curl -sS -o /tmp/hitl-scale-down-"${app_id}".json -w '%{http_code}' \
      -X POST \
      -H "authorization: Bearer ${token}" \
      -H 'content-type: application/json' \
      -d '{"desired_sessions":0}' \
      "${API_URL%/}/apps/${app_id}/sessions/scale"
  )"

  if [[ "${status_code}" == "200" ]]; then
    echo "Scaled ${app_id} (${app_name}) -> desired=0"
    ((scaled_count+=1))
  else
    echo "ERROR: failed to scale ${app_id} (${app_name}) (HTTP ${status_code})" >&2
    cat /tmp/hitl-scale-down-"${app_id}".json >&2 || true
    exit 1
  fi
done

echo "Done. scaled=${scaled_count} skipped=${skipped_count}"
