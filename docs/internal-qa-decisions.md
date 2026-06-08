# Internal Q&A — Tabby Deployment Decisions

Internal-only. Not customer-facing.

---

## Can the current Tabby branch be merged without platform changes?

**Yes.** Every change is backward compatible:

- New DB migration (023) runs automatically, adds columns with `IF NOT EXISTS`
- New env vars (`RECONCILE_BATCH_SIZE`, `WORKER_STARTUP_DELAY_MS`) have safe defaults (50 and 0)
- NATS reconnect is transparent — same behavior but more resilient
- Controller multi-replica support is additive — single replica still works identically
- Server-to-server WS bypass is passive — only activates when connections have no `Origin` header
- IdP single-fallback is a quality-of-life improvement, doesn't change existing multi-IdP behavior

**Operational dependency:** The `infra/tfy/deploy.yaml` now uses `${PLACEHOLDER}` for ~30 resource/replica values. These GitHub Secrets must be added before deploying via the CI pipeline. This is a config task, not a code change.

---

## What exactly changed in the current Tabby branch?

### Infrastructure resilience
- **NATS reconnect:** all services now use `connectNats()` with infinite reconnect, 2s wait, jitter, and a status monitor that exits the process on permanent connection loss (forces K8s restart)
- **Probe tolerance:** liveness and readiness probes now have `timeoutSeconds: 5` and `failureThreshold: 5` (was defaults: 1s/3 respectively). Prevents false pod kills during transient slowdowns

### Controller scaling
- **Multi-replica support:** reconcile loop uses `SELECT ... FOR UPDATE SKIP LOCKED` to grab batches of apps/sessions. Multiple controller pods process different apps in parallel without conflicts
- **Circuit breaker persistence:** moved from in-memory Map to `circuit_breaker_state` DB table. All replicas share the same pause state
- **Pod creation idempotency:** `createWorkerPod()` pre-checks for existing pods and catches K8s 409 AlreadyExists
- **State machine retry:** `transition()` retries 3x on version conflict, detects if another replica already transitioned
- **`RECONCILE_BATCH_SIZE`:** new env var, defaults to 50

### API
- **IdP single-fallback:** if no IdP matches `issuer_url` but exactly one enabled IdP exists, uses it with a warning
- **noVNC asset cache LRU:** capped at 50 entries to prevent unbounded memory growth
- **Server-to-server WS bypass:** VNC/CDP WS proxy accepts stream token alone when no `Origin` header is present (platform proxy path)

### Worker
- **`WORKER_STARTUP_DELAY_MS`:** optional startup delay for scale testing (default 0, no effect in prod)

### Helm/Docker
- **Grafana labels:** conditional `truefoundry.com/application` label (gated by `global.grafanaLabels`)
- **Heap sizing:** API Dockerfile changed from 1024 to 700 MB max-old-space-size. Controller Dockerfile gets 700 MB (was unlimited)
- **deploy.yaml:** all resource values now configurable via GitHub Secrets/envsubst

---

## Environment variables to set for deploy

### New (this branch)

| Variable | Default | Required? | Notes |
|---|---|---|---|
| `RECONCILE_BATCH_SIZE` | `50` | No | How many apps/sessions per reconcile tick per controller replica |
| `WORKER_STARTUP_DELAY_MS` | `0` | No | Only for testing. Leave at 0 for production |

### GitHub Secrets needed for deploy.yaml

These are `${PLACEHOLDER}` values in `infra/tfy/deploy.yaml` that must exist as GitHub Secrets:

| Secret | Recommended staging | Recommended prod |
|---|---|---|
| `API_REPLICAS` | `1` | `2` |
| `API_CPU_REQUEST` | `500m` | `500m` |
| `API_CPU_LIMIT` | `1000m` | `2000m` |
| `API_MEM_REQUEST` | `512Mi` | `512Mi` |
| `API_MEM_LIMIT` | `1Gi` | `2Gi` |
| `CONTROLLER_REPLICAS` | `1` | `2` |
| `CONTROLLER_CPU_REQUEST` | `250m` | `500m` |
| `CONTROLLER_CPU_LIMIT` | `1000m` | `1000m` |
| `CONTROLLER_MEM_REQUEST` | `256Mi` | `512Mi` |
| `CONTROLLER_MEM_LIMIT` | `1Gi` | `1Gi` |
| `WORKER_CPU_REQUEST` | `1000m` | `1000m` |
| `WORKER_CPU_LIMIT` | `2000m` | `2000m` |
| `WORKER_MEM_REQUEST` | `2Gi` | `2Gi` |
| `WORKER_MEM_LIMIT` | `3Gi` | `3Gi` |
| `POSTGRES_CPU_REQUEST` | `500m` | `500m` |
| `POSTGRES_CPU_LIMIT` | `1000m` | `2000m` |
| `POSTGRES_MEM_REQUEST` | `512Mi` | `1Gi` |
| `POSTGRES_MEM_LIMIT` | `1Gi` | `2Gi` |
| `REDIS_CPU_REQUEST` | `250m` | `250m` |
| `REDIS_CPU_LIMIT` | `500m` | `500m` |
| `REDIS_MEM_REQUEST` | `256Mi` | `256Mi` |
| `REDIS_MEM_LIMIT` | `512Mi` | `512Mi` |
| `NATS_CPU_REQUEST` | `250m` | `250m` |
| `NATS_CPU_LIMIT` | `500m` | `500m` |
| `NATS_MEM_REQUEST` | `256Mi` | `256Mi` |
| `NATS_MEM_LIMIT` | `512Mi` | `512Mi` |
| `NATS_JS_MAX_MEMORY` | `128Mi` | `256Mi` |
| `MINIO_CPU_REQUEST` | `250m` | `250m` |
| `MINIO_CPU_LIMIT` | `500m` | `500m` |
| `MINIO_MEM_REQUEST` | `256Mi` | `512Mi` |
| `MINIO_MEM_LIMIT` | `512Mi` | `1Gi` |
| `EGRESS_CPU_REQUEST` | `100m` | `100m` |
| `EGRESS_CPU_LIMIT` | `500m` | `500m` |
| `EGRESS_MEM_REQUEST` | `128Mi` | `128Mi` |
| `EGRESS_MEM_LIMIT` | `512Mi` | `512Mi` |
| `RECONCILE_BATCH_SIZE` | `50` | `50` |

---

## Are the current resource recommendations too low?

**No. They're well-calibrated.**

| Component | Current | Benchmark validation |
|---|---|---|
| Worker (Chromium) | 1 CPU / 2 Gi req, 2 CPU / 3 Gi limit | Single Chromium tab: 400-600 MB idle, 800 MB-1.2 GB active. 3 Gi limit gives 1.5x headroom for GC spikes |
| noVNC sidecar | 100m / 128 Mi | websockify idles at ~30-50 MB. Over-provisioned but negligible cost |
| API | 500m / 512 Mi | NestJS idle: 100-150 MB, under load: 200-400 MB. Appropriate |
| Controller | 500m / 512 Mi | Controller is lightweight (DB queries + K8s API). Could drop to 250m/256 Mi but not worth the risk |
| PostgreSQL | 500m / 512 Mi | ~30-50 MB per connection × 10 connections = 300-500 MB. Appropriate |
| Redis / NATS | 250m / 256 Mi | Both lightweight for Tabby's workload. Appropriate |
| MinIO | 250m / 256 Mi | Baseline 256 MB, can spike during parallel uploads. Monitor this one |

**Scaling is about increasing pod count, not individual pod resources.** Each worker pod is one session. More concurrent sessions = more pods, not bigger pods.

---

## Why is DB connection pool listed as an API bottleneck?

TypeORM's default connection pool is 10 connections. Each concurrent request that queries the DB holds a connection. If 11+ requests arrive simultaneously, the 11th waits.

For Tabby's API, this matters during:
- Burst credential requests (platform polls `/credentials/request` for multiple users)
- Concurrent session status checks
- Admin bulk operations

The pool size is configurable via `DATABASE_URL` query params (`?poolSize=20`) or TypeORM options. Default 10 is fine for <50 concurrent users. For 500+, increase to 20-30.

**Is it a real bottleneck?** Only under burst load. Tabby's typical pattern is sequential (one user → one credential request at a time). Becomes real at 50+ concurrent users making simultaneous API calls.

---

## How to answer customer concerns about slow first-run/session startup

### Technically correct explanation

The first execution for a new user includes:
1. Token exchange with the IdP (~100-200ms)
2. Auto-provisioning of App + Profile + Session in the DB (~200ms)
3. Kubernetes pod scheduling (depends on cluster: 2-30s)
4. Container image pull (first time on a node: 10-60s, cached: 0s)
5. Chromium browser launch (~2-5s)
6. Login DSL execution until HITL prompt (~5-15s depending on target site)

Total first-run: **15-90 seconds** depending on cluster conditions.

### Customer-safe explanation

> "The first execution includes Kubernetes pod scheduling and browser startup time. This is a one-time cost per user session — once the session is running, all subsequent requests resolve instantly from the warm session.
>
> Startup time depends on cluster scheduling speed, node availability, and whether the container image is cached on the node. For the first deployment, the image pull adds 10-60 seconds. After that, scheduling typically takes 5-15 seconds.
>
> We recommend monitoring pod scheduling latency (`kube_pod_start_duration_seconds`) and adjusting node pool sizing if startup times exceed 30 seconds consistently.
>
> Future optimizations under consideration include pre-warmed session pools that keep idle sessions ready, eliminating the cold-start entirely."

### What we can tune now

- `IDLE_SHUTDOWN_SECONDS`: increase to keep sessions alive longer (reduces re-starts)
- Node pool sizing: ensure enough capacity for peak concurrent sessions
- Image pre-pull: DaemonSet that pulls worker images on all nodes
- `MAX_SESSION_AGE_HOURS`: controls max session lifetime

### What's future work

- Warm pool / pre-warmed sessions (keep N idle sessions ready)
- Predictive scaling (scale up before expected usage)
- Image caching on dedicated nodes

---

## What to say in the call

1. "The Tabby branch is ready to merge. It adds NATS resilience, controller multi-replica support, and resource configurability. No platform changes needed."
2. "Before deploying, we need to add ~30 GitHub Secrets for resource limits and replica counts. I have the recommended values ready."
3. "The current resource defaults are validated against Chromium memory benchmarks. Worker pods at 1 CPU / 2 Gi request are appropriate."
4. "First session startup takes 15-90 seconds depending on cluster conditions. Subsequent requests are instant while the session is warm."
5. "The Helm chart for on-prem needs the IDP credential fix (PR #174) merged first."
6. "We identified some Helm chart gaps (external Redis/NATS support, worker scheduling) that should be addressed but are not blockers for the initial deployment."
