# Tabby WDL local testing

End-to-end checklist: Tabby (apps + sessions + credentials), ProjectA3 WDL executor (`TABBY` operation), adoptai-workflows (Temporal), and adoptwebui (pipeline UI).

---

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| Docker | For Postgres, Redis, NATS, MinIO (Tabby), SingleStore + LocalStack (ProjectA3) |
| Node.js 20+ | Tabby monorepo |
| pnpm 10+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| Python 3.13+ | adoptai-workflows / adoptwebui (match `pyproject.toml` pin, e.g. 3.13.12) |
| Poetry | Inside each Python project’s venv |
| Temporal CLI | `temporal server start-dev` for local dev server |

**Repos (siblings under `~/work/`):**

- `tabby` — Tabby API + `docker compose` infra
- `ProjectA3` — SingleStore compose; WDL execution code (`actionbot`, `TABBY` step) is pulled into adoptai-workflows via Poetry (`projecta3` git dependency). A local clone is still required for `docker-compose.singlestore.yml` and for aligning branches with `install_dependencies.py`.
- `adoptai-workflows` — Temporal API + worker; runs `PipelineWorkflowExecutor` from ProjectA3
- `adoptwebui` — Backend + frontend for pipeline runs and HITL UI

**adoptai-workflows install:** From `~/work/adoptai-workflows`, use the repo’s installer so ProjectA3 matches your branch:

```bash
python3.13 install_dependencies.py dev   # or main / feature branch name
```

---

## Infrastructure setup

### SingleStore + LocalStack (ProjectA3)

```bash
cd ~/work/ProjectA3 && docker compose -f docker-compose.singlestore.yml up -d
```

adoptai-workflows expects SingleStore (and related config) to be available for pipeline/org config — follow ProjectA3 and adoptai-workflows `.env` / Confluence env docs for connection strings.

### Redis

`~/work/tabby/docker-compose.yml` already runs **Redis on `6379`**. Do **not** start a second `redis:7` on the same port.

- **Recommended:** use only Tabby’s compose Redis for local dev.
- If you truly need a separate Redis, map it to another host port (e.g. `-p 6380:6379`) and point the service that needs it at `localhost:6380`.

### Temporal

```bash
temporal server start-dev --db-filename ~/temporal.db
```

### Tabby — full Kind cluster (recommended)

For end-to-end testing (real sessions, VNC, credential extraction), use the full Kind stack:

```bash
cd ~/work/tabby
pnpm install --frozen-lockfile
make kind-create        # one-time: creates "tabby-dev" Kind cluster
make kind-reload-all    # clean + build + docker-build + load + helm upgrade (~3-5 min first time)
make k8s-port-forward   # API:18080, Admin UI:13000, Postgres:25432, Redis:16379, MinIO:19000, NATS:4222
```

Verify: `curl -s http://localhost:18080/health/live`

All Tabby config (secrets, DB, Redis, NATS, MinIO) is baked into `charts/browser-hitl/values-local.yaml` — no manual env vars needed for Kind.

### Tabby — API-only (docker compose, no workers)

If you only need the API (no browser sessions / VNC / credential extraction):

```bash
cd ~/work/tabby && docker compose up -d
docker compose ps   # postgres, redis, nats, minio should be healthy
```

Default Postgres (from compose): `postgresql://browser_hitl:localdev@localhost:5432/browser_hitl`.

---

## Tabby API environment

Before starting the API, set encryption and messaging (see also `STARTUP.md`):

```bash
cd ~/work/tabby
cp .env.example .env.local   # if you use a file
# Required at minimum:
# - TENANT_ENCRYPTION_KEY (64 hex chars — worker/API must match)
# - JWT_SIGNING_KEY, AGENT_SECRET_HMAC_KEY (each ≥ 32 bytes hex is fine)
# - DATABASE_URL, REDIS_URL, NATS_URL, MINIO_* aligned with docker compose
```

One-shot example (adjust if you use `.env.local` instead):

```bash
DATABASE_URL="postgresql://browser_hitl:localdev@localhost:5432/browser_hitl" \
REDIS_URL="redis://localhost:6379" \
NATS_URL="nats://localhost:4222" \
JWT_SIGNING_KEY="$(openssl rand -hex 32)" \
TENANT_ENCRYPTION_KEY="$(python3 -c 'print("0"*64)')" \
AGENT_SECRET_HMAC_KEY="$(openssl rand -hex 32)" \
MINIO_ENDPOINT="localhost" MINIO_PORT="9000" \
MINIO_ACCESS_KEY="minioadmin" MINIO_SECRET_KEY="minioadmin" \
ADMIN_BOOTSTRAP_EMAIL="admin@browser-hitl.local" \
ADMIN_BOOTSTRAP_PASSWORD="LocalDev123!@#" \
NODE_ENV="development" \
pnpm --filter @browser-hitl/api start:dev
```

**Browser / VNC:** `docker compose` in Tabby is **API + data stores**. Playwright workers and the controller are not started by this compose file. To get real sessions, VNC, and login completion you still need the **worker + controller** path (e.g. Kind / Helm per `STARTUP.md`) or an environment where those services already run against this API. Without workers, `session-status` may stay in `STARTING` and credentials will not materialize.

---

## Start services (order)

### 1. Tabby — port 18080 (Kind) or 8000 (API-only)

**Kind (recommended):** Already running from infra setup above. Verify:

```bash
curl -s http://localhost:18080/health/live
make k8s-status   # all pods should be Running
```

Swagger: [http://localhost:18080/api/docs](http://localhost:18080/api/docs)

**API-only (docker compose):** If not using Kind:

```bash
cd ~/work/tabby && pnpm run build && pnpm --filter @browser-hitl/api start:dev
```

Swagger: [http://localhost:8000/api/docs](http://localhost:8000/api/docs)

### 2. adoptai-workflows API — port 8001 + Temporal worker

Terminal A:

```bash
cd ~/work/adoptai-workflows && source .venv/bin/activate
poetry run uvicorn api.app.main:app --host 0.0.0.0 --port 8001 --reload
```

Terminal B:

```bash
cd ~/work/adoptai-workflows && source .venv/bin/activate
poetry run python -m src.worker
```

Ensure `.env` has Temporal address, SingleStore, and any ProjectA3-related settings required by your org’s template.

### 3. adoptwebui backend — port 8002

```bash
cd ~/work/adoptwebui/backend && source .venv/bin/activate
ADOPT_WORKFLOW_URL=http://localhost:8001 uvicorn main:app --reload --port 8002
```

### 4. adoptwebui frontend — port 3000

```bash
cd ~/work/adoptwebui/frontend && yarn start
```

---

## Test flow

1. **Tabby admin login** — `POST /login` with bootstrap admin (see `STARTUP.md`), then use Swagger or curl with `Authorization: Bearer <token>`. Use `http://localhost:18080` for Kind or `http://localhost:8000` for API-only.

2. **Tenant** — `POST /admin/tenants` if you need a dedicated tenant; note `tenant_id`.

3. **App + profile** — `POST /apps` with a full payload (`tenant_id`, `login_config`, `export_policy`, `keepalive_config`, `target_urls`, etc.).  
   - **`notification_config`:** Omitted or `{ "channels": [] }` means no Slack/Teams noise — suitable for **agent/UI-driven** HITL.  
   - To use the **`agent:`** channel shape (validated as `{provider}:{reference}`), use e.g. `{ "channels": ["agent:poll"] }` — reference after `:` is arbitrary but required by validation.

4. **Agent client** — `POST /admin/agent-clients` with `tenant_id` and `allowed_profiles` listing the profile id(s) your WDL will use. Save `client_id` / `client_secret` (secret shown once). API must have `AGENT_SECRET_HMAC_KEY` set.

5. **Scale sessions** — `PATCH /apps/:id` with `desired_session_count` (and ensure controller/workers can satisfy it if you need live browsers).

6. **Profile** — Create/promote profile as usual (`POST /profiles`, state `ACTIVE`, id matching `allowed_profiles`).

7. **WDL** — Build a pipeline or action WDL that includes a `TABBY` step (`action`: `request_credentials`) with `tabby_url`, `client_id`, `client_secret`, `profile_id` (see example below).

8. **Execute** — Run via adoptai-workflows HTTP API (WDL execution routes) or trigger a pipeline from adoptwebui.

9. **HITL** — When Tabby reports HITL, adoptwebui should show a paused pipeline with **Tabby metadata** (`tabby_hitl_data`: VNC URL, session id, pending input). Open the VNC link, complete login / inputs in the browser, use **Mark as resolved** / Slack flow as configured.

10. **Resume** — After the session is healthy, re-run or resume per product rules; the `TABBY` step should return credentials. With `inject_security_params: true` (default), later **REST** steps can use merged `security_params` (e.g. `Cookie` header).

---

## Example WDL: `TABBY` + `request_credentials`

WDL is a **JSON array** of blocks. Shapes vary slightly by product, but the following matches what **ProjectA3** `actionbot/operations/tabby_operation.py` reads from each step:

- `operation`: `"TABBY"`
- `id`: string step id
- `tabby_url`: Tabby API base, e.g. `http://localhost:8000`
- `client_id` / `client_secret`: from `POST /admin/agent-clients`
- `profile_id`: Tabby profile id
- `action`: `"request_credentials"` (default if omitted)

Optional: `force_refresh`, `force_refresh_wait_seconds` (capped at 30 server-side), `poll_timeout_seconds`, `poll_interval_seconds`, `max_retries`, `retry_delay_seconds`, `inject_security_params`.

```json
[
  {
    "type": "metadata",
    "title": "Tabby credential smoke test",
    "description": "Request credentials from Tabby for a profile",
    "version": "1.0"
  },
  {
    "operation": "TABBY",
    "id": "tabby_creds",
    "tabby_url": "http://localhost:18080",
    "client_id": "{{TABBY_CLIENT_ID}}",
    "client_secret": "{{TABBY_CLIENT_SECRET}}",
    "profile_id": "my-profile-id",
    "action": "request_credentials",
    "force_refresh": false,
    "force_refresh_wait_seconds": 15,
    "poll_timeout_seconds": 300,
    "poll_interval_seconds": 10,
    "inject_security_params": true
  },
  {
    "type": "required_inputs",
    "required_inputs": []
  }
]
```

Replace placeholders with real values or pipeline variables. With `inject_security_params: true`, Tabby flattens cookies/headers/custom keys into the executor’s `security_params`; add a **REST** (or similar) step afterward using your environment’s normal header substitution — the merged map includes a `Cookie` string when cookies were exported.

If your compiler forbids extra keys on the generated `TABBY` model, trim to allowed fields; runtime `execute_tabby` still reads the full step dict from the WDL payload.

Other `action` values supported by the same operation: `authenticate` (returns token metadata), `check_session` (returns `GET /agent/session-status/:profileId` payload).

---

## Troubleshooting

### Tabby

| Symptom | Likely cause | What to do |
|--------|----------------|------------|
| Credentials empty or decryption wrong | Missing / mismatched `TENANT_ENCRYPTION_KEY` on API | Set 64 hex chars; same key as worker if using K8s workers |
| Cannot log into Postgres after changing password in compose | Postgres data volume keeps old password | `docker compose down -v` (wipes DB) or align password with volume |
| `POST /apps` rejects `notification_config` | Invalid channel string | Use `slack:…`, `teams:…`, or `agent:<ref>` (e.g. `agent:poll`) |
| Session never leaves `STARTING`, no VNC | No worker/controller | Use full Kind setup: `make kind-reload-all && make k8s-port-forward` |
| Agent token fails | `AGENT_SECRET_HMAC_KEY` unset or client mis-scoped | Set HMAC key; `allowed_profiles` must include profile id |

### Ports and Redis

- **6379 in use:** Tabby compose already binds Redis; remove duplicate `docker run redis` or change port.
- **Swagger 404:** Use `/api/docs` on Tabby API.

### adoptai-workflows / ProjectA3

- **Import errors for `actionbot`:** Re-run `install_dependencies.py` and `poetry install`; ProjectA3 must resolve as a dependency.
- **SingleStore / config errors:** Confirm `docker-compose.singlestore.yml` is up and `.env` matches adoptai-workflows expectations.

### adoptwebui

- **Workflow calls fail:** Confirm `ADOPT_WORKFLOW_URL=http://localhost:8001` and Temporal worker is running.

---

## Verify each component

| Component | Check |
|-----------|--------|
| Tabby API (Kind) | `curl -s http://localhost:18080/health/live` |
| Tabby API (compose) | `curl -s http://localhost:8000/health/live` |
| Tabby pods (Kind) | `make k8s-status` or `kubectl get pods -n browser-hitl` |
| Postgres (Kind) | `kubectl exec -n browser-hitl svc/browser-hitl-postgres -- pg_isready -U browser_hitl` |
| Postgres (compose) | `docker compose exec postgres pg_isready -U browser_hitl` (from `~/work/tabby`) |
| Redis (Kind) | `kubectl exec -n browser-hitl svc/browser-hitl-redis -- redis-cli ping` |
| Redis (compose) | `docker compose exec redis redis-cli ping` |
| NATS | `curl -s http://localhost:8222/healthz` |
| MinIO (Kind) | Console http://localhost:19000 |
| MinIO (compose) | Console [http://localhost:9001](http://localhost:9001) (default `minioadmin` / `minioadmin`) |
| adoptai-workflows | OpenAPI [http://localhost:8001/docs](http://localhost:8001/docs) (if enabled) |
| Temporal | `temporal workflow list --address localhost:7233` |
| Worker | Logs from `poetry run python -m src.worker` |

---

## NATS (local)

NATS monitoring port **8222** (from Tabby compose):

```bash
curl -s http://localhost:8222/varz | head
curl -s http://localhost:8222/jsz?streams=1
```

JetStream subjects used in production/staging include patterns such as `hitl.started.*`, `session.state.changed.*` — subscribe with `nats` CLI if installed:

```bash
nats sub "hitl.started.>" --server nats://localhost:4222
```

Useful when correlating controller/bot traffic with Tabby API sessions (full stack only).

---

## Related docs

- Tabby local API: `STARTUP.md` (repo root)
- Tabby agent + credentials: `tabby-abcd-integration-guide.md` (reference; may be uncommitted)
- ProjectA3 Tabby implementation: `actionbot/operations/tabby_operation.py`
