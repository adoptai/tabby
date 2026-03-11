# Tabby Startup Guide

Quick-reference commands to get the stack running locally. Two setups: **Docker Compose** (API-only dev) and **Kubernetes** (full end-to-end with workers).

---

## Prerequisites

```bash
node -v        # 20+
pnpm -v        # 10+
docker -v      # 20+
kubectl version --client  # (K8s setup only)
helm version              # (K8s setup only)
kind version              # (K8s setup only)
```

If pnpm isn't installed:

```bash
corepack enable && corepack prepare pnpm@latest --activate
```

---

## Setup A: Docker Compose (API Development)

Best for: API work, CRUD testing, unit tests. No browser sessions — controller and workers require K8s.

### 1. Install and build

```bash
pnpm install
make build
```

### 2. Start infrastructure

```bash
docker compose up -d
docker compose ps   # verify all 4 healthy: postgres, redis, nats, minio
```

> **Port conflict?** If system Redis is running on 6379: `sudo systemctl stop redis-server`

### 3. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` — replace the two `REPLACE_ME` values:

```bash
JWT_SIGNING_KEY=$(openssl rand -hex 32)
TENANT_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

### 4. Start the API

```bash
set -a && source .env.local && set +a
pnpm --filter @browser-hitl/api start:dev
```

Or as a one-liner with all required vars:

```bash
DATABASE_URL="postgresql://browser_hitl:localdev@localhost:5432/browser_hitl" \
REDIS_URL="redis://localhost:6379" \
NATS_URL="nats://localhost:4222" \
JWT_SIGNING_KEY="$(openssl rand -hex 32)" \
TENANT_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
AGENT_SECRET_HMAC_KEY="$(openssl rand -hex 32)" \
MINIO_ENDPOINT="localhost" \
MINIO_PORT="9000" \
MINIO_ACCESS_KEY="minioadmin" \
MINIO_SECRET_KEY="minioadmin" \
ADMIN_BOOTSTRAP_EMAIL="admin@browser-hitl.local" \
ADMIN_BOOTSTRAP_PASSWORD="LocalDev123!@#" \
NODE_ENV="development" \
pnpm --filter @browser-hitl/api start:dev
```

### 5. Verify

```bash
curl http://localhost:8080/health/live
# {"status":"ok"}

# Swagger UI
open http://localhost:8080/api/docs
```

### 6. Run tests

```bash
make test          # all 640 tests
make test-api      # API only
make test-worker   # worker only
make test-shared   # shared only
```

### Stop everything

```bash
docker compose down      # keep data
docker compose down -v   # wipe volumes
```

---

## Setup B: Kubernetes (Full Stack with Workers)

Best for: end-to-end testing, browser sessions, HITL flows, Slack integration.

### 1. Create Kind cluster

```bash
make kind-create
# Creates cluster "tabby-dev"
```

### 2. Build and load Docker images

```bash
make docker-build
make kind-load-images
```

### 3. Deploy with Helm

```bash
make kind-deploy
# Installs full stack with values-local.yaml (single replicas, no TLS, no network policies)
```

### 4. Check status

```bash
make k8s-status
# Shows all pods and services in browser-hitl namespace
```

Wait until all pods are `Running`:

```bash
kubectl get pods -n browser-hitl -w
```

#### 4.1 Fix Admin UI API URL

The admin-ui is a simple Express server that bakes `NEXT_PUBLIC_API_URL` into the HTML `<script>` tag. The **browser** makes API calls directly to this URL, so it must be the localhost port-forward address (not the in-cluster service name).

```bash
kubectl -n browser-hitl set env deployment/browser-hitl-admin-ui \
    NEXT_PUBLIC_API_URL=http://localhost:18080
kubectl -n browser-hitl set env deployment/browser-hitl-api \
    STREAM_HOST=localhost:18080
kubectl -n browser-hitl set env deployment/browser-hitl-api \
    SERVICE_AUTH_CLIENT_ID=phase4-bot \
    SERVICE_AUTH_CLIENT_SECRET=phase4-secret \
    SERVICE_AUTH_ALLOWED_TENANT_IDS='*' \
    SERVICE_AUTH_ALLOW_WILDCARD_TENANT_SCOPE='true'
```

> **Note:** This must be re-run after every `helm upgrade --install`.

### 5. Port-forward services

```bash
# Admin UI (frontend)
kubectl port-forward -n browser-hitl svc/browser-hitl-admin-ui 13000:3000 &

# API
kubectl port-forward -n browser-hitl svc/browser-hitl-api 18080:8080 &

# Redis (for local scripts)
kubectl port-forward -n browser-hitl svc/browser-hitl-redis 16379:6379 &

# PostgreSQL (for local scripts)
kubectl port-forward -n browser-hitl svc/browser-hitl-postgres 25432:5432 &

# MinIO
kubectl port-forward -n browser-hitl svc/browser-hitl-minio 19000:9000 &

# NATS (required for Slack bridge)
kubectl port-forward -n browser-hitl svc/browser-hitl-nats 4222:4222 &
```

Or use the Makefile shortcut (API + test harness only):

```bash
make k8s-port-forward
```

### 6. Access the frontend

```bash
open http://localhost:13000
```

The Admin UI proxies API calls internally via `http://browser-hitl-api:8080` (set in step 4.1). Login with the bootstrap credentials:


| Field    | Value                      |
| -------- | -------------------------- |
| Email    | `admin@browser-hitl.local` |
| Password | `LocalDev123!@#`           |


From the UI you can view sessions, request VNC stream URLs, and inspect session details.

### 7. Verify API

```bash
curl http://localhost:18080/health/live
# {"status":"ok"}
```

### Tear down port-forwards

Kill all background `kubectl port-forward` processes at once:

```bash
pkill -f "kubectl port-forward" && echo "All port-forwards stopped"
```

Or kill them individually by port:

```bash
# Find the PIDs
lsof -ti:13000 | xargs kill   # Admin UI
lsof -ti:18080 | xargs kill   # API
lsof -ti:16379 | xargs kill   # Redis
lsof -ti:25432 | xargs kill   # PostgreSQL
lsof -ti:19000 | xargs kill   # MinIO
lsof -ti:4222  | xargs kill   # NATS
```

### Tear down cluster

```bash
make k8s-delete    # remove Helm release (keeps cluster)
make kind-delete   # destroy cluster entirely
```

---

## Testing with a Specific Application

Once the stack is running (either setup), follow these steps to create a session for a target app.

### Step 1: Get an auth token

```bash
TOKEN=$(curl -s -X POST http://localhost:${API_PORT:-8080}/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@browser-hitl.local","password":"LocalDev123!@#"}' \
  | jq -r '.token')

echo $TOKEN
```

### Step 2: Create the application

Example for HubSpot:

```bash
curl -s -X POST http://localhost:${API_PORT:-18080}/apps \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "HubSpot Production",
    "target_urls": ["https://app-na2.hubspot.com"],
    "login_config": {
      "login_url": "https://app-na2.hubspot.com/login",
      "credential_ref": "k8s:secret/hubspot-creds",
      "steps": [
        {"action": "goto", "url": "https://app-na2.hubspot.com/login"},
        {"action": "wait_for", "selector": "input#username", "timeout_ms": 30000},
        {"action": "fill", "selector": "input#username", "value": "${USERNAME}"},
        {"action": "click", "selector": "button[type=submit]"},
        {"action": "sleep", "ms": 3000},
        {"action": "wait_for", "selector": "input#password", "timeout_ms": 15000},
        {"action": "fill", "selector": "input#password", "value": "${PASSWORD}", "sensitive": true},
        {"action": "click", "selector": "button#loginBtn"},
        {"action": "sleep", "ms": 5000},
        {"action": "wait_for", "selector": "input#codeEntry", "sensitive": true, "timeout_ms": 120000},
        {"action": "screenshot"}
      ]
    },
    "keepalive_config": {
      "interval_seconds": 600,
      "actions": [{"action": "screenshot"}],
      "health_checks": [
        {"type": "dom_check", "selector": "body", "exists": true}
      ]
    },
    "export_policy": {
      "artifact_types": ["cookies", "headers", "local_storage"],
      "encryption": {"algo": "AES-256-GCM"},
      "ttl_seconds": 3600,
      "header_allowlist": ["authorization", "x-csrf-token"]
    },
    "notification_config": {
      "channels": ["slack:#tabby-experiments"],
      "escalation": { "after_minutes": 10, "notify": ["slack:#tabby-experiments"] }
    },
    "browser_policy": {
      "downloads": false,
      "clipboard": false,
      "file_chooser": false,
      "streaming_mode": "vnc"
    },
    "desired_session_count": 1
  }' | jq .
```

### Step 3: Create the credentials secret (K8s only)

```bash
kubectl create secret generic hubspot-creds \
  -n browser-hitl \
  --from-literal=username='user@example.com' \
  --from-literal=password='your-password-here'
```

### Step 4: Watch the session come up

```bash
# List sessions
curl -s http://localhost:${API_PORT:-18080}/sessions \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {id, state, health_result_type}'

# Watch pods
kubectl get pods -n browser-hitl -w
```

### Step 5: Access the browser stream (K8s only)

```bash
# Get stream URL for a session
SESSION_ID="<paste-session-id>"

curl -s -X POST http://localhost:${API_PORT:-18080}/sessions/$SESSION_ID/stream \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Open the returned URL in a browser to view the noVNC stream.

---

## Testing with the Local Test Harness

The test harness is a mock web app with login/MFA flows — no real credentials needed.

### Start the harness

```bash
make harness-run
# Runs on http://localhost:8000
```

### Verify it works

```bash
make harness-test
```

### Create an app config pointing to the harness

```bash
curl -s -X POST http://localhost:${API_PORT:-18080}/apps \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Harness",
    "target_urls": ["https://localhost:8000"],
    "login_config": {
      "login_url": "https://localhost:8000/login",
      "credential_ref": "k8s:secret/harness-creds",
      "steps": [
        {"action": "goto", "url": "https://localhost:8000/login"},
        {"action": "wait_for", "selector": "input[name=email]"},
        {"action": "fill", "selector": "input[name=email]", "value": "${USERNAME}"},
        {"action": "fill", "selector": "input[name=password]", "value": "${PASSWORD}", "sensitive": true},
        {"action": "click", "selector": "button[type=submit]"},
        {"action": "sleep", "ms": 2000},
        {"action": "wait_for_url", "pattern": "**/dashboard"},
        {"action": "screenshot"}
      ]
    },
    "keepalive_config": {
      "interval_seconds": 300,
      "actions": [],
      "health_checks": [
        {"type": "dom_check", "selector": "body", "exists": true}
      ]
    },
    "export_policy": {
      "artifact_types": ["cookies"],
      "encryption": {"algo": "AES-256-GCM"},
      "ttl_seconds": 300
    },
    "notification_config": {
      "channels": ["slack:#tabby-experiments"]
    },
    "browser_policy": {
      "downloads": false,
      "clipboard": false,
      "file_chooser": false,
      "streaming_mode": "vnc"
    },
    "desired_session_count": 1
  }' | jq .
```

```bash
kubectl create secret generic harness-creds \
  -n browser-hitl \
  --from-literal=username='admin@example.com' \
  --from-literal=password='P@ssw0rd12345'
```

---

## Adding Slack HITL (Optional)

Required for OTP relay via Slack notifications. There are two modes: the **soft bridge** (recommended for local dev) and the **in-cluster Slack bot**.

### Slack App Prerequisites

Create a Slack app at [https://api.slack.com/apps](https://api.slack.com/apps) with a Bot User OAuth Token (`xoxb-...`). Required scopes:


| Scope              | Why                                   |
| ------------------ | ------------------------------------- |
| `channels:history` | Read messages (poll for OTP commands) |
| `chat:write`       | Post HITL notifications               |
| `channels:read`    | Resolve channel names                 |


Invite the bot to your target channel (e.g. `#tabby-experiments`).

### Option A: Soft Bridge (recommended for local dev)

The soft bridge runs **outside** the cluster as a local Node process. It polls the Slack channel for commands and forwards them to the API. No Socket Mode, no signing secret needed — just the bot token.

#### 1. Set Slack vars in `.env.local`

```bash
SLACK_BOT_TOKEN=xoxb-YOUR-REAL-TOKEN
SLACK_CHANNEL=tabby-experiments
SLACK_SOFT_ALLOW_UNRESTRICTED_OPERATORS=true
API_BASE_URL=http://localhost:8080
NATS_URL=nats://localhost:4222
```

#### 2. Verify NATS port-forward is running

The soft bridge subscribes to NATS events (e.g. `hitl.otp-requested`) to know when to post to Slack.

```bash
ss -tlnp | grep 4222
# if not running:
kubectl port-forward -n browser-hitl svc/browser-hitl-nats 4222:4222 &
```

#### 3. Build and start

```bash
pnpm --filter @browser-hitl/shared build
pnpm --filter @browser-hitl/slack-bot build

set -a && source .env.local && set +a
pnpm --filter @browser-hitl/slack-bot start:soft
```

Or use the Makefile helpers:

```bash
make local-slack-soft-up       # start in background
make local-slack-soft-status   # verify running
make local-slack-soft-logs     # tail the log
```

#### How it works

```
Worker hits OTP step
  → publishes hitl.otp-requested.{sessionId} on NATS
  → soft bridge picks it up
  → posts to #tabby-experiments: "Session abc123 needs OTP"

Human replies in Slack:
  OTP abc123 123456

Soft bridge reads the message (polling every 3s)
  → calls POST /sessions/abc123/otp on the API
  → API writes code to Redis
  → worker picks it up, fills the field, continues
```

Supported Slack commands:


| Command                   | What it does                    |
| ------------------------- | ------------------------------- |
| `OTP <session_id> <code>` | Submit an OTP code to a session |
| `OPEN <session_id>`       | Get the VNC stream URL          |


#### Stop

```bash
make local-slack-soft-down     # stop the bridge
# or
make local-fresh-down          # stops Slack bridge + NATS + ngrok
```

### Option B: In-Cluster Slack Bot (production)

The full Slack bot runs inside K8s with Socket Mode and provides interactive buttons/modals in Slack. It requires additional Slack app configuration:

- **Signing Secret** — from the Slack app's "Basic Information" page
- **App-Level Token** (`xapp-...`) — generate one with `connections:write` scope under "Basic Information → App-Level Tokens"
- **Socket Mode** — enable under "Socket Mode" in the Slack app settings
- **Interactivity** — enable under "Interactivity & Shortcuts"

Deploy with Helm:

```bash
helm upgrade --install browser-hitl charts/browser-hitl \
  -f charts/browser-hitl/values-local.yaml \
  --namespace browser-hitl \
  --set slackBot.enabled=true \
  --set secrets.slackBotToken="xoxb-..." \
  --set secrets.slackSigningSecret="..." \
  --set secrets.slackAppToken="xapp-..."
```

Verify the pod starts:

```bash
kubectl -n browser-hitl get pods -l app=browser-hitl-slack-bot
kubectl -n browser-hitl logs deployment/browser-hitl-slack-bot
```

---

## Building Login DSL Steps from Playwright Codegen

There is no built-in recorder in Tabby. The recommended workflow is to use Playwright's `codegen` tool to record a login flow interactively, then translate the output to Tabby's DSL format.

### Step 1 — Record the flow

```bash
cd apps/worker
npx playwright codegen https://your-target-app.com/login
```

A browser opens and you interact manually (type email, password, click submit, etc.). The right-hand inspector panel shows the generated Playwright code in real time. Copy it when done.

### Step 2 — Translate to DSL


| Playwright statement          | Tabby DSL step                                     |
| ----------------------------- | -------------------------------------------------- |
| `page.goto(url)`              | `{"action":"goto","url":"..."}`                    |
| `locator(sel).fill(val)`      | `{"action":"fill","selector":"...","value":"..."}` |
| `locator(sel).click()`        | `{"action":"click","selector":"..."}`              |
| `locator(sel).press('Enter')` | `{"action":"keyboard","key":"Enter"}`              |
| `locator(sel).waitFor()`      | `{"action":"wait_for","selector":"..."}`           |
| `page.waitForURL(pattern)`    | `{"action":"wait_for_url","pattern":"..."}`        |
| `page.waitForTimeout(ms)`     | `{"action":"sleep","ms":...}`                      |
| `frameLocator(sel)`           | `{"action":"frame","selector":"..."}`              |
| `page.screenshot()`           | `{"action":"screenshot"}`                          |


Replace hardcoded credential values with the interpolation variables `${USERNAME}` and `${PASSWORD}` — they are injected from the K8s secret at runtime and never logged.

### Step 3 — Handle MFA / OTP fields

Mark the `wait_for` step on the OTP input field with `"sensitive": true`. This is the **signal to the worker** that it should pause and wait for a human to supply the code.

**How it works under the hood:**

When the worker executes a `wait_for` step with `sensitive: true`, instead of just waiting for the element to appear it starts the OTP relay loop:

```
Worker                         Redis                    Human (Slack / Dashboard)
  |                               |                               |
  |── wait_for (sensitive) ──────>|                               |
  |   polls otp:{session_id}      |                               |
  |   every 1 second              |<── POST /sessions/:id/otp ───|
  |                               |   writes otp:{session_id}     |
  |<── value found ───────────────|                               |
  |   fills OTP into field        |                               |
  |   deletes key immediately     |                               |
```

The OTP value lives in Redis with a 60-second TTL and is deleted the moment the worker reads it — it is never written to logs, screenshots, or audit events.

### HubSpot example — full DSL

Starting from this recorded Playwright output:

```js
await page.goto('https://app-na2.hubspot.com/login');
await page.locator('[data-test-id="email-input-field"]').click();
await page.locator('[data-test-id="email-input-field"]').fill('MY_LOGIN');
await page.locator('[data-test-id="email-input-field"]').press('Enter');
await page.locator('[data-test-id="email-submit-button"]').click();
await page.locator('[data-test-id="password-input-field"]').click();
await page.locator('[data-test-id="password-input-field"]').fill('MY_PASSWORD');
await page.locator('[data-test-id="password-login-submit"]').click();
await page.locator('[data-test-id="two-factor-code-input"]').click();
await page.locator('[data-test-id="two-factor-code-input"]').fill('THE OTP CODE');
await page.locator('[data-test-id="2fa-code-submit"]').click();
await page.locator('[data-test-id="2fa-remember-me-button"]').click();
await page.getByRole('button', { name: 'Skip for now' }).click();
```

Translated `login_config` (paste this as the value of the `login_config` field in `POST /apps`):

```json
{
  "login_url": "https://app-na2.hubspot.com/login",
  "credential_ref": "k8s:secret/hubspot-creds",
  "steps": [
    { "action": "goto", "url": "https://app-na2.hubspot.com/login" },

    { "action": "wait_for", "selector": "[data-test-id='email-input-field']" },
    { "action": "fill", "selector": "[data-test-id='email-input-field']", "value": "${USERNAME}" },
    { "action": "keyboard", "key": "Enter" },
    { "action": "click", "selector": "[data-test-id='email-submit-button']" },

    { "action": "wait_for", "selector": "[data-test-id='password-input-field']" },
    { "action": "fill", "selector": "[data-test-id='password-input-field']", "value": "${PASSWORD}", "sensitive": true },
    { "action": "click", "selector": "[data-test-id='password-login-submit']" },

    {
      "action": "wait_for",
      "selector": "[data-test-id='two-factor-code-input']",
      "sensitive": true,
      "timeout_ms": 120000
    },

    { "action": "click", "selector": "[data-test-id='2fa-code-submit']" },
    { "action": "click", "selector": "[data-test-id='2fa-remember-me-button']" },

    { "action": "click", "selector": "button >> text=Skip for now" },
    { "action": "screenshot" }
  ]
}
```

> **Note on OTP:** The `fill` step for the OTP code is gone. Instead, `wait_for` + `sensitive: true` on the OTP field is sufficient — the worker detects it, pauses, polls Redis every second, and fills the code automatically once a human submits it via Slack or the HITL Dashboard. The `timeout_ms` of 120 seconds gives the human 2 minutes to respond before the session fails.

> **Note on `getByRole`:** Playwright's `getByRole('button', { name: 'Skip for now' })` has no direct DSL equivalent — translate it to a text-based CSS selector: `button >> text=Skip for now`, or inspect the element's actual `data-test-id` / `id` / `class` and use that instead.

---

## Quick Reference


| What              | Docker Compose                   | Kubernetes                        |
| ----------------- | -------------------------------- | --------------------------------- |
| Start infra       | `docker compose up -d`           | `make kind-deploy`                |
| **Admin UI**      | N/A                              | `http://localhost:13000`          |
| API URL           | `http://localhost:8080`          | `http://localhost:18080`          |
| Swagger           | `http://localhost:8080/api/docs` | `http://localhost:18080/api/docs` |
| Runs workers?     | No                               | Yes                               |
| Runs controller?  | No                               | Yes                               |
| Browser sessions? | No                               | Yes                               |
| VNC streaming?    | No                               | Yes                               |
| Run tests         | `make test`                      | `make test`                       |
| Build images      | `make docker-build`              | `make docker-build`               |
| Logs (API)        | terminal stdout                  | `make k8s-logs-api`               |
| Logs (controller) | N/A                              | `make k8s-logs-controller`        |
| Stop              | `docker compose down`            | `make k8s-delete`                 |
| Full wipe         | `docker compose down -v`         | `make kind-delete`                |



| Make target                    | What it does                                     |
| ------------------------------ | ------------------------------------------------ |
| `make build`                   | Build all packages                               |
| `make test`                    | Run all 640 tests                                |
| `make lint`                    | Type-check all packages                          |
| `make docker-build`            | Build all Docker images                          |
| `make kind-create`             | Create Kind cluster                              |
| `make kind-deploy`             | Load images + Helm install                       |
| `make k8s-status`              | Show pod/service status                          |
| `make k8s-port-forward`        | Forward API + test harness                       |
| `make harness-run`             | Start mock login app on :8000                    |
| `make local-fresh-e2e`         | Full reliability flow (ngrok + NATS + preflight) |
| `make generate-encryption-key` | Print a new AES-256 key                          |
| `make smoke-test`              | Build + test + lint                              |


---

## Troubleshooting

### Worker gets `ERR_TUNNEL_CONNECTION_FAILED`

**Symptom:** Worker pod logs show `net::ERR_TUNNEL_CONNECTION_FAILED` when trying to navigate to the target URL.

**Root cause:** The egress proxy was returning `403 Forbidden` when Chromium sent the initial CONNECT request without credentials. Chromium's proxy auth flow sends CONNECT without credentials first and only resends with auth after receiving a `407 Proxy Authentication Required` response. A `403` causes Chromium to give up immediately.

**Fix:** The egress proxy's `proxyConnect` function now returns `407` with a `Proxy-Authenticate: Basic` challenge when session credentials are missing, while still returning `403` for blocked hosts (allowlist violations). This is already applied in `charts/browser-hitl/files/egress-proxy/server.js`.

### HubSpot shows "Still not Loading? Unsupported browser"

**Symptom:** The browser reaches HubSpot but the SPA fails to initialize, showing a compatibility error page.

**Root cause:** HubSpot loads JS bundles from `static.hsappstatic.net` which was not in the egress proxy's default allowlist. Without it, the proxy blocks the CDN requests and the SPA can't load.

**Fix:** Add `.hsappstatic.net` (and other HubSpot CDN domains) to `egressProxy.defaultAllowlist` in `values-local.yaml`. This is already applied.

### Slack bot doesn't send OTP notification

**Symptom:** The worker hits the OTP step (`wait_for` with `sensitive: true`), the session transitions to `LOGIN_IN_PROGRESS`, but no Slack message appears.

**Root cause:** The controller publishes `hitl.started` to NATS, which triggers the Slack bot notification. If the controller failed to connect to NATS at startup (e.g., NATS pod wasn't ready yet), it stays disconnected permanently — all publishes silently fail with `NATS not connected`.

**Diagnosis:**

```bash
kubectl logs -n browser-hitl deploy/browser-hitl-controller | grep "NATS"
# Look for: "Failed to connect to NATS: NatsError: CONNECTION_REFUSED"
# or: "NATS not connected, cannot publish to hitl.started..."
```

**Fix:** Restart the controller so it reconnects:

```bash
kubectl rollout restart deployment/browser-hitl-controller -n browser-hitl
```

Verify it connected:

```bash
kubectl logs -n browser-hitl deploy/browser-hitl-controller | grep "Connected to NATS"
# Should show: "Connected to NATS at nats://browser-hitl-nats:4222"
```

### Stream URL returns `http://localhost/vnc/...` (port 80, not working)

**Symptom:** The stream URL from `POST /sessions/:id/stream` points to `http://localhost/vnc/...` instead of `http://localhost:18080/vnc/...`.

**Root cause:** `STREAM_HOST` is not set on the API deployment, so it defaults to `localhost` (port 80).

**Fix:**

```bash
kubectl -n browser-hitl set env deployment/browser-hitl-api STREAM_HOST=localhost:18080
```

> **Note:** This must be re-run after every `helm upgrade --install`, same as the admin-ui fix in step 4.1.

### Admin UI returns `api_unreachable` or `ERR_NAME_NOT_RESOLVED`

**Symptom:** The admin UI at `http://localhost:13000` shows `{"error":"api_unreachable"}` or browser console shows `ERR_NAME_NOT_RESOLVED` for `browser-hitl-api:8080`.

**Root cause:** `NEXT_PUBLIC_API_URL` is baked into the HTML at render time and the **browser** calls the API directly (it's NOT a server-side proxy). If set to the in-cluster service name (`http://browser-hitl-api:8080`), your browser can't resolve it.

**Fix:** Must point to the localhost port-forward:

```bash
kubectl -n browser-hitl set env deployment/browser-hitl-admin-ui \
  NEXT_PUBLIC_API_URL=http://localhost:18080
```

### Wrong OTP code doesn't trigger retry

**Symptom:** You submit an OTP code via Slack, but it's wrong (e.g., misclick). HubSpot shows "incorrect code", loops back to the code entry screen, but the worker has already moved past the `wait_for` OTP step and doesn't poll for a new code.

**Root cause:** The worker fills the OTP field and immediately proceeds to the next DSL step (`click` the submit button). There is no retry loop — if the code is wrong and the site re-displays the OTP input, the worker doesn't know to go back and wait for another code.

**Workaround:** Currently none. You must terminate the session and start a new one. A future fix would add post-submit validation: check if the OTP field reappears after submission and, if so, re-enter the OTP relay polling loop.

### Service auth credentials mismatch (401 / "Invalid service client credentials")

**Symptom:** The Slack soft bridge logs `service-token request failed (401): Service authentication is not configured` or `Invalid service client credentials`.

**Root cause:** The API requires `SERVICE_AUTH_CLIENT_ID` and `SERVICE_AUTH_CLIENT_SECRET` env vars to validate service token requests. These must match what the Slack bot sends (configured in `.env.local`).

**Fix:** Set the env vars on the API deployment to match your `.env.local` values:

```bash
# Check what your .env.local uses:
grep SERVICE_AUTH .env.local

# Set matching values on the API:
kubectl -n browser-hitl set env deployment/browser-hitl-api \
  SERVICE_AUTH_CLIENT_ID=<value-from-env-local> \
  SERVICE_AUTH_CLIENT_SECRET=<value-from-env-local>
```

> **Note:** These are reset after every `helm upgrade --install`.

### "No pending HITL session tracked" when submitting OTP via Slack

**Symptom:** You type `OTP <session_id> <code>` in Slack, but the soft bridge replies "No pending HITL session tracked for session ...".

**Root cause:** Multiple soft bridge instances are running. One instance received the NATS event and stored the session in its in-memory `pendingSessions` map, but a different instance is reading the Slack message and has an empty map.

**Diagnosis:**

```bash
ps aux | grep soft-hitl
# If more than one process appears, kill the old ones
```

**Fix:** Kill all old instances and keep only one:

```bash
pkill -f "soft-hitl-bridge"
# Then restart:
set -a && source .env.local && set +a
pnpm --filter @browser-hitl/slack-bot start:soft
```

### Env vars reset after `helm upgrade`

**Symptom:** After running `helm upgrade --install`, things that were working stop (stream URL wrong, admin UI broken, service auth fails).

**Root cause:** `helm upgrade` resets deployment env vars to what's in the chart templates. Manual `kubectl set env` overrides are lost.

**Fix:** Re-apply all manual env var overrides after every `helm upgrade`:

```bash
# Admin UI API URL (must be localhost — browser makes calls directly)
kubectl -n browser-hitl set env deployment/browser-hitl-admin-ui \
  NEXT_PUBLIC_API_URL=http://localhost:18080

# API stream host
kubectl -n browser-hitl set env deployment/browser-hitl-api \
  STREAM_HOST=localhost:18080

# API service auth (match your .env.local)
kubectl -n browser-hitl set env deployment/browser-hitl-api \
  SERVICE_AUTH_CLIENT_ID=<your-client-id> \
  SERVICE_AUTH_CLIENT_SECRET=<your-secret>
```

### Worker pods keep getting killed in a loop (controller `fetch failed`)

**Symptom:** Worker pods start, run for ~30s, then get SIGTERM. Controller logs show:
```
Failed to create NetworkPolicy: TypeError: fetch failed
Failed to finish runtime provisioning: TypeError: fetch failed
Deleting orphan worker pod ...
```

**Root cause:** The controller calls the egress proxy admin API (`http://browser-hitl-egress-proxy:8095/allowlist`) to set session-scoped allowlists. If the egress proxy is down or crash-looping, this call fails and the controller deletes the worker it just created.

**Fix:** Restart egress proxy first, then controller:
```bash
kubectl -n browser-hitl rollout restart deployment/browser-hitl-egress-proxy
# Wait for it to be Running
kubectl -n browser-hitl rollout restart deployment/browser-hitl-controller
```

### Egress proxy crash-loops with `EPIPE`

**Symptom:** Egress proxy pod keeps restarting. Logs show `Error: write EPIPE` unhandled error.

**Root cause:** Missing `error` handler on `clientSocket` in `server.js`. When a browser disconnects mid-tunnel, the pipe throws EPIPE and crashes the process.

**Fix:** Already patched in `charts/browser-hitl/files/egress-proxy/server.js`. If it recurs, update the configmap and restart:
```bash
kubectl -n browser-hitl create configmap browser-hitl-egress-proxy-config \
  --from-file=server.js=charts/browser-hitl/files/egress-proxy/server.js \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n browser-hitl rollout restart deployment/browser-hitl-egress-proxy
```

### `helm upgrade` fails with "cannot patch" error

**Symptom:** `helm upgrade --install` fails with `spec.template.spec.containers[0].env[N].valueFrom: Invalid value`.

**Root cause:** `kubectl set env` overrides conflict with chart template env vars.

**Fix:** Uninstall and fresh install:
```bash
helm uninstall browser-hitl -n browser-hitl
kubectl -n browser-hitl delete pods --all --force --grace-period=0
helm install browser-hitl charts/browser-hitl -f charts/browser-hitl/values-local.yaml --namespace browser-hitl --create-namespace
```
Then re-apply env overrides (see "Env vars reset after helm upgrade" below).

### Slack notification says "Salesforce Authentication" for all apps

**Symptom:** The Slack HITL notification says "Salesforce Authentication required" even when logging into HubSpot or other apps.

**Status:** Fixed. The `app_name` is now propagated through the HITL event pipeline (controller → NATS → Slack bot). Notifications display the actual application name.
