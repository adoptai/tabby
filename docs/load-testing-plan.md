# Tabby Load Testing & Resource Sizing Plan

## 1. Repository Investigation Summary

### Files Inspected

**Tabby repo (`/home/moraski/work/tabby`)**

| File | What it reveals |
|------|-----------------|
| `apps/controller/src/reconcile.service.ts` | Reconcile loop: batch size, tick rate, idle shutdown, circuit breaker |
| `apps/controller/src/pod-manager.service.ts` | Worker pod creation, **hardcoded** resources, noVNC sidecar |
| `apps/controller/src/state-machine.service.ts` | State transitions, optimistic locking (3 retries on version conflict) |
| `apps/api/src/data-source.ts` | DB pool size (`DB_POOL_SIZE`, default 20) |
| `apps/api/src/app.module.ts` | Global rate limiter: 60 req/min per user |
| `apps/api/src/modules/credentials/credentials.service.ts` | `last_credential_request_at` update, idle re-scale |
| `apps/api/src/modules/execute/execute.service.ts` | Execute rate limits (fetch: 60/min, browser: 120/min) |
| `charts/browser-hitl/values.yaml` | All Helm resource defaults |
| `charts/browser-hitl/templates/configmap.yaml` | All env vars passed to API/Controller |
| `charts/browser-hitl/templates/hpa.yaml` | HPA for API (max 4) and Controller (max 3), disabled by default |
| `charts/browser-hitl/templates/postgres-statefulset.yaml` | Postgres PVC: 20Gi |
| `charts/browser-hitl/templates/minio-statefulset.yaml` | MinIO PVC: 50Gi |
| `infra/tfy/deploy.yaml` | Production deployment template, all resource vars |
| `scripts/scale-test.sh` | Existing scale test — DB-level only, no HTTP load |
| `docs/tabby-platform-handoff.md` | Platform integration, cold-start 150s polling, warm pools as future work |

**Helm-charts repo (`/home/moraski/work/helm-charts`)**

Only contains `charts/adopt-api-service/` — a generic NestJS chart. **No browser-hitl chart.** The Tabby Helm chart lives entirely in the tabby repo at `charts/browser-hitl/`.

---

### Resource Knobs Found

#### Per-service resource defaults (values.yaml)

| Service | CPU Request | CPU Limit | Memory Request | Memory Limit |
|---------|-------------|-----------|----------------|--------------|
| API | 500m | 1000m | 512Mi | 1Gi |
| Controller | 500m | 1000m | 512Mi | 1Gi |
| Worker | 1000m | 2000m | 2Gi | 3Gi |
| noVNC sidecar | 100m | 250m | 128Mi | 256Mi |
| PostgreSQL | 500m | 1000m | 512Mi | 1Gi |
| Redis | 250m | 500m | 256Mi | 512Mi |
| NATS | 250m | 500m | 256Mi | 512Mi |
| MinIO | 250m | 500m | 256Mi | 512Mi |
| Egress Proxy | 100m | 500m | 128Mi | 512Mi |
| Slack Bot | 250m | 500m | 256Mi | 512Mi |
| Teams Bot | 250m | 500m | 256Mi | 512Mi |
| Admin UI | 250m | 500m | 256Mi | 512Mi |

**Per session (worker + noVNC):** 1.1 CPU request, 2.128Gi memory request. At 200 sessions = **220 CPU cores + 425Gi RAM** just for worker pods.

#### Critical: Worker resources are HARDCODED

`pod-manager.service.ts` lines 409-443 hardcode worker and noVNC resources. The `values.yaml` `worker.resources` section is cosmetic — the controller code does not read Helm values at runtime. To change worker pod resources, you must change the controller source code and rebuild the image.

```
# What deploy.yaml sets (NOT consumed by controller code):
worker.resources.requests.cpu: ${WORKER_CPU_REQUEST}

# What the controller actually uses (hardcoded):
resources: { requests: { cpu: '1', memory: '2Gi' }, limits: { cpu: '2', memory: '3Gi' } }
```

**Also hardcoded and not injected from Helm:** `worker.nodeSelector`, `worker.tolerations`, `worker.affinity` — defined in values.yaml but `buildPodSpec()` never reads them. Worker pods always land on any available node.

#### Environment variables (scaling-relevant)

| Env Var | Default | Source | Effect |
|---------|---------|--------|--------|
| `RECONCILE_BATCH_SIZE` | 50 | ConfigMap | Apps/sessions processed per reconcile tick |
| `RECONCILE_INTERVAL_SECONDS` | 15 | ConfigMap | Seconds between reconcile ticks |
| `DB_POOL_SIZE` | 20 | ConfigMap | TypeORM connection pool max |
| `IDLE_SHUTDOWN_SECONDS` | 0 (disabled) | ConfigMap | Idle timeout for per-user sessions |
| `MAX_SESSION_AGE_HOURS` | 24 | ConfigMap | Hard recycling ceiling for all sessions |
| `DEFAULT_KEEPALIVE_SECONDS` | 300 | ConfigMap | Worker-side keepalive interval |
| `CIRCUIT_BREAKER_APP_FAILURE_THRESHOLD` | 5 | ConfigMap | Failures before app circuit opens |
| `CIRCUIT_BREAKER_TENANT_FAILURE_THRESHOLD` | 50 (values.yaml) / 15 (code fallback) | ConfigMap | Failures before tenant circuit opens |
| `CIRCUIT_BREAKER_WINDOW_SECONDS` | 900 | ConfigMap | Circuit breaker sliding window |
| `CIRCUIT_BREAKER_COOLDOWN_SECONDS` | 300 | ConfigMap | Cooldown after circuit opens |

#### HPA configuration

| Service | Enabled | Min | Max | CPU Target | Memory Target |
|---------|---------|-----|-----|------------|---------------|
| API | false (default) | 1 | 4 | 70% | 80% |
| Controller | false (default) | 1 | 3 | 70% | 80% |
| Worker | N/A | N/A | N/A | N/A | N/A |

Workers are NOT managed by HPA. They are created/destroyed by the controller based on `desired_session_count` in the DB.

#### PVC configuration

| Service | Default Size | Access Mode | Notes |
|---------|-------------|-------------|-------|
| PostgreSQL | 20Gi | ReadWriteOnce | StatefulSet |
| Redis | 5Gi | ReadWriteOnce | Deployment with PVC |
| NATS | 10Gi | ReadWriteOnce | StatefulSet, JetStream |
| MinIO | 50Gi | ReadWriteOnce | StatefulSet |

All use `global.storageClass` (cluster default). No resize annotations.

---

### Controller Reconciliation — How It Actually Works

Every `RECONCILE_INTERVAL_SECONDS` (default 15s), the controller runs:

1. **`reconcileAppsWithSkipLocked()`** — `SELECT ... FOR UPDATE SKIP LOCKED` claims up to `RECONCILE_BATCH_SIZE` (50) apps. For each, creates/destroys pods to match `desired_session_count`. Multiple controller replicas process different apps in parallel.

2. **`reconcileRuntimeDrift()`** — Scans all sessions for missing pods, sweeps orphan pods.

3. **`evaluateSessionsWithSkipLocked()`** — Claims up to 50 sessions, evaluates state via state machine (DESIRED → STARTING → HEALTHY, etc.). Uses optimistic locking (CAS on `state_version`), retries 3x on conflict.

4. **`checkRecycling()`** — Terminates sessions exceeding `MAX_SESSION_AGE_HOURS` or `IDLE_SHUTDOWN_SECONDS`.

**Throughput ceiling:** With default settings (50 batch, 15s interval), the controller can process ~200 apps/min and ~200 sessions/min. With multiple replicas (max 3 via HPA), this triples.

**Key implication for load testing:** If you create 200 sessions at once, the controller will process them in batches of 50 every 15 seconds. That's 4 ticks (60 seconds) just to claim and start creating pods — before any pod actually starts running.

### Idle Timeout — How It Actually Works

- `POST /credentials/request` updates `session.last_credential_request_at` on every call (line 144 of credentials.service.ts).
- `checkRecycling()` compares `now - last_credential_request_at` against `IDLE_SHUTDOWN_SECONDS`.
- **Only applies to sessions with `owner_user_id`** — shared pool sessions are never idle-shutdown, only age-recycled.
- When idle timeout fires: sets `desired_session_count = 0`, then terminates the session.
- Next `POST /credentials/request` re-scales to 1 automatically (cold restart, up to 150s wait).

**For load testing:** To keep 200 sessions alive, you MUST call `POST /credentials/request` for each session at least once every `IDLE_SHUTDOWN_SECONDS`. Since each call also resets the timer, a simple polling loop works. This is safe — it's exactly how the platform uses Tabby in production.

### Existing Scale Test Script

`scripts/scale-test.sh` — inserts N apps directly into Postgres via SQL INSERT (default 150), then monitors session states. It tests controller SKIP LOCKED concurrency, not API load or real session lifecycle.

**What it covers:** Controller batch processing, duplicate session detection, multi-replica coordination.

**What it does NOT cover:** HTTP API load, actual Playwright execution, VNC streaming, HITL flows, credential extraction, worker pod resource pressure, keepalive/idle behavior, image pull delays. It is NOT a load test — it's a controller concurrency test.

---

## 2. Load Testing Primer — What This Means for Tabby

### What we are actually testing

Tabby load testing is fundamentally different from API load testing. When you `POST /credentials/request` for a new user, the HTTP response comes back in milliseconds. The actual work happens asynchronously:

```
POST /credentials/request  →  200 OK (milliseconds)
                                 ↓
              Controller picks up new session (next reconcile tick, up to 15s)
                                 ↓
              Controller calls K8s API to create pod (seconds)
                                 ↓
              K8s scheduler finds a node with capacity (seconds to minutes)
                                 ↓
              Node pulls Chromium image (~1.5GB if cold, seconds to minutes)
                                 ↓
              Container starts, Playwright initializes (10-30s)
                                 ↓
              Worker runs login DSL, possibly hits HITL (seconds to minutes)
                                 ↓
              Health check passes → session HEALTHY (worker reports)
                                 ↓
              Total time: 30s (warm) to 180s+ (cold, with HITL)
```

"200 HTTP requests succeeded" tells you nothing about whether you actually have 200 usable browser sessions.

### What success/failure looks like

| Metric | Success | Degraded | Failure |
|--------|---------|----------|---------|
| Time-to-healthy p95 | < 90s (warm image) | 90-180s | > 180s or stuck in STARTING |
| Session healthy rate | > 99% | 95-99% | < 95% |
| Pods in Pending | < 5 | 5-20 | > 20 and growing |
| Controller reconcile lag | Keeps up (empties queue each tick) | Falling behind | Queue grows indefinitely |
| API error rate | < 0.1% | 0.1-1% | > 1% |

### Test types and when to use them

| Type | Goal | Duration | When |
|------|------|----------|------|
| **Smoke** | Verify the test setup works | 5-10 min | First, always |
| **Baseline** | Establish reference numbers at low load | 20 min | After smoke |
| **Ramp-up** | Find the inflection point where performance degrades | 40-50 min | Core test |
| **Sustained** | Verify the system holds steady at target concurrency | 45-60 min | Validates target |
| **Spike** | Test sudden burst absorption and recovery | 20-30 min | Simulates morning rush |
| **Stress** | Find the breaking point | Until it breaks | Know your ceiling |
| **Soak** | Find memory leaks, connection pool exhaustion, orphaned pods | 4-8 hours | Long-term stability |
| **Recovery** | Verify cleanup after load removal | 15-30 min | After each major test |

---

## 3. Staged Load Test Plan

### Prerequisites

- Dedicated test tenant (NOT starting with `705` — that's AutomationWare production data)
- App template with a simple DSL (goto + screenshot, no real login needed for pure scaling tests)
- Agent client registered with `allowed_profiles` matching the test template
- k6 installed locally or via k6 Operator in cluster
- `kubectl` access to watch pods (read-only is sufficient)
- Grafana dashboard or terminal-based monitoring ready

### Stage 1: Smoke Test

| | |
|---|---|
| **Goal** | Verify the k6 script, auth flow, and single session lifecycle work end-to-end |
| **Sessions** | 1 at a time, 3 sequential |
| **Ramp** | None — sequential |
| **Duration** | 5-10 min |
| **Expected** | Each session reaches HEALTHY within 120s |
| **Watch** | API response codes, controller logs, pod events |
| **Stop if** | Any session fails to create or reach HEALTHY |
| **Result means** | Test infrastructure is working; proceed to baseline |

### Stage 2: Baseline (10 sessions)

| | |
|---|---|
| **Goal** | Establish reference p50/p95 time-to-healthy at comfortable load |
| **Sessions** | 10 concurrent |
| **Ramp** | Create 1 session every 30s over 5 min, then hold |
| **Duration** | 20 min (5 min ramp + 15 min hold) |
| **Expected** | All 10 HEALTHY, p95 time-to-healthy < 90s |
| **Watch** | Time-to-healthy distribution, controller CPU, DB connections |
| **Stop if** | Any session fails to reach HEALTHY |
| **Result means** | Your baseline numbers. All subsequent tests compare against this. |

### Stage 3: Ramp-Up (10 → 50 → 100 → 150 → 200)

| | |
|---|---|
| **Goal** | Find the concurrency level where performance starts degrading |
| **Sessions** | Step up by 50 every 10 min |
| **Ramp** | 10 → 50 → 100 → 150 → 200, each step held for 10 min |
| **Duration** | 50 min |
| **Expected** | p95 time-to-healthy stays < 120s through 150; may degrade at 200 |
| **Watch** | p95 time-to-healthy trend, pending pod count, node CPU/memory |
| **Stop if** | p95 time-to-healthy > 3× baseline OR error rate > 5% |
| **Result means** | The inflection point tells you your real capacity. If 200 is fine, your target is met. |

### Stage 4: Sustained Load (150 sessions, 60 min)

| | |
|---|---|
| **Goal** | Verify the system holds steady at 75% of target for a full idle-timeout cycle |
| **Sessions** | 150 concurrent |
| **Ramp** | 5 min ramp to 150, then hold |
| **Duration** | 60 min (covers 2× idle timeout cycle at 30 min) |
| **Expected** | Stable p95, no drift, sessions that idle-timeout are replaced cleanly |
| **Watch** | Time-to-healthy stability, controller memory trend, session state counts |
| **Stop if** | p95 degrades > 20% compared to baseline, or pod count diverges from expected |
| **Result means** | System can sustain target load through full session lifecycle including cleanup |

### Stage 5: Spike Test

| | |
|---|---|
| **Goal** | Test sudden burst absorption and recovery |
| **Sessions** | 10 steady → instant jump to 150 → hold 10 min → back to 10 |
| **Ramp** | Instant spike (all 140 sessions created in < 1 min) |
| **Duration** | 25 min |
| **Expected** | Controller queues sessions, processes in batches, all eventually HEALTHY |
| **Watch** | Pending pod count during spike, time for last pod to reach HEALTHY, recovery time |
| **Stop if** | Error rate > 10% during spike OR system doesn't recover within 10 min |
| **Result means** | Validates morning-rush scenario. The key number is time-to-clear-queue. |

### Stage 6: Stress Test (Find Breaking Point)

| | |
|---|---|
| **Goal** | Determine absolute maximum capacity |
| **Sessions** | Start at 100, add 25 every 5 min until failure |
| **Ramp** | Step function |
| **Duration** | Until something breaks |
| **Expected** | Failure at node capacity (not API/controller/DB) |
| **Watch** | What fails first: node capacity? DB pool? Controller OOM? Pod scheduling timeout? |
| **Stop if** | > 20% session creation failures OR system stops responding |
| **Result means** | Your ceiling. The failure mode tells you what to fix for more capacity. |

### Stage 7: Soak Test (100 sessions, 4 hours)

| | |
|---|---|
| **Goal** | Find memory leaks, connection pool exhaustion, orphaned pods |
| **Sessions** | 100 concurrent (50% of target) |
| **Ramp** | 10 min ramp |
| **Duration** | 4-8 hours |
| **Expected** | Flat memory usage, stable DB connections, no orphaned pods |
| **Watch** | Controller memory over time, `pg_stat_activity`, orphaned pod count |
| **Stop if** | Controller memory grows > 50% above starting point |
| **Result means** | Long-term stability confirmed. This catches bugs that only appear after many session lifecycle cycles. |

### Stage 8: Recovery

| | |
|---|---|
| **Goal** | Verify full cleanup after load removal |
| **Sessions** | Run at 150 for 20 min, then drop to 0 |
| **Ramp** | Abrupt stop |
| **Duration** | Wait 35 min (idle timeout + 5 min buffer) |
| **Expected** | All pods deleted, pod count returns to 0, DB connections return to idle |
| **Watch** | Pod count over time, DB connection count, NATS consumer lag |
| **Stop if** | System does not fully recover within 35 min |
| **Result means** | Cleanup path works. No leaked K8s resources after load. |

---

## 4. k6 / Grafana k6 Evaluation

### Verdict: Good fit, with caveats

k6 is the right tool for the HTTP/API layer of this load test. It can model the session creation, polling, and keepalive pattern well. However, it cannot measure the Kubernetes-side metrics that matter most for Tabby.

### How k6 models this

The key pattern is `ramping-arrival-rate` executor with a polling VU:

1. Each VU creates a session via token exchange + `POST /credentials/request`
2. Polls `GET /sessions/:id` every 5s until HEALTHY or timeout
3. Periodically calls `POST /credentials/request` to prevent idle shutdown
4. Records custom metrics: `session_time_to_healthy_ms`, `session_healthy_rate`

`ramping-arrival-rate` is better than `ramping-vus` because you want to control the rate of new session creation, not the number of polling loops.

### What k6 measures directly

- API response latency (p50/p95/p99 for each endpoint)
- API error rate
- Session time-to-healthy (custom Trend metric via polling)
- Session success rate (custom Rate metric)
- Throughput (requests/sec)

### What k6 CANNOT measure

- Pod scheduling latency
- Image pull duration
- Node CPU/memory utilization
- Controller reconcile loop timing
- DB connection pool saturation
- NATS consumer lag
- Pending pod count

These require Kubernetes observability: `kubectl`, Prometheus + kube-state-metrics, Grafana.

### Existing scale-test.sh — reuse or replace?

**Replace for load testing.** The script tests controller concurrency via direct SQL INSERT — it bypasses the API entirely. For a real load test, you need to go through the API (auth, credentials request, session creation). The script is still useful for controller-specific stress testing but is not a load test.

The k6 script should replicate the real platform flow:
1. `POST /auth/agent-token` → get agent token
2. `POST /auth/token-exchange` with `agent_assertion` → get per-user federated token
3. `POST /credentials/request` → trigger auto-provisioning
4. Poll session status until HEALTHY
5. Periodic `POST /credentials/request` to keep alive

---

## 5. Metrics & Interpretation Guide

### API-level (k6 measures these)

| Metric | Why it matters | Good | Bad | Action if bad |
|--------|---------------|------|-----|---------------|
| `POST /credentials/request` p99 | Primary API endpoint for platform | < 300ms | > 1s | Check DB pool, slow queries |
| `POST /auth/token-exchange` p99 | Auth endpoint, called per user | < 200ms | > 500ms | Check HMAC computation, DB lookup |
| `http_req_failed` rate | Overall API health | < 0.1% | > 1% | Check controller logs, DB health |
| `session_time_to_healthy_ms` p95 | End-to-end session readiness | < 90s (warm) | > 180s | Pod scheduling bottleneck |
| `session_healthy_rate` | Fraction that actually work | > 99% | < 95% | Check pod events, circuit breaker |

### Kubernetes-level (kubectl / Prometheus)

| Metric | Why it matters | Good | Bad | Action if bad |
|--------|---------------|------|-----|---------------|
| Pending pod count | Pods waiting for node capacity | < 5 | > 20 and growing | Need more nodes or smaller pods |
| Pod scheduling latency | Time from creation to node assignment | < 5s | > 30s | Node autoscaler too slow or quota hit |
| Image pull time | First-time pull of 1.5GB Chromium image | < 60s (cached) | > 3 min | Pre-pull images, use image cache |
| Node allocatable CPU remaining | Headroom for new pods | > 20% | < 5% | Scale node pool or reduce per-pod requests |
| Node allocatable memory remaining | Headroom for new pods | > 20% | < 5% | Same as CPU |

### Application-level (logs / DB queries)

| Metric | Why it matters | Good | Bad | Action if bad |
|--------|---------------|------|-----|---------------|
| Controller reconcile duration | Loop keeping up with demand | < 5s per tick | > 15s (tick interval) | Reduce batch size or add controller replica |
| Sessions in STARTING state | Queue depth | < 20 | > 50 and growing | Controller can't create pods fast enough |
| Sessions in FAILED state | Broken sessions | < 2% | > 5% | Check pod events, DSL errors |
| Controller memory | Memory leak detection | Flat over hours | Growing linearly | Memory leak in reconcile loop |
| DB active connections | Pool pressure | < 80% of pool_size | = pool_size (exhausted) | Increase `DB_POOL_SIZE` |

### Infrastructure (Postgres, NATS, Redis, MinIO)

| Metric | Why it matters | Good | Bad | Action if bad |
|--------|---------------|------|-----|---------------|
| `pg_stat_activity` count | DB connection pressure | < 18/20 | 20/20 → 5xx cascade | Increase `DB_POOL_SIZE` |
| Postgres query latency p95 | DB performance | < 50ms | > 500ms | Missing index or table scan |
| NATS consumer lag | Event processing backlog | Near 0 | Growing | Slack-bot/consumer falling behind |
| MinIO disk usage | Artifact storage | < 80% PVC | > 90% PVC | Increase PVC or reduce retention |
| Redis memory | Credential cache, stream tokens | < 80% limit | > 90% limit | Increase Redis memory limit |

---

## 6. Production Access Checklist

Since you cannot exec into pods or manually change deployments, you need the following from someone with cluster/deploy access **before** running a load test:

### Pre-test information needed

- [ ] **Node types and count** — What instance types (e.g., m5.2xlarge)? How many? Total allocatable CPU/memory?
- [ ] **Autoscaler behavior** — Is Karpenter/cluster-autoscaler configured? What are min/max node counts? How fast does it scale?
- [ ] **Max node quota** — Any cloud quota limits (EC2 instance limits, vCPU quota)?
- [ ] **Image pull behavior** — Is the worker image pre-cached on nodes? Or cold-pulled every time?
- [ ] **Current resource requests/limits** — What does `deploy.yaml` actually set for `${API_CPU_REQUEST}`, `${WORKER_CPU_REQUEST}`, etc.?
- [ ] **Worker resources** — Since these are hardcoded in controller code, confirm what the deployed controller image actually uses
- [ ] **HPA settings** — Is API/Controller HPA enabled in staging/prod? What are the current settings?
- [ ] **`IDLE_SHUTDOWN_SECONDS`** — What is the current production value? (You believe 30 min = 1800s)
- [ ] **`RECONCILE_BATCH_SIZE`** — Current production value?
- [ ] **`DB_POOL_SIZE`** — Current production value?
- [ ] **PVC sizes** — Current sizes and whether StorageClass supports expansion
- [ ] **Existing monitoring** — What Grafana dashboards exist? Prometheus setup? kube-state-metrics installed?
- [ ] **Alert configuration** — What alerts will fire during a load test? Can they be silenced for a test window?

### Approvals needed

- [ ] **Load test window** — When can the test run? Off-peak hours?
- [ ] **Dedicated namespace or tenant** — Can we create a `tabby-loadtest` namespace with a ResourceQuota?
- [ ] **Who watches the cluster** — SRE/infra person available during test?
- [ ] **Blast radius agreement** — If we set ResourceQuota at 50 pods, is that acceptable?
- [ ] **Cleanup plan** — Who deletes test resources after? (Or: confirm idle timeout handles it)
- [ ] **Rollback plan** — If controller crashes: `kubectl rollout restart` by whom?

### What you CAN observe from outside

- `kubectl get pods -n <namespace> -w` — watch pod state transitions in real time
- `kubectl top nodes` — node-level CPU/memory (if metrics-server installed)
- `kubectl get events -n <namespace> --sort-by='.lastTimestamp'` — scheduling failures, image pull errors
- `kubectl logs deploy/browser-hitl-controller -f` — controller logs
- `kubectl logs deploy/browser-hitl-api -f` — API logs
- Grafana dashboards (if available)
- k6 output (stdout, JSON, or Prometheus remote write)

### What you CANNOT observe without exec access

- Environment variables inside pods (must get from CI/CD config or deploy.yaml)
- `pg_stat_activity` inside Postgres (need a port-forward or external monitoring)
- Redis memory usage (need `redis-cli info memory` or external monitoring)
- NATS consumer lag (need NATS monitoring or external tools)

**Workaround:** If you have port-forward access, you can forward Postgres (5432), Redis (6379), and NATS (8222 monitoring) to localhost and query from your machine.

---

## 7. Configuration Recommendations (Starting Points)

These are starting values. Tune after observing metrics from the baseline test.

### For load testing (staging, 200-session target)

| Config | Starting Value | Why | Tune if... |
|--------|---------------|-----|------------|
| API replicas | 2 | Handle burst of token exchanges + credential requests | API p99 > 500ms → add replica |
| Controller replicas | 2 | Process session queue faster | Sessions stuck in STARTING → add replica |
| `RECONCILE_BATCH_SIZE` | 50 (default) | 50 apps × 2 replicas = 100/tick | Queue not draining → increase to 100 |
| `RECONCILE_INTERVAL_SECONDS` | 15 (default) | Balance between latency and DB load | 15s too slow → reduce to 10s |
| `DB_POOL_SIZE` | 30 | 20 may exhaust with 2 API + 2 controller replicas | `pg_stat_activity` near max → increase |
| `IDLE_SHUTDOWN_SECONDS` | 1800 (30 min) | Match production behavior | Test-specific: set to 3600 for soak test |
| `MAX_SESSION_AGE_HOURS` | 24 (default) | No change needed for testing | N/A |
| API HPA | enabled, max 4 | Auto-scale under burst | Not needed if 2 replicas handle it |
| Controller HPA | enabled, max 3 | Auto-scale under queue pressure | Not needed if 2 replicas handle it |

### Worker pod resources (requires code change to modify)

| Resource | Current (hardcoded) | Recommendation |
|----------|-------------------|----------------|
| Worker CPU request | 1 | Keep as-is — Chromium needs it |
| Worker CPU limit | 2 | Keep as-is — allows burst during page load |
| Worker memory request | 2Gi | Keep as-is — Chromium baseline |
| Worker memory limit | 3Gi | Keep as-is — prevents OOM on complex pages |
| noVNC CPU request | 0.1 | Keep as-is |
| noVNC memory request | 128Mi | Keep as-is |

### Infrastructure

| Component | Starting Value | Notes |
|-----------|---------------|-------|
| Postgres PVC | 20Gi | Sufficient for testing. Monitor usage. |
| Redis memory limit | 512Mi | May need increase if 200 sessions generate heavy credential cache |
| NATS PVC | 10Gi | Sufficient unless JetStream retention is long |
| MinIO PVC | 50Gi | Monitor — artifact bundles can be large |
| Nodes | Enough for 200 × (1.1 CPU + 2.1Gi) + infra = ~250 CPU, ~450Gi RAM | This is the real constraint |

### Cloud vs on-prem differences

| Aspect | Cloud (TrueFoundry) | On-prem |
|--------|---------------------|---------|
| Node scaling | Karpenter auto-provisions (deploy.yaml has Karpenter affinity) | Fixed node pool, must pre-provision |
| Image pull | ECR with cache, fast | May need pre-pull DaemonSet |
| Storage | EBS gp3 (expandable) | Depends on StorageClass |
| PVC resize | May hit permissions issue (known issue) | Depends on CSI driver |
| Worker scheduling | Karpenter prefers on-demand nodes | Must ensure enough headroom |

---

## 8. Known Issue: PVC Resize

### Current state

PVC resize attempts cause permission or cluster errors. This is a known issue.

### Likely cause

1. **StorageClass does not have `allowVolumeExpansion: true`** — most common cause. The default StorageClass in many clusters (especially managed K8s like EKS with gp2) does not allow expansion.
2. **StatefulSet PVC template** — Kubernetes does not allow modifying `volumeClaimTemplates` on an existing StatefulSet. To resize, you must: edit the PVC directly (`kubectl patch pvc`), delete the StatefulSet with `--cascade=orphan`, and recreate it with the new size.
3. **CSI driver limitations** — Some CSI drivers (especially on-prem) don't support online expansion.

### Does it block load testing?

**No, for most tests.** Default PVC sizes (Postgres 20Gi, MinIO 50Gi) are sufficient for load testing up to 200 sessions for hours. Artifact bundles (MinIO) are the most likely to grow — monitor disk usage during soak tests.

**Yes, if:** You run extended soak tests (8+ hours) that generate many artifact bundles without cleanup. Or if Postgres WAL grows under heavy write load.

### Future fix needed

1. Verify StorageClass has `allowVolumeExpansion: true` in production and staging
2. Document the StatefulSet PVC resize procedure (orphan cascade + recreate)
3. Consider adding a Helm hook or migration job for PVC resize
4. Add PVC usage monitoring/alerting (> 80% triggers warning)

---

## 9. Risks & Open Questions

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Node capacity exhausted during test | High (at 200 sessions) | Pods stuck in Pending | Use ResourceQuota, ramp gradually, watch Pending count |
| Controller can't keep up with queue | Medium | Sessions stuck in STARTING | Increase batch size or replicas |
| DB pool exhaustion | Medium (at high concurrency) | 5xx cascade | Increase `DB_POOL_SIZE`, monitor `pg_stat_activity` |
| Cold image pull delays | High (first test on new nodes) | 3-5 min time-to-healthy | Pre-pull images before test |
| Circuit breaker trips | Medium (if many sessions fail) | All sessions blocked | Monitor circuit breaker state, reduce thresholds for test |
| Orphaned pods after test | Low | Wasted cluster resources | Cleanup script + idle timeout as safety net |
| Worker resources can't be tuned without rebuild | Already true | Can't experiment with smaller pods | Fix the hardcoded resources tech debt first |

### Open questions

1. **What are the actual production values** for `IDLE_SHUTDOWN_SECONDS`, `RECONCILE_BATCH_SIZE`, `DB_POOL_SIZE`? (Check deploy.yaml env vars in CI/CD)
2. **Is image caching in place?** Do nodes have the worker image pre-pulled? (Check node image list)
3. **What node types are available?** Karpenter provisioner config determines what instances can be spun up
4. **Is there a staging cluster separate from prod?** Or do we test in the same cluster with a different namespace?
5. **Should we fix the hardcoded worker resources before load testing?** Making them configurable via env vars would allow experimenting with smaller pods (e.g., 0.5 CPU request instead of 1) to fit more sessions per node
6. **Should we fix the missing nodeSelector/tolerations passthrough?** Without it, worker pods may land on control plane nodes or nodes meant for other workloads
7. **What's the Karpenter max node count / EC2 vCPU quota?** At 200 sessions × 1.1 CPU, you need ~220 CPU cores of headroom just for workers
8. **Are there Prometheus + kube-state-metrics in the cluster?** If not, monitoring during load tests is limited to `kubectl` and logs
9. **Warm session pools (listed as future work in platform handoff doc)** — should we implement pre-warming before load testing? Without it, every session is a cold start.
10. **The 150s platform polling timeout** — at 200 concurrent cold starts, many sessions will exceed this. Is that acceptable for the load test, or should we test with pre-created sessions?
