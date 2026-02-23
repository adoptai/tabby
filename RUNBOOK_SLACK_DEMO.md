# RUNBOOK: Full E2E Slack HITL Demo (One-Shot)

> **Purpose**: A future Claude instance (or human operator) follows this runbook to
> execute a bulletproof, one-shot Slack HITL demo. Every known pitfall from prior
> runs is pre-mitigated. No live debugging should be necessary.

---

## Architecture Overview

```
User in Slack (#tabby-experiments)
  |                          ^
  | OTP <session-id> 123456  | "Action Required" + stream link
  v                          |
Slack Soft Bridge (local Node process)
  |  NATS events (hitl.started, state.changed, hitl.completed)
  |  API calls (service-token, stream URL, OTP submit)
  v
API pod (Kind cluster, port-forwarded to localhost:18080)
  |
  v
Controller pod  --->  Worker pod (browser + VNC sidecar)
                        |
                        v
                     Test-harness pod (login -> OTP -> dashboard)
                        |
ngrok tunnel  <---------+  (VNC stream exposed publicly)
```

**The demo flow:**
1. Worker pod starts, navigates to test-harness login page
2. DSL fills email/password, clicks login, arrives at OTP page
3. `sensitive: true` on `wait_for #otp` triggers AUTH_FAIL health result
4. Controller transitions: STARTING -> LOGIN_NEEDED -> LOGIN_IN_PROGRESS
5. Controller publishes `hitl.started` NATS event
6. Soft bridge receives event, fetches stream URL via API, posts Slack message
7. Slack shows "Action Required: Salesforce Authentication" with "Open Live Stream" button
8. User clicks stream link -> sees VNC viewer with OTP page via ngrok
9. User types `OTP <session-id> 123456` in Slack
10. Bridge submits OTP to API -> stored in Redis -> worker picks it up
11. Worker fills OTP field, test-harness authenticates, navigates to dashboard
12. Session -> HEALTHY, bridge posts "Verification Complete" to Slack

---

## Prerequisites (already expected to be running)

- Kind cluster with namespace `browser-hitl`
- Pods: API, Controller, NATS, Redis, PostgreSQL, MinIO, test-harness, egress-proxy
- Kubernetes secret `e2e-smoke-creds` in namespace `browser-hitl`
- NATS port-forward on `localhost:4222`
- Slack bot token in `.env.local` (the `SLACK_BOT_TOKEN` value)

---

## Step 0: Preflight Checks

Run ALL checks below before proceeding. Every check must pass.

### 0a. Verify Kind cluster pods are healthy

```bash
kubectl get pods -n browser-hitl -l 'app in (browser-hitl-api,browser-hitl-controller,test-harness)' \
  --no-headers | awk '{print $1, $3}'
```
**Expected**: All pods show `Running`. If any pod is not Running, stop and investigate.

### 0b. Verify NATS port-forward is alive

```bash
pgrep -fa "port-forward.*4222" | grep -v pgrep
```
**Expected**: Shows a `kubectl -n browser-hitl port-forward svc/browser-hitl-nats 4222:4222` process.
**If missing**: Start it:
```bash
make local-nats-up
```

### 0c. Verify `.env.local` has all required variables

```bash
for var in API_URL API_BASE_URL NATS_URL ADMIN_EMAIL ADMIN_PASSWORD \
           SLACK_BOT_TOKEN SLACK_CHANNEL SERVICE_AUTH_CLIENT_ID SERVICE_AUTH_CLIENT_SECRET; do
  grep -q "^${var}=.\+" .env.local && echo "OK: $var" || echo "MISSING: $var"
done
```
**Expected**: All lines show `OK`.

**Critical values that must be set (not empty)**:
| Variable | Required Value |
|----------|---------------|
| `API_URL` | `http://localhost:18080` |
| `API_BASE_URL` | `http://localhost:18080` |
| `NATS_URL` | `nats://localhost:4222` |
| `SERVICE_AUTH_CLIENT_ID` | `phase4-bot` |
| `SERVICE_AUTH_CLIENT_SECRET` | `phase4-secret` |
| `SLACK_BOT_TOKEN` | `xoxb-...` (must not be empty) |
| `SLACK_CHANNEL` | `tabby-experiments` |

### 0d. Verify ConfigMap has wildcard tenant scope ENABLED

```bash
kubectl get configmap browser-hitl-config -n browser-hitl \
  -o jsonpath='{.data.SERVICE_AUTH_ALLOW_WILDCARD_TENANT_SCOPE}'
```
**Expected**: `true`

**If it shows `false` or empty — FIX IT NOW**:
```bash
kubectl patch configmap browser-hitl-config -n browser-hitl \
  --type merge -p '{"data":{"SERVICE_AUTH_ALLOW_WILDCARD_TENANT_SCOPE":"true"}}'
kubectl rollout restart deployment/browser-hitl-api -n browser-hitl
kubectl rollout status deployment/browser-hitl-api -n browser-hitl --timeout=90s
```
> **Why**: Without this, the soft bridge's `POST /auth/service-token` call returns
> 401 "Wildcard tenant scope is disabled", which breaks both the stream link AND
> OTP submission. The API pod's `SERVICE_AUTH_ALLOWED_TENANT_IDS` is set to `*`
> (wildcard), which requires `SERVICE_AUTH_ALLOW_WILDCARD_TENANT_SCOPE=true`.

### 0e. Verify `scripts/local-slack-soft-bridge.sh` does NOT require `rg`

```bash
grep -c 'require_bin rg' scripts/local-slack-soft-bridge.sh
```
**Expected**: `0`

**If it shows `1` — FIX IT NOW**:
Replace `require_bin rg` with `require_bin grep` and replace any `rg -q` calls
with `grep -qE` in that script.

### 0f. Verify disk utilization is below 93%

```bash
df -h / | awk 'NR==2 {print $5}'
```
**Expected**: Below 93%.

**If above 93%**:
```bash
docker image prune -f
docker builder prune -f
docker image prune -a -f --filter "until=24h"
docker volume prune -f
```

### 0g. Verify Kubernetes secret `e2e-smoke-creds` exists

```bash
kubectl get secret e2e-smoke-creds -n browser-hitl --no-headers 2>/dev/null \
  && echo "OK" || echo "MISSING"
```
**Expected**: `OK`

---

## Step 1: Clean Shutdown of Stale Processes

Kill anything left over from previous runs. Order matters.

```bash
# 1a. Scale down any apps that might have active sessions
make hitl-scale-down-active 2>/dev/null || true

# 1b. Delete orphan worker pods
kubectl delete pod -n browser-hitl -l app=browser-worker --wait=false 2>/dev/null || true

# 1c. Stop managed local services (soft bridge, NATS pf, ngrok)
make local-fresh-down 2>/dev/null || true

# 1d. Kill any unmanaged stragglers
pkill -f "port-forward.*svc/browser-hitl-api" 2>/dev/null || true
pkill -f ngrok 2>/dev/null || true
pkill -f "soft-hitl-bridge" 2>/dev/null || true
pkill -f "slack-bot" 2>/dev/null || true

# 1e. Clean state directory
rm -rf /tmp/browser-hitl-local/

# 1f. Wait for worker pods to fully terminate
sleep 5
kubectl get pods -n browser-hitl -l app=browser-worker --no-headers 2>/dev/null | wc -l
```
**Expected**: `0` worker pods remaining.

---

## Step 2: Start ngrok + API Port-Forward + Apply Stream Env

```bash
make local-ngrok-up-apply-stream-host
```

**What this does**:
1. Port-forwards `svc/browser-hitl-api` to `localhost:18080`
2. Starts ngrok tunnel pointing at `localhost:18080`
3. Applies `STREAM_HOST`, `STREAM_PROTOCOL=https`, `PUBLIC_BASE_URL` to API deployment
4. Restarts the API port-forward after rollout

**Expected output** (key lines):
```
Local test tunnel ready
  API local:      http://127.0.0.1:18080
  ngrok URL:      https://<hash>.ngrok-free.app
```

### 2a. Verify API is reachable

```bash
curl -sf http://localhost:18080/login -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@browser-hitl.local","password":"e2e-admin-password"}' \
  | jq -r '.token[:20]'
```
**Expected**: First 20 chars of a JWT (starts with `eyJ`).

### 2b. Verify service-token endpoint works

```bash
TENANT_ID=$(curl -s http://localhost:18080/login -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@browser-hitl.local","password":"e2e-admin-password"}' \
  | jq -r '.token' | cut -d. -f2 | base64 -d 2>/dev/null | jq -r .tenant_id)

curl -sf -X POST http://localhost:18080/auth/service-token \
  -H "Content-Type: application/json" \
  -d "{
    \"client_id\": \"phase4-bot\",
    \"client_secret\": \"phase4-secret\",
    \"tenant_id\": \"${TENANT_ID}\",
    \"role\": \"Operator\"
  }" | jq '.token_type'
```
**Expected**: `"Bearer"`

> **If this returns 401 with "Wildcard tenant scope is disabled"**: Go back to
> Step 0d and fix the ConfigMap, then restart API and re-run Step 2.

---

## Step 3: Start Slack Soft Bridge

```bash
make local-slack-soft-up
```

**Expected output**:
```
Slack soft bridge started (pid=XXXXX)
Log: /tmp/browser-hitl-local/slack-soft-bridge.log
```

### 3a. Verify bridge health

```bash
make local-slack-soft-logs 2>&1 | tail -8
```

**Required log lines** (all three must appear):
```
[soft-hitl] connected to NATS at nats://localhost:4222
[soft-hitl] subscriptions created via jetstream
[soft-hitl] all subscriptions active, polling started
```

> **If startup fails with "required binary not found: rg"**: See Step 0e fix.
> **If NATS connection fails**: Verify NATS port-forward (Step 0b).

---

## Step 4: Create Demo App

```bash
JWT=$(curl -s http://localhost:18080/login -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@browser-hitl.local","password":"e2e-admin-password"}' | jq -r .token)

APP_RESPONSE=$(curl -s -X POST http://localhost:18080/apps \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Salesforce Authentication Demo",
    "target_urls": ["https://test-harness.internal:8000"],
    "browser_policy": {
      "streaming_mode": "vnc",
      "viewport": { "width": 1920, "height": 1080 }
    },
    "login_config": {
      "login_url": "http://test-harness:8000/login",
      "credential_ref": "k8s:secret/e2e-smoke-creds",
      "steps": [
        { "action": "goto", "url": "http://test-harness:8000/login" },
        { "action": "fill", "selector": "#email", "value": "${USERNAME}" },
        { "action": "fill", "selector": "#password", "value": "${PASSWORD}", "sensitive": true },
        { "action": "click", "selector": "#login-button" },
        { "action": "wait_for", "selector": "#otp", "sensitive": true, "timeout_ms": 120000 },
        { "action": "click", "selector": "#otp-submit" },
        { "action": "wait_for", "selector": "#user-menu", "timeout_ms": 30000 }
      ],
      "otp_prompt": {
        "method": "chat",
        "field_selector": "#otp"
      }
    },
    "keepalive_config": {
      "policy": "all",
      "actions": [
        { "url": "http://test-harness:8000/dashboard", "action": "goto" }
      ],
      "health_checks": [
        {
          "type": "network_check",
          "url": "http://test-harness:8000/api/me",
          "expect_status": 200,
          "body_contains": "\"authenticated\":true"
        }
      ],
      "interval_seconds": 60
    },
    "export_policy": {
      "artifact_types": ["cookies", "headers"],
      "encryption": { "algo": "AES-256-GCM", "key_version": "v1" },
      "ttl_seconds": 3600
    },
    "notification_config": { "channels": ["slack:#tabby-experiments"] },
    "desired_session_count": 0
  }')

APP_ID=$(echo "$APP_RESPONSE" | jq -r '.app_id')
echo "APP_ID=${APP_ID}"
```

**Expected**: A UUID app_id is printed. If you get validation errors, the DTO shape
is wrong — review the error `field` and `issues` in the response.

**Critical DTO requirements**:
- `target_urls` must be an array of HTTPS URLs
- `login_config.credential_ref` is required (use `k8s:secret/e2e-smoke-creds`)
- `login_config.steps` must include at least one `goto` action
- `keepalive_config.health_checks[].type` must be `network_check` (not `url_match`)
- `keepalive_config` is a required field (not optional)

**Critical login DSL requirements for HITL trigger**:
- The `wait_for` step for `#otp` must have `"sensitive": true`
- This causes the worker to emit `AUTH_FAIL` health result
- Controller transitions: STARTING -> LOGIN_NEEDED -> LOGIN_IN_PROGRESS
- Controller publishes `hitl.started` NATS event

---

## Step 5: READY CHECKPOINT

At this point, pause and inform the user:

> **Demo is ready.** All services are running:
> - ngrok: `https://<hash>.ngrok-free.app`
> - API: `http://localhost:18080`
> - Slack bridge: Connected to NATS, polling Slack
> - App created: `<APP_ID>`
>
> When you say **"Go"**, I will scale the session to 1, which will:
> 1. Spawn a worker pod
> 2. Navigate to the test-harness login page
> 3. Fill credentials and hit the OTP page
> 4. Trigger the HITL flow and post to `#tabby-experiments`
>
> **You will need to**:
> 1. Watch `#tabby-experiments` for the "Action Required" message
> 2. Click "Open Live Stream" to view the VNC stream
> 3. Reply in Slack with: `OTP <session-id> 123456`

**Wait for user acknowledgment before proceeding.**

---

## Step 6: Scale Session to 1 (on user "Go")

```bash
JWT=$(curl -s http://localhost:18080/login -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@browser-hitl.local","password":"e2e-admin-password"}' | jq -r .token)

curl -s -X POST "http://localhost:18080/apps/${APP_ID}/sessions/scale" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{ "desired_sessions": 1 }' | jq '.'
```

**Expected**: `{ "desired_sessions": 1, "app_id": "<APP_ID>" }`

---

## Step 7: Monitor Session State Transitions

Poll every 5 seconds until `LOGIN_IN_PROGRESS`:

```bash
for i in $(seq 1 24); do
  sleep 5
  JWT=$(curl -s http://localhost:18080/login -X POST \
    -H "Content-Type: application/json" \
    -d '{"email":"admin@browser-hitl.local","password":"e2e-admin-password"}' | jq -r .token)
  STATE=$(curl -s "http://localhost:18080/sessions?limit=1" \
    -H "Authorization: Bearer $JWT" | jq -r '.data[0].state // "UNKNOWN"')
  SESSION_ID=$(curl -s "http://localhost:18080/sessions?limit=1" \
    -H "Authorization: Bearer $JWT" | jq -r '.data[0].id // "UNKNOWN"')
  echo "[$(date +%H:%M:%S)] Session ${SESSION_ID}: ${STATE}"
  if [ "$STATE" = "LOGIN_IN_PROGRESS" ]; then
    echo "SESSION_ID=${SESSION_ID}"
    break
  fi
done
```

**Expected state progression** (typically 15-30 seconds):
```
STARTING -> LOGIN_NEEDED -> LOGIN_IN_PROGRESS
```

> **IMPORTANT**: Do not call `/login` more than ~5 times per minute. The API has
> rate limiting (429 Too Many Requests). If you hit it, wait 60 seconds.
> Consider caching the JWT in a variable instead of re-authenticating each poll.

---

## Step 8: Verify Slack Message Posted

```bash
make local-slack-soft-logs 2>&1 | tail -5
```

**Expected**:
```
[soft-hitl] RECV hitl.started: hitl.started.<tenant>.<session>
[soft-hitl] handleHitlStarted completed
```

The Slack message in `#tabby-experiments` should show:
- **Title**: "Action Required: Salesforce Authentication"
- **Body**: Instructions with `OTP <session-id> <one-time-code>`
- **Button**: "Open Live Stream" linking to `https://<ngrok-host>/vnc/<session-id>#token=<jwt>`

> **If the stream link says "unavailable"**: The service-token call failed.
> Check Step 0d (wildcard tenant scope must be `true`).

---

## Step 9: User Interaction

1. User clicks "Open Live Stream" in Slack
   - May see ngrok interstitial page — click "Visit Site"
   - VNC viewer loads showing the OTP input page
2. User types in Slack: `OTP <session-id> 123456`
3. Bridge acknowledges: "Thanks. I received your code..."

---

## Step 10: Verify Completion

After OTP submission, monitor for HEALTHY state:

```bash
for i in $(seq 1 12); do
  sleep 5
  STATE=$(curl -s "http://localhost:18080/sessions?limit=1" \
    -H "Authorization: Bearer $JWT" | jq -r '.data[0].state // "UNKNOWN"')
  echo "[$(date +%H:%M:%S)] Session: ${STATE}"
  if [ "$STATE" = "HEALTHY" ]; then
    echo "SUCCESS: Session is HEALTHY"
    break
  fi
done
```

**Expected**: Session transitions to `HEALTHY` within 30 seconds of OTP submission.

Bridge posts to Slack: **"Thank You: Verification Complete"**

---

## Cleanup (after demo)

```bash
# Scale down
JWT=$(curl -s http://localhost:18080/login -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@browser-hitl.local","password":"e2e-admin-password"}' | jq -r .token)
curl -s -X POST "http://localhost:18080/apps/${APP_ID}/sessions/scale" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{ "desired_sessions": 0 }'

# Stop local services
make local-fresh-down
```

---

## Known Pitfalls & Fixes

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Wildcard tenant scope disabled | 401 on service-token: "Wildcard tenant scope is disabled" | Patch ConfigMap: `SERVICE_AUTH_ALLOW_WILDCARD_TENANT_SCOPE=true`, restart API |
| `rg` (ripgrep) not installed | `local-slack-soft-up` fails: "required binary not found: rg" | Replace `require_bin rg` with `require_bin grep` and `rg -q` with `grep -qE` in `scripts/local-slack-soft-bridge.sh` |
| Empty SERVICE_AUTH creds in .env.local | Bridge gets 401 on every API call | Set `SERVICE_AUTH_CLIENT_ID=phase4-bot` and `SERVICE_AUTH_CLIENT_SECRET=phase4-secret` in `.env.local` |
| Auth endpoint is `/login` not `/auth/login` | 404 on login attempt | Use `POST /login` (no prefix; controller has `@Controller()` with `@Post('login')`) |
| `target_urls` must be HTTPS | Validation error on app creation | Use `https://test-harness.internal:8000` |
| Missing `credential_ref` | Validation error: "credential_ref is required" | Include `"credential_ref": "k8s:secret/e2e-smoke-creds"` |
| Missing `goto` step | Validation error: "steps must include at least one goto action" | First step must be `{ "action": "goto", "url": "..." }` |
| Wrong health check type | Validation error: "Invalid check type" | Use `"type": "network_check"` not `"type": "url_match"` |
| Rate limited (429) | Login returns `ThrottlerException: Too Many Requests` | Wait 60 seconds; cache JWT instead of re-authenticating per request |
| Port-forward dies after API rollout | Empty curl response on localhost:18080 | The `make local-ngrok-up-apply-stream-host` script auto-restarts it; if manual, re-run `kubectl port-forward -n browser-hitl svc/browser-hitl-api 18080:8080 &` |
| Stale ngrok URL | Stream link 404s or shows wrong content | Run `make local-ngrok-refresh-apply-stream-host` to rotate |
| Test-harness selectors | Worker can't find elements | Login: `#email`, `#password`, `#login-button`. OTP: `#otp`, `#otp-submit`. Dashboard: `#user-menu` |

---

## API Quick Reference

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/login` | POST | Body: `{email, password}` | Human login, returns JWT |
| `/auth/service-token` | POST | Body: `{client_id, client_secret, tenant_id, role}` | Service-to-service token |
| `/apps` | POST | Bearer JWT | Create app |
| `/apps/:id/sessions/scale` | POST | Bearer JWT | Scale sessions |
| `/sessions` | GET | Bearer JWT | List sessions |
| `/sessions/:id/stream` | POST | Bearer service-token | Get stream URL |
| `/sessions/:id/otp` | POST | Bearer service-token | Submit OTP |
