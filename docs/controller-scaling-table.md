# Plan: NATS Resilience + Bug Fixes + Platform Error Handling + Resource Config

## Context

Production issues: NATS dies permanently (no reconnect), sessions show stale HITL data, platform waits 150s silently, pods restart randomly (memory pressure + aggressive probes). Resources are not configured in the deploy manifest — prod uses chart defaults designed for local dev.

---

## Part A: Code Fixes (Tabby)

### A1. NATS Reconnection + Resilience

**Problem**: All 5 NATS connections use defaults (10 retries then die forever).

**Fix**: Create shared helper `packages/shared/src/nats-connect.ts`:

```typescript
export async function connectNats(url: string, logger: { log, warn, error }): Promise<NatsConnection> {
  const nc = await connect({
    servers: url,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
    reconnectJitter: 1000,
    pingInterval: 10_000,
    maxPingOut: 3,
  });
  // Status monitor — exit on permanent close so K8s restarts
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === 'disconnect') logger.warn('NATS disconnected, reconnecting...');
      if (s.type === 'reconnect') logger.log('NATS reconnected');
    }
    logger.error('NATS connection permanently closed, exiting');
    process.exit(1);
  })();
  return nc;
}
```

**Files**: controller/nats-publisher.service.ts, api/events.gateway.ts, slack-bot/nats-listener.ts, teams-bot/nats-listener.ts, worker/artifact-extractor.ts (worker: basic retry only, no monitor).

### A2. Clear `pending_input_request` on HEALTHY

**File**: `apps/controller/src/state-machine.service.ts` — `transitionToHealthy()` (~line 364)

Add `pending_input_request: null` to the update.

### A3. Log errors in session-status `generateStreamUrl`

**File**: `apps/api/src/modules/agent/agent.service.ts` (~line 110)

Change empty `catch {}` to `catch (err) { this.logger.warn(...); }`.

### A4. Dockerfiles — Heap Size

- `infra/docker/Dockerfile.api`: `--max-old-space-size=1024` → `700`
- `infra/docker/Dockerfile.controller`: add `--max-old-space-size=700`

### A5. noVNC Cache LRU

**File**: `apps/api/src/modules/streaming/streaming.controller.ts` (~line 819)

Before inserting into `noVncAssetCache`, if size >= 50, delete the first key (oldest).

### A6. Health Probes — More Tolerant

**Files**: `charts/browser-hitl/templates/api-deployment.yaml`, `controller-deployment.yaml`

Add `timeoutSeconds: 5` and `failureThreshold: 5` to liveness and readiness probes.

---

## Part B: Code Fixes (Platform — adoptwebui)

### B1. Log errors in `_get_session_status()`

**File**: `backend/app/services/tabby_resolution_service.py` (~line 369)

Add `logger.warning(f"Failed to get session status: {e}")` in the except block.

### B2. Reduce polling + detect Tabby offline

**File**: `backend/app/services/tabby_resolution_service.py` (~line 170)

- Keep `max_attempts` at 50 (150s) — prod cold starts take ~2 min. The streaming fix (B5) handles transparency.
- Track consecutive empty responses — 5 in a row with no state change = emit warning log + set `state: "UNREACHABLE"` in the HITL response (but don't break the loop early — Tabby may recover)

### B3. Catch all exceptions in `resolve_tabby_tokens_or_hitl`

**File**: `backend/app/services/tabby_resolution_service.py` (~line 544)

Add generic `except Exception` that returns a clear error response instead of 500.

### B4. `build_hitl_response` handle UNREACHABLE

**File**: `backend/app/services/tabby_resolution_service.py` (~line 470)

If `state == "UNREACHABLE"`: message = "Browser automation service is not responding", `warming_up = False`.

### B5. Stream Tabby provisioning status via Redis Streams

**Problem**: The polling loop blocks 60-150s silently. User sees "thinking..." with zero transparency.

**Discovery**: The platform already has Redis Streams infrastructure (`backend/app/routes/stream.py`, `GET /stream/{channel_id}`) that pushes NDJSON events to the Experience SDK in real-time. The SDK processes events via `useConversation` hook and renders steps via `StreamMessage` component.

**Approach**: During the Tabby polling loop, emit `tabby_provisioning` events to the same Redis stream the conversation uses. The Experience SDK picks them up and shows status.

**Backend changes** (`tabby_resolution_service.py`):

- Accept `redis_manager` + `channel_id` (conversation ID) params
- Inside polling loop, emit events every ~15s (not every 3s):
  ```python
  if attempt % 5 == 0 and redis_manager:
      await redis_manager.xadd(f"stream:request:{channel_id}", {
          "activity": "tabby_provisioning",
          "data": json.dumps({
              "state": state, "attempt": attempt,
              "message": "Starting browser session..." if state == "STARTING" 
                  else "Waiting for login..." if state in ("LOGIN_NEEDED", "LOGIN_IN_PROGRESS")
                  else f"Session state: {state}",
              "vnc_url": vnc_url,
          })
      })
  ```

**Route changes** (`conversation.py`, `end_user_conversation.py`):

- Pass `redis_manager` + `channel_id` to `resolve_tabby_tokens()`

**Frontend changes** (`useConversation/index.jsx`):

- Handle `activity === "tabby_provisioning"` — show step indicator with message
- If `vnc_url` present, show clickable VNC link

**Note**: This is a larger change that can be done incrementally. Ship B1-B4 first (reduced polling + better errors), then add streaming as follow-up.

---

## Part C: Resource Configuration for Prod (deploy.yaml)

### How it works

The `infra/tfy/deploy.yaml` passes `values:` to Helm via TrueFoundry/ArgoCD. Currently it does NOT override resources — prod uses the `values.yaml` defaults (designed for local dev: 500m CPU, 512Mi mem). Adding resource blocks here makes them controllable via CI/CD (GitHub Environment secrets + envsubst).

### How to calculate resources

**Rule of thumb for Node.js services:**

- **Memory request** = typical working set (what it uses normally)
- **Memory limit** = request × 1.5-2x (headroom for spikes/GC)
- `**--max-old-space-size`** = ~70% of memory limit (rest for Node overhead, buffers, RSS)
- **CPU request** = average sustained usage
- **CPU limit** = 2-4x request (allow bursts)

**For stateful services (Postgres, Redis, NATS, MinIO):**

- **Memory** = data working set + overhead. Postgres: shared_buffers = 25% of available RAM
- **NATS JetStream**: maxMemory should be ≤ 60% of pod memory limit
- **Don't over-request** — K8s scheduler places by requests, not limits. Over-requesting wastes node capacity.

### Recommended values for "many users" prod

**Sized for ~500 concurrent users** (not all active simultaneously, but spikes of 50-100 concurrent sessions possible).


| Component        | CPU req | CPU limit | Mem req | Mem limit | Replicas | Notes                                                                               |
| ---------------- | ------- | --------- | ------- | --------- | -------- | ----------------------------------------------------------------------------------- |
| **API**          | 1000m   | 4000m     | 1Gi     | 2Gi       | 2        | Stateless. 2 replicas for HA + load. Heap=1400Mi with 2Gi limit                     |
| **Controller**   | 500m    | 2000m     | 768Mi   | 1.5Gi     | 2        | After Part E scaling fixes. Advisory lock = only 1 reconciles, other is hot standby |
| **Worker**       | 1000m   | 2000m     | 2Gi     | 3Gi       | dynamic  | ~50-100 concurrent. Controller creates/destroys. Chromium needs memory              |
| **Worker noVNC** | 100m    | 250m      | 128Mi   | 256Mi     | —        | Sidecar per worker                                                                  |
| **Slack Bot**    | 100m    | 500m      | 256Mi   | 512Mi     | 1        | Socket Mode, scales vertically fine                                                 |
| **Postgres**     | 1000m   | 4000m     | 2Gi     | 4Gi       | 1        | 500 users = more connections, bigger working set. shared_buffers ~1Gi               |
| **Redis**        | 250m    | 1000m     | 512Mi   | 1Gi       | 1        | Stream tokens + locks + blacklist for 500 users                                     |
| **NATS**         | 500m    | 2000m     | 1Gi     | 2Gi       | 1        | JetStream maxMemory=1Gi. 500 users = many events in flight                          |
| **MinIO**        | 250m    | 1000m     | 512Mi   | 1Gi       | 1        | Artifact storage scales with workers                                                |
| **Egress Proxy** | 250m    | 1000m     | 256Mi   | 512Mi     | 1        | All worker traffic funnels through here                                             |


**Cost estimate**: ~16 vCPU request, ~9Gi memory request for infra (excluding workers). Workers add ~1 vCPU + 2Gi per concurrent session. With 50 concurrent sessions: ~66 vCPU + ~109Gi total.

### What to add in deploy.yaml

All resource values, replicas, and affinity come from env vars (already the pattern). Chart defaults serve local dev. Prod overrides via GitHub Environment secrets. If env var is not set, don't include the field — Helm uses chart default.

Add resource + affinity + replica env vars to `deploy-staging.yaml` and `deploy-production.yaml` workflow env blocks. Add corresponding `${VAR}` references to `deploy.yaml`.

Node affinity block for critical services (Postgres, Controller, NATS, Redis):

```yaml
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          preference:
            matchExpressions:
              - key: karpenter.sh/capacity-type
                values: [on-demand]
                operator: In
```

### Scaling characteristics


| Component      | Scales horizontally?            | Bottleneck at scale                | 500 users                    | 3k users                                                |
| -------------- | ------------------------------- | ---------------------------------- | ---------------------------- | ------------------------------------------------------- |
| **API**        | Yes, unlimited                  | DB connection pool                 | 2-3 replicas                 | 5-10 replicas, managed DB connection pooler (PgBouncer) |
| **Controller** | Yes, after Part E (partitioned) | Reconcile throughput per partition | 2-3 replicas                 | 5+ replicas, each handling ~100 apps                    |
| **Worker**     | Yes, dynamic                    | Node capacity                      | ~50-100 concurrent pods      | ~200-500 concurrent pods, multi-AZ node groups          |
| **Postgres**   | No (single instance)            | Connections + IOPS                 | In-cluster, bumped resources | Managed RDS with read replicas                          |
| **Redis**      | No (single instance)            | Memory                             | In-cluster, 1Gi              | Managed ElastiCache                                     |
| **NATS**       | No (single instance)            | JetStream memory                   | In-cluster, 2Gi              | NATS cluster (3 nodes) or managed                       |
| **MinIO**      | No (single instance)            | Disk IOPS                          | In-cluster, 1Gi              | Managed S3                                              |


### Scaling notes

- **API**: safe to scale to 2+ replicas (stateless, all state in Postgres/Redis)
- **Controller**: Currently single-replica. See Part E below for the 6 fixes needed to make it safe for 2+ replicas.
- **Slack/Teams bot**: safe to scale but unnecessary (low load)
- **Postgres/Redis/NATS/MinIO**: single replica by design (StatefulSets with PVC). Scaling requires clustering (not implemented)

### Spot vs On-Demand (node placement)

`capacity_type: spot_fallback_on_demand` is TFY-native (`type: service` only). For `type: helm`, use Kubernetes `nodeSelector` + `tolerations` in Helm values. Our chart already exposes these for every component.

**PVCs survive spot interruptions** — data is safe. Risk is only downtime during reschedule (1-5min).

**Cluster confirmed: Karpenter with `karpenter.sh/capacity-type` labels** (verified from opensandbox prod manifest).

**Strategy**: Use `affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution` (soft preference) for critical components — prefers on-demand but accepts spot if unavailable. Same pattern as opensandbox-server in prod. Non-critical components get no affinity (scheduled anywhere, typically spot).


| Component       | Placement               | Why                                       |
| --------------- | ----------------------- | ----------------------------------------- |
| Postgres        | prefer on-demand        | DB downtime = everything offline          |
| Controller      | prefer on-demand        | Creates sessions, single instance         |
| NATS            | prefer on-demand        | Connection death cascades to all services |
| Redis           | prefer on-demand        | Token blacklist, stream tokens, locks     |
| API             | no preference (spot ok) | Stateless, can restart quickly            |
| MinIO           | no preference (spot ok) | Restart only delays artifact access       |
| Worker          | no preference (spot ok) | Ephemeral by design, controller recreates |
| Slack/Teams bot | no preference (spot ok) | Reconnects on restart                     |
| Egress Proxy    | no preference (spot ok) | Stateless                                 |


**Affinity block** (same for postgres, controller, nats, redis):

```yaml
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          preference:
            matchExpressions:
              - key: karpenter.sh/capacity-type
                values:
                  - on-demand
                operator: In
```

This goes in the `deploy.yaml` under each component's `values:` block.

---

## Part D: CI/CD Integration

No new GitHub secrets for resources. Prod values are hardcoded in `deploy.yaml` (visible in git). Chart defaults serve local dev.

---

## Part E: Controller Multi-Replica Scaling

### Goal

Make controller safe to run 2+ replicas so it can survive spot interruptions and handle more load.

### 6 Fixes Required (implementation order)

**E1. Reconcile loop — distributed lock** (CRITICAL)
**File:** `apps/controller/src/reconcile.service.ts` (~line 70)

Wrap `doReconcile()` with `pg_advisory_lock(1000)`. Only one replica reconciles at a time. Others skip and wait for next interval.

```typescript
async reconcile(): Promise<void> {
  const acquired = await this.sessionRepo.query(
    'SELECT pg_try_advisory_lock($1) as locked', [1000]
  );
  if (!acquired[0]?.locked) return; // Another replica has it
  try {
    await this.doReconcile();
  } finally {
    await this.sessionRepo.query('SELECT pg_advisory_unlock($1)', [1000]);
  }
}
```

Use `pg_try_advisory_lock` (non-blocking) so the replica doesn't hang waiting — it just skips.

**E2. Session creation — row-level lock on app** (CRITICAL)
**File:** `apps/controller/src/reconcile.service.ts` (~line 127)

Before counting active sessions and creating new ones, lock the app row:

```typescript
private async reconcileApp(app: ApplicationEntity): Promise<void> {
  // Lock app row to prevent concurrent session creation
  const [locked] = await this.appRepo.query(
    'SELECT * FROM applications WHERE id = $1 FOR UPDATE', [app.id]
  );
  // ... rest of logic uses locked row ...
}
```

This runs inside the advisory-locked reconcile, so the FOR UPDATE is belt-and-suspenders. Prevents any race even if the advisory lock is somehow bypassed.

**E3. State machine — retry on version conflict** (HIGH)
**File:** `apps/controller/src/state-machine.service.ts` (~line 42)

Add retry loop when `state_version` CAS fails:

```typescript
async transition(session: SessionEntity, newState: SessionState): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await this.sessionRepo.query(
      'UPDATE sessions SET state=$1, state_version=state_version+1 WHERE id=$2 AND state_version=$3',
      [newState, session.id, session.state_version]
    );
    if (result[1] > 0) {
      session.state = newState;
      session.state_version += 1;
      // ... publish NATS ...
      return true;
    }
    // Reload fresh state
    const fresh = await this.sessionRepo.findOne({ where: { id: session.id } });
    if (!fresh || !isValidSessionTransition(fresh.state as SessionState, newState)) return false;
    Object.assign(session, fresh);
  }
  return false;
}
```

**E4. Pod manager — idempotency check** (MEDIUM)
**File:** `apps/controller/src/pod-manager.service.ts` (~line 42)

Check if pod exists before creating. Catch `AlreadyExists` K8s API error gracefully:

```typescript
async createWorkerPod(session, app): Promise<string> {
  const podName = this.buildPodName(session.id);
  try {
    await this.k8sApi.readNamespacedPod(podName, this.namespace);
    this.logger.log(`Pod ${podName} already exists, reusing`);
    return podName;
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
  // Pod doesn't exist — create it
  // ...
}
```

**E5. NATS streams — skip update if exists** (MEDIUM)
**File:** `apps/controller/src/nats-publisher.service.ts` (~line 39)

If stream already exists, just use it as-is. Don't try concurrent updates:

```typescript
try {
  await jsm.streams.add({ name, subjects, ... });
} catch (err) {
  if (streamAlreadyExists(err)) {
    this.logger.log(`Stream ${name} exists, using as-is`);
    return;
  }
  throw err;
}
```

**E6. Circuit breaker — move to database** (MEDIUM)
**File:** `apps/controller/src/reconcile.service.ts` (~line 30)

Replace in-memory Maps with a `circuit_breaker_state` table:

```sql
CREATE TABLE circuit_breaker_state (
  entity_type VARCHAR NOT NULL,  -- 'app' or 'tenant'
  entity_id VARCHAR NOT NULL,
  pause_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
```

Migration + replace `Map.get/set` with DB reads/writes. Use `INSERT ... ON CONFLICT UPDATE` for upsert.

**E7. Distributed reconciliation via `FOR UPDATE SKIP LOCKED`**

Research (ArgoCD, Tekton, pg-boss, Solid Queue) shows `SKIP LOCKED` is the best pattern for Postgres-backed controllers. Simpler than hash partitioning, automatic work-stealing, zero-config scaling.

**Migration**: Add `last_reconciled_at` and `last_evaluated_at` columns:

```sql
ALTER TABLE applications ADD COLUMN last_reconciled_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN last_evaluated_at TIMESTAMPTZ;
```

**Reconcile loop rewrite** (`reconcile.service.ts`):

```typescript
private async doReconcile(): Promise<void> {
  const batchSize = parseInt(process.env.RECONCILE_BATCH_SIZE || '50', 10);
  const intervalSec = this.intervalMs / 1000;

  // Each replica grabs a batch of apps not being processed by another replica
  await this.appRepo.manager.transaction(async (em) => {
    const apps = await em.query(`
      SELECT * FROM applications
      WHERE desired_session_count > 0
        AND (last_reconciled_at IS NULL OR last_reconciled_at < NOW() - INTERVAL '${intervalSec} seconds')
      ORDER BY last_reconciled_at ASC NULLS FIRST
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    `, [batchSize]);

    for (const app of apps) {
      await this.reconcileApp(app);
      await em.query('UPDATE applications SET last_reconciled_at = NOW() WHERE id = $1', [app.id]);
    }
  });

  // Same pattern for session state evaluation
  await this.evaluateSessionsBatch(batchSize);
}
```

**How it scales:**

- 1 replica: grabs all apps each tick (same as today)
- 3 replicas: each grabs ~1/3, fast replicas steal work from slow ones
- 10 replicas: each grabs ~1/10, wall-clock time drops ~10x
- Add/remove replicas with zero config — just change `controller.replicas`
- Crash-safe: transaction rollback releases locks automatically
- No StatefulSet needed — plain Deployment works

**E1 advisory lock becomes unnecessary** — SKIP LOCKED provides better guarantees. Remove E1 and use SKIP LOCKED as the sole coordination mechanism.

**Singleton duties** (runtime drift detection, orphan pod cleanup): these scan all pods, not per-app. Use K8s Lease-based leader election so only 1 replica runs them. Simple: `@kubernetes/client-node` has built-in `LeaderElection` class.

### After all 7 fixes

- Controller scales to N replicas — just change `controller.replicas` in deploy.yaml
- Work distributed via `FOR UPDATE SKIP LOCKED` — automatic load balancing, work-stealing
- Crash-safe: transaction rollback = instant lock release, other replicas pick up the work
- State transitions are retry-safe (version conflict handling)
- Pod creation is idempotent (AlreadyExists check)
- Circuit breaker state shared across replicas (DB-backed)
- NATS stream setup idempotent across replicas
- Singleton duties (drift detection, orphan cleanup) via K8s Lease leader election
- No StatefulSet required — plain Deployment, same as API

---

## Part G: Simplify IdP resolution in token-exchange

### Problem

The platform sends `idp_id` in the token-exchange request. This is redundant because Tabby enforces **exactly 1 IdP globally** (`identity-providers.service.ts` line 18-21: "Only one IdP is supported"). The token-exchange should just use the single configured IdP without needing to be told which one.

### Tabby side

**File:** `apps/api/src/modules/auth/token-exchange.service.ts` (~line 82-92)

Current logic: if `idp_id` → find by ID, else → find by `issuer_url`. Since there's only 1 IdP, simplify the fallback to just find the single enabled IdP:

```typescript
// Current:
if (params.idp_id) {
  idp = await this.idpRepo.findOne({ where: { id: params.idp_id, enabled: true } });
} else {
  idp = await this.idpRepo.findOne({ where: { issuer_url: issuer, enabled: true } });
}

// New: keep idp_id for backward compat, but fallback finds the single enabled IdP
if (params.idp_id) {
  idp = await this.idpRepo.findOne({ where: { id: params.idp_id, enabled: true } });
} else {
  // Try by issuer first, then just grab the only enabled IdP
  idp = await this.idpRepo.findOne({ where: { issuer_url: issuer, enabled: true } })
    || await this.idpRepo.findOne({ where: { enabled: true } });
}
```

This way: even if the JWT issuer doesn't exactly match `issuer_url` (e.g., trailing slash mismatch), it still works because there's only 1 IdP.

`idp_id` param stays in the interface for backward compat but is effectively unused.

### Platform side (adoptwebui — `feat/simplify-tabby-config`)

1. `tabby_resolution_service.py` — stop sending `idp_id` in the token-exchange body
2. Playground Profile — remove `tabby_idp_id` field from model/schema/API
3. Setup docs — remove `tabby_idp_id` from Playground Profile config instructions

After this, the platform only needs `tabby_url` on the profile. Zero IdP config needed on the platform side.

---

## Part F: Branch Strategy

### Tabby (`/home/moraski/work/tabby`)

- Work on `dev` branch (already up to date)
- New branch from dev for this work

### Platform (`/home/moraski/work/adoptwebui`)

- Start from `feat/simplify-tabby-config` branch
- Update it with latest `dev` first (`git merge dev`)
- If platform fixes are small: commit on `feat/simplify-tabby-config`
- If large: create new branch from `feat/simplify-tabby-config`

### CE (`/home/moraski/work/adoptce`)

- `git stash` local changes
- `git checkout dev && git pull origin dev`
- If CE changes needed: branch from dev
- If no CE changes: stay on dev
- Keep `config.js` configured for local dev (DO NOT COMMIT)

---

## Verification

### Tabby

1. `pnpm run build` + `pnpm run test` — all pass
2. `helm lint charts/browser-hitl/`
3. NATS kill test (local): stop NATS pod → controller reconnects automatically
4. pending_input_request: create session → resolve HITL → verify panel-state shows null after HEALTHY
5. Controller 2 replicas (local): run 2 controller pods → verify no duplicate sessions created
6. State version conflict: simulate concurrent transition → verify retry works

### Platform

1. Backend tests pass
2. Tabby offline: error returned within ~15s (5 empty × 3s)
3. Tabby slow: warming_up within ~60s instead of 150s
4. Error message is clear and actionable

### Deploy

1. `helm template` with prod resource values → correct resource blocks rendered
2. `envsubst < infra/tfy/deploy.yaml` → produces valid YAML with resources
3. Node placement: after confirming labels, `helm template` shows correct nodeSelector

