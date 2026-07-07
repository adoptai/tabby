#!/bin/sh
set -e

API_URL="${NEXT_PUBLIC_API_URL:-http://localhost:8000}"

cat > /usr/share/nginx/html/env.js << ENVEOF
window.__env = {
  API_URL: "${API_URL}",
};
ENVEOF

echo "[admin-ui] env.js written with API_URL=${API_URL}"
