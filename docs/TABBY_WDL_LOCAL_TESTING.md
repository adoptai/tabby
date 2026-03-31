# Tabby Local Testing — Full Platform Integration

End-to-end checklist for testing Tabby as an invisible credential provider integrated with the AdoptAI platform (adoptwebui, adoptai-workflows, ProjectA3).

> Canonical platform setup reference: [HITL Platform — End-to-End Local Run Guide](https://adoptai.atlassian.net/wiki/spaces/SD/pages/508329986) (Confluence).
> This doc adds Tabby-specific steps on top of that guide.

---

## Quick Reference

| Service | Port | Tech | Package Manager |
|---------|------|------|-----------------|
| Tabby API (Kind) | 18080 | NestJS (K8s) | `pnpm` / Helm |
| Tabby Admin UI (Kind) | 13000 | Next.js (K8s) | `pnpm` / Helm |
| Temporal server | 7233 (gRPC) / 8233 (UI) | Go binary | `brew install temporal` |
| adoptai-workflows (API + worker) | 8000 | Python 3.13.12 + Poetry | `poetry` |
| adoptwebui backend | 8001 | Python 3.13.12 + pip | `pip` in `.venv` |
| adoptwebui frontend | 3000 | Node v24 + npm | `npx react-scripts` |
| adoptwebui experience | 8080 | Node v24 + yarn | `yarn` |
| adoptai-js-sdk | 8081 | Node v24 + npm | `npm` |
| MySQL 8.0 | 3307 | Docker | `docker compose` |
| SingleStore | 3306 | Docker | `docker compose` |
| Redis 7 (Kind) | 16379 | K8s | Kind port-forward |
| LocalStack (S3) | 4566 | Docker | `docker compose` |

---

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| Docker | For Kind cluster, SingleStore, MySQL, LocalStack |
| Node.js v24+ | `nvm install 24 && nvm use 24` |
| pnpm 10+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| Python 3.13.12 | Exact version — `pyenv install 3.13.12 && pyenv global 3.13.12` |
| Poetry | Inside adoptai-workflows venv |
| Temporal CLI | `brew install temporal` or `temporal server start-dev` |
| Kind + kubectl | For Tabby cluster |

**Python version rule**: 3.13.12 is the exact required version. Each repo has a `.python-version` file. Do NOT use 3.12.x or 3.14.x.

**Repos (siblings under a shared parent, e.g. `~/work/`):**

- `tabby` — Browser HITL engine (runs in Kind)
- `ProjectA3` — Library only (no independent venv); WDL execution code
- `adoptai-workflows` — Temporal API + worker; imports ProjectA3 as a dependency
- `adoptwebui` — Backend (FastAPI) + frontend (React) + experience service

**Feature branches:**

| Repo | Branch | Purpose |
|------|--------|---------|
| `tabby` | `feat/tabby-wdl-agent-api` | Agent API + allowed_profiles fix |
| `adoptwebui` | `feat/tabby-token-manager-integration` | Token Manager TABBY type + resolution + HITL |
| `adoptai-workflows` | `docs/tabby-token-resolution-note` | Docs only |
| `ProjectA3` | `docs/tabby-token-resolution-note` | Docs only |

> **IMPORTANT**: `adoptai-workflows` depends on `ProjectA3` as a local path dependency. Both must be on matching branches. Mismatched branches cause runtime errors at executor dispatch time.

---

## Infrastructure setup

### Tabby — full Kind cluster

```bash
cd ~/work/tabby
pnpm install --frozen-lockfile
make kind-create        # one-time: creates "tabby-dev" Kind cluster
make kind-reload-all    # clean + build + docker-build + load + helm upgrade (~3-5 min first time)
make k8s-port-forward   # API:18080, Admin UI:13000, Postgres:25432, Redis:16379, MinIO:19000, NATS:4222
```

Verify: `curl -s http://localhost:18080/health/live`

All Tabby config (secrets, DB, Redis, NATS, MinIO) is baked into `charts/browser-hitl/values-local.yaml` — no manual env vars needed for Kind.

### Platform Docker infrastructure

The team uses a `docker-compose.local.yml` (not in repos — obtain from a teammate) that runs MySQL, SingleStore, Redis, and LocalStack. Place it in your parent working directory alongside the repos.

```bash
# From parent directory (e.g. ~/work/)
docker compose -f docker-compose.local.yml up -d
docker compose -f docker-compose.local.yml ps
```

| Service | Image | Port |
|---------|-------|------|
| MySQL | `mysql:8.0` | 3307 |
| SingleStore | SingleStore | 3306 |
| LocalStack | `localstack/localstack` | 4566 |

> **Redis**: Skip the Redis container from `docker-compose.local.yml`. Use Tabby's Kind Redis port-forwarded to `localhost:16379` instead. Point all services' `REDIS_HOST=localhost` / `REDIS_PORT=16379`.

If you don't have `docker-compose.local.yml`, start services individually:

```bash
# SingleStore + LocalStack (from ProjectA3)
cd ~/work/ProjectA3 && docker compose -f docker-compose.singlestore.yml up -d

# MySQL 8.0 (if not included in above compose)
docker run -d --name mysql-local -e MYSQL_ROOT_PASSWORD=localdev -p 3307:3306 mysql:8.0
```

### S3 buckets (first time only)

```bash
aws --endpoint-url=http://localhost:4566 s3 mb s3://adopt-data-dev
aws --endpoint-url=http://localhost:4566 s3 mb s3://adoptorgnetworkfiles-raw
aws --endpoint-url=http://localhost:4566 s3 mb s3://adoptorgapifilesdev
```

### Temporal

```bash
temporal server start-dev --db-filename /tmp/temporal.db
```

UI at [http://localhost:8233](http://localhost:8233).

---

## Python service setup

### ProjectA3 — library only, no venv

```bash
cd ~/work/ProjectA3
git branch --show-current  # verify correct branch
```

ProjectA3 has no independent venv. It is imported by `adoptai-workflows` via path dependency.

### adoptai-workflows — venv + Poetry

```bash
cd ~/work/adoptai-workflows

# 1. Create venv with exact Python version
python3.13 -m venv venv
source venv/bin/activate

# 2. Install poetry inside the venv
pip install --upgrade pip && pip install poetry
which poetry  # must show .../adoptai-workflows/venv/bin/poetry

# 3. Install deps using local ProjectA3
PROJECTA3_USE_LOCAL=1 PROJECTA3_PATH=$(cd ../ProjectA3 && pwd) \
  python3.13 install_dependencies.py feature/pipeline2-escalate-forward-path

# 4. Verify
poetry run python -c "import actionbot; print('ProjectA3 OK')"
poetry run python -c "from temporalio.client import Client; print('Temporal OK')"
```

### adoptwebui backend — venv + pip (NOT poetry)

```bash
cd ~/work/adoptwebui/backend
python3.13 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip && pip install -r requirements.txt
python -c "import fastapi; import singlestoredb; print('Backend OK')"
```

> `adoptwebui/backend` uses pydantic **2.8.2**; `adoptai-workflows` uses **2.12.x**. Never mix their venvs.

### Node.js services

```bash
nvm use 24
cd ~/work/adoptwebui/frontend  && npm install
cd ../experience && yarn install
```

---

## Environment files

Env files are gitignored. Key variables per service:

### `adoptai-workflows/.env`

```bash
ENVIRONMENT=development
SINGLESTORE_HOST=localhost  SINGLESTORE_PORT=3306  SINGLESTORE_USER=root  SINGLESTORE_PASSWORD=localdev
MYSQL_HOST=localhost         MYSQL_PORT=3307         MYSQL_USER=root         MYSQL_PASSWORD=localdev
TEMPORAL_HOST=localhost      TEMPORAL_PORT=7233      TEMPORAL_NAMESPACE=default
REDIS_HOST=localhost         REDIS_PORT=16379
REDIS_ENABLED=true
AWS_ACCESS_KEY_ID=test       AWS_SECRET_ACCESS_KEY=test   AWS_ENDPOINT_URL=http://localhost:4566
S3_BUCKET=adopt-data-dev
LLM_GATEWAY_URL=<url>       LLM_GATEWAY_API_KEY=<key>
FRONTEGG_CLIENT_ID=<id>      FRONTEGG_SECRET=<secret>
PUSHER_ENABLED=True
```

### `adoptwebui/backend/.env`

```bash
APP_ENV=DEVELOPMENT          APP_BASE_URL=http://localhost:8001
DB_S2_ENDPOINT=localhost     DB_S2_PORT=3306    DB_S2_USERNAME=root    DB_S2_PASSWORD=localdev
MYSQL_DB_HOST=localhost      MYSQL_DB_PORT=3307  MYSQL_DB_USERNAME=root MYSQL_DB_PASSWORD=localdev
AWS_ACCESS_KEY_ID=test       AWS_SECRET_ACCESS_KEY=test   AWS_ENDPOINT_URL=http://localhost:4566
ADOPT_WORKFLOW_URL=http://localhost:8000
REDIS_HOST=localhost         REDIS_PORT=16379
FRONTEGG_JWT_PUBLIC_KEY=<RSA public key>   FRONTEGG_JWT_ALGORITHM=RS256
```

### `adoptwebui/frontend/.env`

```bash
REACT_APP_BASE_URL=http://localhost:8001
REACT_APP_API_BASE_URL=http://localhost:8000
REACT_APP_APP_BASE_URL=http://localhost:3000
REACT_APP_ADOPT_COPILOT_URL=http://localhost:8081/dist/index.js
REACT_APP_FRONTEGG_CLIENT_ID=<id>
```

---

## Start services (order)

> **Temporal workers do NOT hot-reload.** After any code change in `adoptai-workflows/src/` or `ProjectA3/actionbot/`, you must restart the workflows service (Ctrl+C and re-run).

### 1. Tabby — port 18080 (Kind)

Already running from infra setup above. Verify:

```bash
curl -s http://localhost:18080/health/live
make k8s-status   # all pods should be Running
```

Swagger: [http://localhost:18080/api/docs](http://localhost:18080/api/docs)

### 2. adoptai-workflows — port 8000

```bash
cd ~/work/adoptai-workflows
source venv/bin/activate
bash startup.sh
```

If you prefer separate terminals:

```bash
# Terminal A: API
cd ~/work/adoptai-workflows && source venv/bin/activate
poetry run uvicorn api.app.main:app --host 0.0.0.0 --port 8000 --reload

# Terminal B: Worker
cd ~/work/adoptai-workflows && source venv/bin/activate
poetry run python src/start_workers.py
```

### 3. adoptwebui backend — port 8001

```bash
cd ~/work/adoptwebui/backend
source .venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

### 4. adoptwebui frontend — port 3000

```bash
cd ~/work/adoptwebui/frontend
PORT=3000 BROWSER=none npx react-scripts start
```

### 5. adoptwebui experience — port 8080

```bash
cd ~/work/adoptwebui/experience
yarn start
```

---

## How the Invisible Middleware Works

Tabby is an **alternative to the Chrome Extension** for credential resolution. The platform resolves tokens server-side — no browser tab needed.

```
1. Token Manager:  storage_type=TABBY, tabby_profile_id, credential_path
2. Playground Profile:  tabby_url, tabby_client_id, tabby_client_secret
3. Deployment Rules:  use_tabby=true (per action)
4. User sends message →
   adoptwebui checks deployment rules →
   if use_tabby: calls Tabby /credentials/request →
   navigates credential_path → extracts literal value →
   replaces token name in security_headers →
   dispatches to Temporal with resolved headers
5. ProjectA3 receives literal headers (same as Chrome Extension flow)
```

**The LLM never sees tokens. The WDL never handles credentials. Everything is invisible.**

---

## Tabby Setup (one-time per website)

Before the platform can consume credentials from Tabby:

### 1. Create tenant + agent client

```bash
# Admin login (bootstrap)
TOKEN=$(curl -s http://localhost:18080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' | jq -r .access_token)

# Create agent client with allowed_profiles
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
# Create app with login DSL, export_policy, keepalive
curl -s http://localhost:18080/apps \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Salesforce Production",
    "target_urls": ["https://*.salesforce.com", "https://*.force.com"],
    "login_config": { "login_url": "https://login.salesforce.com", "credential_ref": "k8s:secret/sf-creds", "steps": [...] },
    "export_policy": { "artifact_types": ["cookies","headers","local_storage"], "encryption": {"algo":"AES-256-GCM","key_ref":"k8s:secret/tenant-key"}, "ttl_seconds": 3600, "custom_extractions": [...] },
    "keepalive_config": { ... },
    "notification_config": { "channels": [] }
  }'

# Create profile
curl -s http://localhost:18080/profiles \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "profile_id": "salesforce-prod",
    "app_id": "<app-id>",
    "version": "1.0.0",
    "login_config": { ... },
    "credential_types": { "standard": { "cookies": "ALL", "headers": ["authorization"] } },
    "target_domains": ["salesforce.com"]
  }'
```

### 3. Start session + complete initial login

```bash
# Scale sessions
curl -s -X PUT http://localhost:18080/apps/<app-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"desired_session_count": 1}'

# Watch session status
curl -s http://localhost:18080/agent/session-status/salesforce-prod \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

Complete initial login via VNC (HITL). Session must reach HEALTHY state.

### 4. Promote profile to ACTIVE

Profile must go through STAGING → CANARY → ACTIVE. ACTIVE requires 5 successful credential requests through CANARY.

### 5. Verify credentials work

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

## Platform Integration Testing

### Test 1: Token Resolution — Happy Path

1. In adoptwebui, create a Token Config:
   - Storage type: `Tabby (Server-side)`
   - Tabby Profile ID: `salesforce-prod`
   - Credential Path: `custom.Cookie`
2. Create a second Token Config: same profile, credential_path: `custom.access_token`
3. Create/edit a Playground Profile:
   - Tabby URL: `http://localhost:18080`
   - Client ID: `platform-agent`
   - Client Secret: `<your-secret>`
   - Security Headers: `Cookie → sf-cookie`, `Authorization → sf-bearer`
4. Set the action's deployment rules: `use_tabby: true`
5. Start a conversation using that action → verify backend resolves tokens server-side
6. Check ProjectA3 logs — Cookie and Authorization headers present with real Salesforce values

### Test 2: Token Freshness / Caching

1. Send a message → tokens resolved
2. Send another message within TTL → verify cache hit (check adoptwebui logs for "cache hit" vs Tabby API call)
3. Wait for TTL expiry → send message → verify fresh resolve from Tabby
4. Use `force_refresh: true` on the resolve endpoint → verify cache bypassed

### Test 3: Chrome Extension Regression

1. Create a Playground Profile WITHOUT Tabby connection fields
2. Set action deployment rules: `use_tabby: false` (or don't set it)
3. Start conversation → verify Chrome Extension resolves tokens as before
4. Verify no Tabby calls made in adoptwebui logs

### Test 4: Chat HITL — Session Needs Login

1. Force Tabby session to LOGIN_NEEDED (stop the worker pod or expire the session)
2. Send a message in conversation using the Tabby action
3. Verify inline HITL card appears in chat:
   - VNC link visible and clickable
   - "Open Browser" and "I've resolved the login" buttons rendered
   - Fallback clickable link present
4. Click "Open Browser" → VNC opens in new tab, browser visible
5. Log in via VNC manually
6. Click "I've resolved the login" → card dismisses
7. Send next message → tokens resolve, conversation continues normally

### Test 5: Chat HITL — Sequential Inputs (Salesforce)

1. Force Salesforce session to require password + OTP
2. Send message → HITL card appears
3. Open VNC → enter password → submit
4. Session progresses to OTP step
5. Enter OTP via VNC
6. Session becomes HEALTHY
7. Click "I've resolved the login"
8. Send next message → works

### Test 6: Pipeline HITL — Caio's Dashboard

1. Create a pipeline using the Tabby action
2. Force Tabby session to LOGIN_NEEDED
3. Trigger pipeline → verify it fails at token resolution
4. Verify escalation appears in HITL dashboard with blue "Tabby" tag
5. Open escalation → verify Tabby panel shows:
   - Session state badge (LOGIN_NEEDED)
   - VNC iframe or link
   - Input form (if pending input detected)
6. Resolve login via VNC
7. Verify escalation auto-closes when session becomes HEALTHY
8. Re-trigger pipeline → succeeds

### Test 7: Error Cases

1. Invalid `tabby_profile_id` → verify clear error message in chat
2. Tabby unreachable (wrong URL) → verify timeout + error, CE profiles unaffected
3. Expired agent credentials → verify 401 from Tabby, clear error to user
4. No session exists at all → verify 404, clear error

### Test 8: Frontend UI

1. Token Config Editor → select "Tabby (Server-side)" → verify fields appear (Profile ID, Credential Path)
2. "Test" button → verify it calls `/v1/token-configs/resolve` and shows result/error
3. Profile Editor → add Tabby URL, Client ID, Client Secret → save → verify persisted
4. Action Deployment Rules → toggle "Use Tabby" → save → verify persisted
5. HITL Dashboard → create a Tabby escalation → verify Tabby panel renders (not CONFIRM/CORRECT/REJECT)

---

## Troubleshooting

### Tabby

| Symptom | Likely cause | What to do |
|--------|----------------|------------|
| Credentials empty or decryption wrong | Missing / mismatched `TENANT_ENCRYPTION_KEY` on API | Set 64 hex chars; same key as worker |
| Cannot log into Postgres after changing password | Postgres PVC keeps old password | `kubectl delete pvc ...` + pod to re-init |
| `POST /apps` rejects `notification_config` | Invalid channel string | Use `slack:…`, `teams:…`, or `agent:<ref>`. Or omit entirely. |
| Session never leaves `STARTING`, no VNC | No worker/controller | Use full Kind setup: `make kind-reload-all && make k8s-port-forward` |
| Agent token fails | `AGENT_SECRET_HMAC_KEY` unset or client mis-scoped | Set HMAC key; `allowed_profiles` must include profile id |
| Agent gets 403 on `/credentials/request` | Profile not in `allowed_profiles` | Update agent client's `allowed_profiles` to include the profile |

### Platform Integration

| Symptom | Fix |
|---------|-----|
| Token resolution not happening | Check action's deployment rules — `use_tabby` must be `true` |
| "Tabby session needs login" in chat | Session not HEALTHY — resolve via VNC, then retry |
| No HITL card in chat | Check if backend returns `tabby_hitl_required` — verify conversation.py was modified |
| No Tabby tag in HITL dashboard | Check escalation's `source_type` — should be `"tabby"` |
| Tabby tokens not resolving but CE works | Verify Token Config has `storage_type: tabby` + correct `credential_path` |
| Profile missing Tabby fields | Run the Alembic migration: `alembic upgrade head` |
| `poetry not found` after venv activation | `pip install poetry` inside the venv |
| Worker doesn't see code changes | Restart workflows service — Temporal workers don't hot-reload |
| Backend `.venv` broken | `rm -rf .venv && python3.13 -m venv .venv && pip install -r requirements.txt` |
| Workflow calls fail from webui | Confirm `ADOPT_WORKFLOW_URL=http://localhost:8000` and Temporal worker is running |

### Ports & Redis

- **16379**: Tabby Kind Redis (via `make k8s-port-forward`). All platform services share this.
- **3306**: SingleStore. **3307**: MySQL 8.0. Don't confuse them.
- **Swagger 404**: Use `/api/docs` on Tabby API.

---

## Verify each component

| Component | Check |
|-----------|--------|
| Tabby API (Kind) | `curl -s http://localhost:18080/health/live` |
| Tabby pods (Kind) | `make k8s-status` or `kubectl get pods -n browser-hitl` |
| Postgres (Kind) | `kubectl exec -n browser-hitl svc/browser-hitl-postgres -- pg_isready -U browser_hitl` |
| Redis (Kind) | `kubectl exec -n browser-hitl svc/browser-hitl-redis -- redis-cli ping` |
| NATS | `curl -s http://localhost:8222/healthz` |
| MinIO (Kind) | Console http://localhost:19000 |
| Temporal | `temporal workflow list --address localhost:7233` / UI http://localhost:8233 |
| adoptai-workflows | `curl http://localhost:8000/health` |
| adoptwebui backend | `curl http://localhost:8001/health` |
| SingleStore | `mysql -h 127.0.0.1 -P 3306 -u root -plocaldev -e "SHOW DATABASES;"` |
| MySQL | `mysql -h 127.0.0.1 -P 3307 -u root -plocaldev -e "SHOW DATABASES;"` |
| LocalStack S3 | `aws --endpoint-url=http://localhost:4566 s3 ls` |

---

## Architecture

```
                   ┌────────────────────────────────────────────┐
                   │  Kind cluster (Tabby)                      │
                   │  API:18080  Admin:13000  Postgres:25432    │
                   │  Redis:16379  NATS:4222  MinIO:19000       │
                   └──────────────────┬─────────────────────────┘
                                      │
        ┌─────────────────────────────┼──────────────────────────┐
        │                             │                          │
   ┌────▼────┐  ┌─────────────────────▼───────────┐  ┌──────────▼─────┐
   │Temporal │  │ adoptai-workflows               │  │ adoptwebui     │
   │:7233    │◄─│ API :8000 + workers             │  │ backend :8001  │
   │UI :8233 │  │ + ProjectA3 (lib)               │◄─│ (resolves      │
   └─────────┘  │ (receives resolved headers)     │  │  Tabby tokens) │
                └─────────────────────────────────┘  └──────┬─────────┘
                                                             │
                   ┌──────────┬──────────────────────────────┘
                   │          │                    │
             frontend:3000  experience:8080  js-sdk:8081

   Docker: SingleStore:3306  MySQL:3307  LocalStack:4566
```

**Token resolution flow:**
```
User sends message → adoptwebui backend
  → checks deployment rules (use_tabby?)
  → if yes: POST {tabby_url}/auth/agent-token (authenticate)
  → POST {tabby_url}/credentials/request (fetch credentials)
  → navigate credential_path → extract literal value
  → replace token name in security_headers
  → dispatch to Temporal with resolved headers
  → ProjectA3 executes REST calls with real Cookie/Authorization headers
```

**HITL flow (session not healthy):**
```
Token resolution fails (404 from Tabby)
  → GET {tabby_url}/agent/session-status/{profileId}
  → Chat: return tabby_hitl_required payload → frontend shows VNC card
  → Pipeline: create HITL escalation (source_type: tabby) → dashboard shows Tabby panel
  → Operator resolves via VNC → session becomes HEALTHY
  → User retries → works
```

---

## Related docs

- Tabby local API: `STARTUP.md` (repo root)
- Tabby agent + credentials: `tabby-abcd-integration-guide.md`
- Platform integration plan: `~/.claude/plans/graceful-discovering-widget.md`
- [HITL Platform — End-to-End Local Run Guide](https://adoptai.atlassian.net/wiki/spaces/SD/pages/508329986) (Confluence)
- [HITL Master Reference](https://adoptai.atlassian.net/wiki/spaces/SD/pages/507904002) (Confluence)
