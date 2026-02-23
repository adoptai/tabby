# Fresh Deployment Notes

Gotchas encountered when deploying from a clean clone of the repository.

---

## 1. Missing Environment Variables (not in .env.example)

The API requires several secrets that are **not listed in `.env.example`** but will cause runtime failures:

| Variable | Symptom | Fix |
|----------|---------|-----|
| `AGENT_SECRET_HMAC_KEY` | HTTP 500 on `POST /admin/agent-clients` | `openssl rand -hex 32` |
| `TENANT_ENCRYPTION_KEY` | Credential encryption fails | `openssl rand -hex 32` |
| `JWT_SIGNING_KEY` | API refuses to start | Any string >= 32 chars |
| `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | MinIO provisioner fails | `localhost` / `minioadmin` / `minioadmin` |
| `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` | No admin user created on first boot | `admin@browser-hitl.local` / your password |
| `DATABASE_URL` | API refuses to start | `postgresql://browser_hitl:localdev@localhost:5432/browser_hitl` |
| `REDIS_URL` | Redis-dependent services fail | `redis://localhost:6379` |

A complete local startup command looks like:

```bash
DATABASE_URL="postgresql://browser_hitl:localdev@localhost:5432/browser_hitl" \
REDIS_URL="redis://localhost:6379" \
NATS_URL="nats://localhost:4222" \
JWT_SIGNING_KEY="local-dev-jwt-key-must-be-at-least-32-chars" \
TENANT_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
AGENT_SECRET_HMAC_KEY="$(openssl rand -hex 32)" \
MINIO_ENDPOINT="localhost" \
MINIO_PORT="9000" \
MINIO_ACCESS_KEY="minioadmin" \
MINIO_SECRET_KEY="minioadmin" \
ADMIN_BOOTSTRAP_EMAIL="admin@browser-hitl.local" \
ADMIN_BOOTSTRAP_PASSWORD="e2e-admin-password" \
NODE_ENV="development" \
pnpm --filter @browser-hitl/api start:dev
```

## 2. Redis Port Conflict

If the host already runs a system Redis (`systemctl status redis-server`), docker compose will fail to bind port 6379. Options:

- **Use the system Redis** — skip the docker compose Redis container entirely.
- **Stop system Redis** — `sudo systemctl stop redis-server` before `docker compose up -d`.
- **Remap the port** — change the docker compose port mapping to avoid 6379.

## 3. Session Lifecycle Requires Kubernetes

`docker compose up -d` only starts infrastructure (PostgreSQL, Redis, NATS, MinIO). The **controller** and **worker** services run exclusively in Kubernetes. Without them, sessions will stay in `PENDING` and never progress to `HEALTHY`.

For a full end-to-end test, you need either:

- The existing Kind cluster (`kind-browser-hitl-phase3`) with Helm-deployed services, or
- A fresh Kind cluster with `make k8s-deploy`.

The API-only smoke test (Phase 1 checks: auth, CRUD, profiles, agent registration) works against docker compose. Phase 2+ requires K8s.

## 4. E2E Orchestrator Canary Bypass Uses kubectl

`e2e_smoke_test/orchestrator.py` bypasses the canary gate via `kubectl exec` into the postgres pod. When running against local docker compose postgres, this fails silently.

**Workaround:** Create a kubectl wrapper that translates to `docker exec`:

```bash
# /tmp/browser-hitl-local/kubectl
#!/usr/bin/env bash
found_separator=false
psql_args=()
for arg in "$@"; do
  if $found_separator; then psql_args+=("$arg")
  elif [ "$arg" = "--" ]; then found_separator=true; fi
done
if [ ${#psql_args[@]} -gt 0 ]; then
  exec docker exec tabby-postgres-1 "${psql_args[@]}"
else
  exec /usr/bin/kubectl "$@"
fi
```

Then prepend it to PATH: `PATH="/tmp/browser-hitl-local:$PATH" python3 e2e_smoke_test/orchestrator.py ...`

## 5. Mock HITL Must Target the Same NATS as the Workers

When running the E2E smoke test against the **K8s cluster**, the mock HITL auto-responder must connect to **K8s NATS** (via port-forward), not the local docker compose NATS. They are separate instances.

```bash
# Stop docker compose NATS first if running, then:
kubectl port-forward -n browser-hitl svc/browser-hitl-nats 4222:4222 &

# Run the smoke test with K8s-connected NATS
NATS_URL="nats://localhost:4222" \
REDIS_URL="redis://localhost:16379" \
API_URL="http://localhost:18080" \
python3 e2e_smoke_test/orchestrator.py --hitl-mode mock
```

## 6. pnpm Install May Prompt Interactively

On a fresh clone, `pnpm install` may ask to confirm recreating `node_modules`. Use `pnpm install --force` to skip the prompt in non-interactive environments.

## 7. NestJS Watch Mode and Zombie Processes

`pnpm --filter @browser-hitl/api start:dev` uses `nest start --watch`, which can leave orphan Node processes if killed ungracefully. Before restarting the API, always check:

```bash
ss -tlnp | grep 8080
# If occupied, kill the PID shown
```

## 8. K8s Port-Forward Reference

The existing Kind cluster exposes services on non-standard ports:

| Service | K8s Port-Forward | Default Port |
|---------|-----------------|--------------|
| API | `localhost:18080` | 8080 |
| Redis | `localhost:16379` | 6379 |
| PostgreSQL | `localhost:25432` | 5432 |
| MinIO | `localhost:19000` | 9000 |
| Test Harness | `localhost:18000` | 8000 |
| NATS | `localhost:4222` | 4222 (manual) |

The `.env.local` file uses `API_URL=http://localhost:18080` (K8s), not `http://localhost:8080` (local dev).
