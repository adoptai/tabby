# Tabby Platform Integration — Local Testing

## Ports

| Service | Port |
|---------|------|
| adoptwebui backend | **8000** |
| adoptai-workflows | **8001** |
| adoptwebui frontend | 3000 |
| Tabby API (Kind) | 18080 |
| Tabby Admin UI (Kind) | 13000 |
| Temporal | 7233 (gRPC) / 8233 (UI) |

DB, Redis, S3 — staging envs (already configured).

> **Both backend and workflows default to 8000.** You MUST run workflows on 8001 to avoid conflict. Frontend expects backend at 8000.

---

## Start everything

### 1. Tabby (Kind)

```bash
cd ~/work/tabby
make kind-reload-all    # build + deploy (~3-5 min)
make k8s-port-forward   # API:18080, Admin:13000, etc
```

Verify: `curl -s http://localhost:18080/health/live`

### 2. Temporal

```bash
temporal server start-dev --db-filename /tmp/temporal.db
```

### 3. adoptai-workflows (port 8001)

```bash
cd ~/work/adoptai-workflows
workon adoptai-workflows

# Terminal A: API — NOTE: port 8001, NOT 8000 (backend takes 8000)
poetry run uvicorn api.app.main:app --host 0.0.0.0 --port 8001 --reload

# Terminal B: Worker
poetry run python -m src.worker
```

### 4. adoptwebui backend (port 8000)

```bash
cd ~/work/adoptwebui/backend
workon adoptwebgui
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

> Backend `.env` must have:
> ```
> ADOPT_WORKFLOW_URL="http://localhost:8001"
> ADOPT_LONG_RUNNING_WORKFLOW_URL="http://localhost:8001"
> ```

### 5. adoptwebui frontend

```bash
cd ~/work/adoptwebui/frontend
yarn start   # port 3000
```

---

## Env check

Your `.env` files must have:

```bash
# adoptwebui/backend/.env
ADOPT_WORKFLOW_URL="http://localhost:8001"              # → workflows on 8001
ADOPT_LONG_RUNNING_WORKFLOW_URL="http://localhost:8001"

# adoptwebui/frontend/.env (already correct)
REACT_APP_BASE_URL="http://localhost:8000"              # → backend on 8000
REACT_APP_API_BASE_URL="http://localhost:8000"
```

---

## How the invisible middleware works

```
Token Manager: storage_type=TABBY, tabby_profile_id, credential_path
Playground Profile: tabby_url, tabby_client_id, tabby_client_secret
Deployment Rules: use_tabby=true (per action)

User sends message →
  adoptwebui checks deployment rules →
  calls Tabby /credentials/request →
  navigates credential_path → literal value →
  replaces in security_headers →
  dispatches to Temporal with resolved headers →
  ProjectA3 gets literal headers (zero changes)
```

LLM never sees tokens. WDL never handles credentials. Everything invisible.

---

## Tabby setup (one-time per website)

### 1. Create tenant + agent client

```bash
TOKEN=$(curl -s http://localhost:18080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' | jq -r .access_token)

curl -s http://localhost:18080/admin/agent-clients \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "platform-agent",
    "allowed_profiles": ["salesforce-prod"],
    "tenant_id": "<your-tenant-id>"
  }' | jq .
# Save client_id and client_secret (shown once)
```

### 2. Create app + profile

```bash
curl -s http://localhost:18080/apps \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "name": "...", "target_urls": [...], "login_config": {...}, "export_policy": {...}, "keepalive_config": {...} }'

curl -s http://localhost:18080/profiles \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "profile_id": "salesforce-prod", "app_id": "<app-id>", "version": "1.0.0", "login_config": {...}, "credential_types": {...}, "target_domains": [...] }'
```

### 3. Start session + login via VNC

```bash
curl -s -X PUT http://localhost:18080/apps/<app-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"desired_session_count": 1}'
```

Complete login via VNC. Session must reach HEALTHY.

### 4. Promote profile to ACTIVE

STAGING → CANARY → ACTIVE (5 successful credential requests through CANARY).

### 5. Verify

```bash
AGENT_TOKEN=$(curl -s http://localhost:18080/auth/agent-token \
  -H "Content-Type: application/json" \
  -d '{"client_id":"platform-agent","client_secret":"<secret>","grant_type":"client_credentials"}' | jq -r .access_token)

curl -s http://localhost:18080/credentials/request \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile_id":"salesforce-prod"}' | jq .credentials.custom
```

---

## Platform integration tests

### Test 1: Token resolution (happy path)

1. Create Token Config → storage type: `Tabby (Server-side)`, profile ID: `salesforce-prod`, credential path: `custom.Cookie`
2. Create Playground Profile → Tabby URL: `http://localhost:18080`, Client ID + Secret
3. Set action deployment rules → `use_tabby: true`
4. Start conversation → backend resolves tokens from Tabby, no Chrome tab needed

### Test 2: Chrome Extension regression

1. Use a profile WITHOUT Tabby config, deployment rules `use_tabby: false`
2. Start conversation → Chrome Extension resolves as before
3. No Tabby calls in logs

### Test 3: Chat HITL

1. Force session to LOGIN_NEEDED (stop worker pod)
2. Send message → inline HITL card appears (VNC link + resolve button)
3. Open VNC → log in → click "I've resolved the login"
4. Send next message → works

### Test 4: Pipeline HITL (dashboard)

1. Force session to LOGIN_NEEDED
2. Trigger pipeline → escalation appears in HITL dashboard with blue "Tabby" tag
3. Open escalation → VNC panel + session state
4. Resolve via VNC → escalation auto-closes
5. Re-trigger pipeline → succeeds

### Test 5: Error cases

1. Invalid profile ID → clear error
2. Tabby unreachable → timeout + error, CE profiles unaffected
3. No session exists → 404, clear error

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Token resolution not happening | Check deployment rules: `use_tabby` must be `true` |
| "Tabby session needs login" in chat | Session not HEALTHY — resolve via VNC, retry |
| Agent gets 403 on credentials | `allowed_profiles` doesn't include the profile ID |
| No HITL card in chat | Verify `conversation.py` has the `tabby_hitl_required` return path |
| No Tabby tag in dashboard | Check escalation `source_type` = `"tabby"` |
| Credentials empty | `TENANT_ENCRYPTION_KEY` must match on API + worker (64 hex chars) |
| Slack-bot image missing | `docker build -f infra/docker/Dockerfile.slack-bot -t browser-hitl/slack-bot:dev . && kind load docker-image browser-hitl/slack-bot:dev --name tabby-dev` |
| Temporal workers stale | Restart adoptai-workflows — workers don't hot-reload |
| Kind pods `ImagePullBackOff` | `make kind-load-images` or `make kind-reload-all` |

---

## Verify components

```bash
curl -s http://localhost:18080/health/live          # Tabby API
kubectl get pods -n browser-hitl                     # Tabby pods
temporal workflow list --address localhost:7233       # Temporal
curl http://localhost:8000/health                     # adoptwebui backend
curl http://localhost:8001/health                     # adoptai-workflows
```

---

## Architecture

```
User → frontend:3000 → backend:8000 → workflows:8001 → Temporal → ProjectA3
                            │
                            │ (if use_tabby)
                            ▼
                     Tabby Kind:18080
                     /credentials/request
                     /agent/session-status
```

HITL flow:
```
Token resolution fails (404)
  → Chat: return tabby_hitl_required → frontend shows VNC card
  → Pipeline: create escalation (source_type: tabby) → dashboard shows Tabby panel
  → Operator resolves via VNC → session HEALTHY → retry works
```
