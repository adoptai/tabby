# Controller Horizontal Scaling Strategy

## Problem

The Tabby controller runs a reconcile loop every 15 seconds that processes all applications and sessions sequentially. At 500+ concurrent users with 50-100 active sessions, a single controller becomes a bottleneck — the loop takes minutes to complete, delaying pod creation, state transitions, and HITL notifications.

## Requirements

- Scale to 500-3000 concurrent users
- No single point of failure
- Automatic failover on crash
- Zero-config scaling (just change replica count)
- No new infrastructure dependencies (already have Postgres, NATS, Redis)

## Options Evaluated

### 1. Leader Election (Active/Standby)

**How it works:** Single active instance holds a Kubernetes Lease. Standby replicas wait. On crash, a standby takes over in ~15s.

**Pros:** Simplest to implement. Zero risk of two controllers acting on the same session.

**Cons:** Does not increase throughput. One instance still does all the work. Vertical scaling only.

**Verdict:** Solves HA but not the scaling problem.

### 2. Hash-Based Sharding (ArgoCD / Tekton Pattern)

**How it works:** Run controller as a StatefulSet. Each replica knows its ordinal (0..N-1). Assignment: `hash(app.id) % N === myOrdinal`. Each replica only reconciles its assigned apps.

**Production examples:** ArgoCD (`ARGOCD_CONTROLLER_REPLICAS`), Tekton Pipelines (3x throughput improvement reported by Red Hat), KubeVela.

**Pros:** Proven at scale. Deterministic assignment. Each replica watches only its subset.

**Cons:** Reshuffling on scale-up/down (apps temporarily unreconciled). Requires StatefulSet. No work-stealing (slow replica = stuck apps). Must keep N consistent between env and actual replicas.

**Verdict:** Designed for controllers operating on Kubernetes CRDs (watch/cache/reconcile pattern). Tabby's controller reads from Postgres — the database itself can distribute work more simply.

### 3. `SELECT ... FOR UPDATE SKIP LOCKED` (Chosen)

**How it works:** Each controller replica runs the same reconcile loop. Instead of loading all apps, each replica grabs a batch of unlocked rows from Postgres. Other replicas skip those rows and grab different ones.

**Production examples:** pg-boss (Node.js), Solid Queue (Rails), Prisma Queue, and any Postgres-backed distributed worker system.

**Pros:**
- Dead simple — no StatefulSet, no ordinals, no consistent hashing
- Works with plain Deployments — add replicas and they share work immediately
- Crash-safe — transaction rollback releases locks automatically
- Natural load balancing — fast replicas grab more work (work-stealing built in)
- No reshuffling — no app-to-shard mapping to maintain
- Zero new infrastructure — Postgres is already the source of truth

**Cons:**
- Requires `last_reconciled_at` column (trivial migration)
- Slightly higher Postgres load from row-level locking (negligible at 500-3000 rows)

**Verdict:** Best fit for our architecture.

### 4. Advisory Locks (Postgres)

**Pros:** No schema changes. Familiar primitive.

**Cons:** Session-level locks survive transaction boundaries (crash = stuck lock). More complex lifecycle than SKIP LOCKED.

**Verdict:** Inferior to SKIP LOCKED for job-queue patterns. Better suited for singleton-process coordination.

### 5. External Queue (NATS JetStream / Redis Streams)

**Pros:** True message queue semantics.

**Cons:** Reconcile is pull-based (periodic scan), not event-driven. Adds failure mode. Over-engineered.

**Verdict:** Not worth the complexity.

## Why SKIP LOCKED Wins

| Criteria | Hash Sharding | SKIP LOCKED |
|----------|--------------|-------------|
| Implementation | StatefulSet + ordinals + registry + heartbeat + rebalance | 1 migration + 1 query change |
| Failover | 30s until another replica adopts orphan partition | Instant — transaction rollback releases lock |
| Load balancing | Static (slow replica = stuck apps) | Automatic work-stealing |
| Scaling | Must keep N consistent between config and replicas | Add replicas, they start working immediately |
| New infrastructure | Registry table + heartbeat mechanism | 2 columns on existing tables |
| Crash recovery | Manual heartbeat expiry + rebalance | Postgres handles it (transaction rollback) |

## No Special Postgres Extensions Required

`FOR UPDATE SKIP LOCKED` is standard SQL supported by PostgreSQL 9.5+ (2016). No extensions, plugins, or special configuration needed. The feature is part of core Postgres.

## How It Works

### The Query

```sql
SELECT * FROM applications
WHERE desired_session_count > 0
  AND (last_reconciled_at IS NULL OR last_reconciled_at < NOW() - INTERVAL '15 seconds')
ORDER BY last_reconciled_at ASC NULLS FIRST
FOR UPDATE SKIP LOCKED
LIMIT 50
```

- `FOR UPDATE` — locks the selected rows for the duration of the transaction
- `SKIP LOCKED` — if a row is already locked by another transaction, skip it silently
- `LIMIT 50` — process in batches (configurable via `RECONCILE_BATCH_SIZE` env)
- `ORDER BY last_reconciled_at ASC NULLS FIRST` — prioritize apps that haven't been reconciled recently (or ever)

### Parallel Execution Example (3 replicas, 150 apps)

```
=== Tick 0s ===

Controller A starts transaction:
  SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50
  → Gets apps 1-50 (locked by A's transaction)

Controller B starts transaction (same moment):
  SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50
  → Apps 1-50 are locked by A → SKIPPED
  → Gets apps 51-100

Controller C starts transaction:
  → Apps 1-100 locked → SKIPPED
  → Gets apps 101-150

=== Processing in parallel ===

Controller A: reconciles apps 1-50 (creates pods, counts sessions)
Controller B: reconciles apps 51-100 (in parallel)
Controller C: reconciles apps 101-150 (in parallel)

=== On completion ===

Controller A:
  UPDATE applications SET last_reconciled_at = NOW() WHERE id IN (1..50)
  COMMIT → locks released

Next tick: these apps won't be picked up again until 15s has passed
```

### Crash Recovery

```
Controller A: grabbed apps 1-50, processing app 23
  → POD DIES (OOM, spot reclaim, etc.)
  → Transaction automatically rolled back by Postgres
  → Locks on apps 1-50 released instantly

Next tick (seconds later):
Controller B: SELECT ... FOR UPDATE SKIP LOCKED
  → Apps 1-50 are unlocked → grabs them normally
  → Apps A didn't finish have stale last_reconciled_at → high priority
```

Zero manual intervention. Zero orphaned apps.

### State Machine Safety

The state machine already uses optimistic locking via `state_version`:

```sql
UPDATE sessions
SET state = 'HEALTHY', state_version = state_version + 1
WHERE id = 'sess-1' AND state_version = 5
```

If two controllers try to transition the same session (unlikely with SKIP LOCKED on sessions too, but possible in edge cases):

```
Controller A: UPDATE ... WHERE state_version = 5 → success (version now 6)
Controller B: UPDATE ... WHERE state_version = 5 → 0 rows affected (version is 6)
Controller B: detects conflict → reloads session → sees it's already HEALTHY → skip
```

With retry logic: reload, check if transition still valid, retry with new version. 3 attempts max.

### Pod Creation Idempotency

Pod names are deterministic: `worker-{session_id}`. If two controllers somehow try to create the same pod:

```
Controller A: check pod exists? → No → creates worker-sess-1
Controller B: check pod exists? → Yes (A just created it) → skip
```

Even without the check, Kubernetes rejects duplicate pod names with `AlreadyExists`.

### Scaling to 500 Users

```
150 apps active, 500 sessions
3 Controller replicas, batch_size=50:

Tick 1 (0s):
  A: apps 1-50    (150 sessions)  ← ~4s processing
  B: apps 51-100  (170 sessions)  ← ~5s processing
  C: apps 101-150 (180 sessions)  ← ~5s processing
  Total: 500 sessions processed in ~5s (instead of ~15s with 1 controller)
```

### Burst Handling (300 new apps)

```
Tick 1:
  A: 50 new apps (last_reconciled_at = NULL → max priority)
  B: 50 new apps
  C: 50 new apps
  → 150 processed in 1 tick

Tick 2:
  A: 50 new apps (remaining)
  B: 50 new apps
  C: 50 new apps
  → All 300 processed in 2 ticks (30s)

Need more throughput? Scale to 5 replicas:
  5 × 50 = 250 apps per tick → 300 apps in 2 ticks
  Or increase batch_size to 100 → 1 tick
```

## Migration

```sql
-- Add reconciliation tracking columns
ALTER TABLE applications ADD COLUMN last_reconciled_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN last_evaluated_at TIMESTAMPTZ;

-- Indexes for the SKIP LOCKED query performance
CREATE INDEX idx_applications_reconcile
  ON applications (last_reconciled_at ASC NULLS FIRST)
  WHERE desired_session_count > 0;

CREATE INDEX idx_sessions_evaluate
  ON sessions (last_evaluated_at ASC NULLS FIRST)
  WHERE state NOT IN ('TERMINATED');
```

Partial indexes keep them small — only active apps/sessions are indexed.

## Singleton Duties

Some tasks must run on exactly one replica (they scan all pods, not per-app):
- Runtime drift detection (verify every pod exists)
- Orphan pod cleanup (find pods without matching sessions)

These use Kubernetes Lease-based leader election (`@kubernetes/client-node` `LeaderElection`). One replica holds the lease and runs these tasks. Others skip. On crash, another replica acquires the lease.

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `RECONCILE_BATCH_SIZE` | 50 | Apps per replica per tick |
| `RECONCILE_INTERVAL_SECONDS` | 15 | Time between reconcile ticks |
| `controller.replicas` | 1 | Number of controller replicas (Helm) |

## References

- [ArgoCD High Availability & Sharding](https://argo-cd.readthedocs.io/en/stable/operator-manual/high_availability/)
- [Tekton StatefulSet Sharding (Red Hat)](https://developers.redhat.com/articles/2026/04/30/how-statefulset-deployments-tripled-openshift-pipelines-throughput)
- [FOR UPDATE SKIP LOCKED Queue Workflows](https://www.netdata.cloud/academy/update-skip-locked/)
- [SKIP LOCKED: The One-Liner Job Queue](https://www.dbpro.app/blog/postgresql-skip-locked)
- [pg-boss: Postgres Job Queue for Node.js](https://github.com/timgit/pg-boss)
- [Kubernetes Controller Sharding (timebertt)](https://github.com/timebertt/kubernetes-controller-sharding)
