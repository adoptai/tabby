#!/usr/bin/env bash
# Reads a .env file and outputs --set flags for helm upgrade.
# Usage: ./scripts/dotenv-to-helm-sets.sh [.env-path]
set -euo pipefail
ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || exit 0

declare -A MAP=(
  [IDP_CLIENT_ID]="secrets.idpClientId"
  [IDP_CLIENT_SECRET]="secrets.idpClientSecret"
)

while IFS='=' read -r key value || [[ -n "$key" ]]; do
  key=$(echo "$key" | xargs)
  [[ -z "$key" || "$key" == \#* ]] && continue
  value=$(echo "$value" | xargs | sed "s/^['\"]//;s/['\"]$//")
  [[ -z "$value" ]] && continue
  helm_key="${MAP[$key]:-}"
  [[ -z "$helm_key" ]] && continue
  echo -n "--set ${helm_key}=${value} "
done < "$ENV_FILE"
