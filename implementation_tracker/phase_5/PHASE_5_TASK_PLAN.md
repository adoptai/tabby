# Phase 5 Task Plan — Headless Auth Provider: Architecture Hardening

## Scope

Phase 5 covers ADR-010 through ADR-020 — the architecture hardening layer that closes
all remaining specification gaps and strengthens the system for production-grade
headless authentication at scale.

**ADR Coverage:**
- ADR-010: Agent Authentication (OAuth 2.0 Client Credentials)
- ADR-011: Redis Resilience and Tiered Failure Modes
- ADR-012: Three-Barrier Login Serialization
- ADR-013: Credential Response Envelope and Volatility Model
- ADR-014: Service Profile Versioning
- ADR-015: Global Login Coordinator
- ADR-016: Worker Pod Security Baseline
- ADR-017: Extraction Atomicity and Session Liveness
- ADR-018: Log Sanitization Policy (resolves GAP-012)
- ADR-019: Backup/DR Design (resolves GAP-013)
- ADR-020: Observability Specification (resolves GAP-014)

---

## Sprint 1: Foundation (ADR-010 + ADR-011)

### P5-001: Agent Authentication via OAuth 2.0 Client Credentials (ADR-010)

| Field | Value |
|---|---|
| ADR | ADR-010 |
| Priority | CRITICAL |
| Sprint | 1 |
| Depends On | — |

**Work Items:**
1. New entity: `agent_clients` table (client_id, hashed_secret, tenant_id, allowed_profiles, created_at, rotated_at, revoked_at).
2. New endpoint: `POST /auth/agent-token` — validates client credentials, issues scoped JWT with `role: agent`.
3. New role: `agent` added to RBAC enum (distinct from `operator` and `admin`).
4. Admin CRUD endpoints for agent client management:
   - `POST /admin/agent-clients` — create new agent client.
   - `GET /admin/agent-clients` — list agent clients (redacted secrets).
   - `DELETE /admin/agent-clients/:id` — revoke agent client.
5. Secret rotation endpoint: `POST /admin/agent-clients/:id/rotate` — issues new secret, grace period for old secret.
6. **Tests (required):**
   - Unit: token issuance, RBAC scoping, secret hashing.
   - Adversarial: replay attack (reused token after rotation), expired token, revoked client, wrong profile scope.

---

### P5-002: Redis Resilience and Tiered Failure Modes (ADR-011)

| Field | Value |
|---|---|
| ADR | ADR-011 |
| Priority | CRITICAL |
| Sprint | 1 |
| Depends On | — |

**Work Items:**
1. `RedisHealthMonitor` service with state machine: `HEALTHY` → `DEGRADED` → `DOWN`.
   - Periodic health probe (configurable interval, default 5s).
   - State transition thresholds (consecutive failures before escalation).
2. Tier classification for all 10 Redis key categories:
   - **Tier 1 (fail-closed):** token blacklist, active session locks.
   - **Tier 2 (fail-open with fallback):** credential cache, rate limit counters.
   - **Tier 3 (fail-open, skip):** dashboard metrics, ephemeral counters.
3. Fail-closed token blacklist with emergency mode:
   - When Redis is DOWN, blacklist lookups return "blacklisted" (deny all).
   - Emergency bypass via health endpoint (requires admin auth).
4. Credential cache MinIO fallback path:
   - On Redis DEGRADED/DOWN, credential cache reads/writes fall through to MinIO.
   - Stale-while-revalidate semantics with TTL tracking.
5. **Tests (required):**
   - Unit: state machine transitions, tier behavior per state.
   - Chaos: Redis stop/start scenarios (simulate HEALTHY → DOWN → HEALTHY cycle).

---

## Sprint 2: Login Safety (ADR-012 + ADR-015)

### P5-003: Three-Barrier Login Serialization (ADR-012)

| Field | Value |
|---|---|
| ADR | ADR-012 |
| Priority | CRITICAL |
| Sprint | 2 |
| Depends On | P5-002 (RedisHealthMonitor for lock tier classification) |

**Work Items:**
1. `AuthRequest` entity with lifecycle management:
   - Columns: id, profile_id, state (PENDING/LOCKED/EXECUTING/COMPLETE/FAILED/STALE), created_at, locked_at, completed_at.
   - State transitions enforced at entity level.
2. Barrier 1 — Redis lock:
   - `SET NX` with TTL on `auth-lock:{profile_id}`.
   - Tier 1 classification (fail-closed when Redis DOWN).
3. Barrier 2 — PG row-level lock on AuthRequest entity:
   - `SELECT ... FOR UPDATE SKIP LOCKED` on AuthRequest row.
   - NOT advisory lock — uses actual row-level locking.
4. Barrier 3 — Worker-side rate guard:
   - PG-persisted timestamp (`last_login_attempt_at` on profile entity).
   - Minimum interval enforcement (configurable, default 30s).
5. Stale detection sweep in Controller reconcile loop:
   - AuthRequests in LOCKED/EXECUTING state beyond TTL are transitioned to STALE.
   - STALE requests release Redis lock and PG lock.
6. **Tests (required):**
   - Concurrency: parallel login attempts for same profile (verify serialization).
   - Split-brain simulation: Redis lock acquired but PG lock fails (verify rollback).

---

### P5-004: Global Login Coordinator (ADR-015)

| Field | Value |
|---|---|
| ADR | ADR-015 |
| Priority | HIGH |
| Sprint | 2 |
| Depends On | P5-003 (AuthRequest entity reused) |

**Work Items:**
1. `login_queue` PG table:
   - Columns: id, auth_request_id, domain, priority, enqueued_at, started_at, completed_at.
   - Index on (domain, enqueued_at) for ordered processing.
2. Controller queue processing with per-domain rate limits:
   - Configurable max concurrent logins per domain (default: 1).
   - Global max concurrent logins across all domains (default: 3).
3. PG `LISTEN/NOTIFY` for event-driven queue processing:
   - `NOTIFY login_queue_changed` on INSERT/UPDATE.
   - Controller subscribes and processes on notification (no polling).
4. Startup stagger integration:
   - On controller startup, delay queue processing by configurable duration.
   - Prevents thundering herd after pod restart.
5. **Tests (required):**
   - Queue ordering: FIFO within same domain, parallel across domains.
   - Concurrent domain limits: verify max 1 login per domain enforced.
   - Startup simulation: verify stagger delay respected before first dequeue.

---

## Sprint 3: Credential Contract (ADR-013 + ADR-014)

### P5-005: Credential Response Envelope and Volatility Model (ADR-013)

| Field | Value |
|---|---|
| ADR | ADR-013 |
| Priority | HIGH |
| Sprint | 3 |
| Depends On | — |

**Work Items:**
1. Standardized JSON response schema for all credential endpoints:
   ```json
   {
     "credentials": { ... },
     "metadata": {
       "profile_id": "...",
       "extracted_at": "ISO8601",
       "volatility": "stable|volatile|ephemeral",
       "ttl_seconds": 3600,
       "source": "cache|live"
     }
   }
   ```
2. Per-credential-type volatility classification:
   - **Stable:** cookies with long expiry, stored tokens.
   - **Volatile:** session cookies, CSRF tokens.
   - **Ephemeral:** OTP codes, short-lived access tokens.
3. `force_refresh` with coalescing (subscriber wait pattern):
   - When `force_refresh=true`, first caller triggers extraction.
   - Subsequent callers within coalescing window (default 10s) subscribe and wait for same result.
   - Prevents parallel extractions for same profile.
4. Volatile credential explicit error when worker unavailable:
   - If credential is volatile and no worker can serve it, return HTTP 503 with `retry_after_seconds`.
   - Do NOT return stale volatile credentials.
5. **Tests (required):**
   - Schema validation: all credential endpoints return conforming envelope.
   - Volatility classification: verify correct classification per credential type.
   - `force_refresh` coalescing: 5 concurrent requests result in 1 extraction.

---

### P5-006: Service Profile Versioning (ADR-014)

| Field | Value |
|---|---|
| ADR | ADR-014 |
| Priority | HIGH |
| Sprint | 3 |
| Depends On | P5-005 (version_state affects credential delivery) |

**Work Items:**
1. Profile version model:
   - New columns on profile entity: `version` (integer), `version_state` (enum), `parent_version` (nullable integer).
   - Version state enum: `STAGING`, `CANARY`, `ACTIVE`, `RETIRED`.
2. State machine: `STAGING` → `CANARY` → `ACTIVE` → `RETIRED`:
   - Only one `ACTIVE` version per profile at any time.
   - Promotion to `ACTIVE` automatically retires previous `ACTIVE` version.
3. Admin promotion/rollback API endpoints:
   - `POST /admin/profiles/:id/versions/:version/promote` — advance to next state.
   - `POST /admin/profiles/:id/versions/:version/rollback` — revert to parent version.
4. Canary evaluation with minimum traffic threshold:
   - Canary version receives configurable percentage of traffic (default 10%).
   - Minimum traffic threshold (default 5 requests) before promotion is allowed.
   - Auto-rollback if error rate exceeds threshold during canary.
5. **Tests (required):**
   - Promotion pipeline: STAGING → CANARY → ACTIVE full lifecycle.
   - Rollback: mid-canary rollback restores previous ACTIVE version.
   - Zero-traffic canary rejection: promotion blocked if minimum traffic not met.

---

## Sprint 4: Infrastructure Hardening (ADR-016 + ADR-017 + Gaps)

### P5-007: Worker Pod Security Baseline (ADR-016)

| Field | Value |
|---|---|
| ADR | ADR-016 |
| Priority | HIGH |
| Sprint | 4 |
| Depends On | — |

**Work Items:**
1. `readOnlyRootFilesystem` with `emptyDir` mounts:
   - `/tmp` — general temp files.
   - `/home/pwuser/.cache` — Playwright browser cache.
   - `/home/pwuser/.config` — Playwright config.
2. `/dev/shm` mount for Chromium shared memory:
   - `medium: Memory` emptyDir, size limit 256Mi.
3. Drop ALL capabilities, seccomp `RuntimeDefault`:
   ```yaml
   securityContext:
     runAsNonRoot: true
     readOnlyRootFilesystem: true
     allowPrivilegeEscalation: false
     capabilities:
       drop: ["ALL"]
     seccompProfile:
       type: RuntimeDefault
   ```
4. Encryption key from Secret volume mount (not env var):
   - Mount path: `/etc/secrets/encryption-key`.
   - Worker reads key from file at startup.
   - Remove `ENCRYPTION_KEY` env var from deployment spec.
5. Helm template updates:
   - All worker-related templates updated.
   - Values file with sensible defaults and override points.
6. **Tests (required):**
   - Pod spec validation: rendered Helm template matches security requirements.
   - Chromium starts with security context: worker can launch browser with `readOnlyRootFilesystem`.

---

### P5-008: Extraction Atomicity and Session Liveness (ADR-017)

| Field | Value |
|---|---|
| ADR | ADR-017 |
| Priority | HIGH |
| Sprint | 4 |
| Depends On | — |

**Work Items:**
1. All-or-nothing extraction pipeline:
   - Extraction writes to staging area (temp keys/rows).
   - On success: atomic swap from staging to live.
   - On failure: staging area cleaned up, previous live credentials untouched.
2. Liveness heartbeat (separate async loop, 30s interval):
   - Worker sends heartbeat to API/Controller via NATS.
   - Heartbeat includes: session_id, worker_id, timestamp, browser_state.
3. Session entity `last_heartbeat` column:
   - Updated on each heartbeat received.
   - Nullable (null = no heartbeat received yet).
4. Controller reconcile loop heartbeat checking:
   - Sessions with `last_heartbeat` older than 2x heartbeat interval (60s) marked as unhealthy.
   - Unhealthy sessions trigger re-extraction or session teardown.
5. **Tests (required):**
   - Partial extraction rollback: extraction fails midway, verify previous credentials intact.
   - Heartbeat detection: verify controller detects missing heartbeats.
   - Browser crash simulation: worker process dies, verify session marked unhealthy within 2 intervals.

---

### P5-009: Log Sanitization Policy (ADR-018 — resolves GAP-012)

| Field | Value |
|---|---|
| ADR | ADR-018 |
| Priority | HIGH |
| Sprint | 4 |
| Depends On | — |

**Work Items:**
1. URL redaction middleware:
   - Strip query parameters containing tokens, codes, secrets, keys from logged URLs.
   - Pattern matching: `token=`, `code=`, `secret=`, `key=`, `password=`, `access_token=`.
   - Replacement: `[REDACTED]`.
2. PII hashing for email addresses in audit logs:
   - SHA-256 hash with per-tenant salt.
   - Original email never stored in log output.
   - Hash prefix (first 8 chars) used for log correlation.
3. Error message scrubbing:
   - Stack traces: file paths only (no variable values).
   - HTTP error responses: generic messages for 4xx/5xx (detail in server logs only).
   - Database errors: connection strings and query parameters stripped.
4. **Tests (required):**
   - Sensitive data detection: feed known sensitive URLs through middleware, verify no leakage.
   - PII hashing: verify email to hash is deterministic and non-reversible.
   - Error scrubbing: verify stack traces and DB errors are sanitized.

---

### P5-010: Backup/DR Design (ADR-019 — resolves GAP-013)

| Field | Value |
|---|---|
| ADR | ADR-019 |
| Priority | MEDIUM |
| Sprint | 4 |
| Depends On | — |

**Work Items:**
1. RPO/RTO targets per data store:
   - PostgreSQL: RPO 1 hour, RTO 4 hours.
   - Redis: RPO N/A (ephemeral, re-derivable), RTO 5 minutes.
   - MinIO: RPO 1 hour, RTO 4 hours.
2. PG backup validation script:
   - `scripts/validate-pg-backup.sh` — restore to temp database, run schema check, drop.
   - Intended for cron or CI execution.
3. Redis state re-derivation procedure:
   - Document all Redis key categories and their source-of-truth (PG or computed).
   - Script/runbook to rebuild Redis state from PG after total Redis loss.
4. DR runbook section:
   - Added to `docs/DR_RUNBOOK.md`.
   - Step-by-step for each failure mode: PG loss, Redis loss, MinIO loss, full cluster loss.
5. **Tests (required):**
   - Backup restore verification: PG backup script produces restorable dump.

---

### P5-011: Observability Specification (ADR-020 — resolves GAP-014)

| Field | Value |
|---|---|
| ADR | ADR-020 |
| Priority | MEDIUM |
| Sprint | 4 |
| Depends On | — |

**Work Items:**
1. OpenTelemetry trace propagation across API → NATS → Worker:
   - `@opentelemetry/sdk-node` integration in API, Controller, Worker.
   - NATS message headers carry trace context (`traceparent`, `tracestate`).
2. `X-Request-Id` header propagation:
   - Generated at API ingress if not present.
   - Propagated through NATS messages and worker logs.
   - Returned in all API responses.
3. Stage-level latency histograms for 7-stage pipeline:
   - Stages: request_received, queued, lock_acquired, worker_assigned, browser_launched, extraction_complete, response_sent.
   - Histogram metric: `auth_pipeline_stage_duration_seconds` with `stage` label.
4. Dashboard specification:
   - JSON dashboard definition (Grafana-compatible).
   - Panels: pipeline latency p50/p95/p99, active sessions, queue depth, Redis health state, error rate by type.
5. **Tests (required):**
   - Trace correlation: end-to-end request produces linked spans across all services.
   - Metric presence: all 7 stage histograms are emitted after a complete pipeline run.

---

## Dependencies

```
P5-001 ──────────────────────────────────────────────────────────────────→ (independent)
P5-002 ──→ P5-003 ──→ P5-004                                             (chain)
P5-005 ──→ P5-006                                                         (chain)
P5-007 ──────────────────────────────────────────────────────────────────→ (independent)
P5-008 ──────────────────────────────────────────────────────────────────→ (independent)
P5-009 ──────────────────────────────────────────────────────────────────→ (independent)
P5-010 ──────────────────────────────────────────────────────────────────→ (independent)
P5-011 ──────────────────────────────────────────────────────────────────→ (independent)
```

- **P5-002 → P5-003:** Redis resilience must be in place before login serialization, because the Redis lock (barrier 1) tier classification depends on `RedisHealthMonitor`.
- **P5-003 → P5-004:** Login serialization must be in place before global coordinator, because the `AuthRequest` entity is reused by the queue system.
- **P5-005 → P5-006:** Credential envelope must be defined before profile versioning, because `version_state` affects credential delivery behavior.

---

## Validation Strategy

1. **Every sprint ends with a full test suite run** — currently 385 tests plus all new tests from that sprint.
2. **Adversarial tests are mandatory** for all security-critical items:
   - P5-001 (Agent Auth): replay, expiry, revocation, scope violation.
   - P5-002 (Redis Resilience): chaos scenarios with Redis stop/start.
   - P5-003 (Login Serialization): concurrency races, split-brain.
3. **Helm template linting** required after P5-007 (pod security) changes:
   - `helm lint charts/browser-hitl`
   - `helm template browser-hitl charts/browser-hitl | kubeval --strict`
4. **No task is marked complete** without passing tests committed alongside the implementation.

---

## Task Summary

| ID | Title | ADR | Sprint | Priority | Depends On |
|---|---|---|---|---|---|
| P5-001 | Agent Authentication (OAuth 2.0 Client Credentials) | ADR-010 | 1 | CRITICAL | — |
| P5-002 | Redis Resilience and Tiered Failure Modes | ADR-011 | 1 | CRITICAL | — |
| P5-003 | Three-Barrier Login Serialization | ADR-012 | 2 | CRITICAL | P5-002 |
| P5-004 | Global Login Coordinator | ADR-015 | 2 | HIGH | P5-003 |
| P5-005 | Credential Response Envelope and Volatility Model | ADR-013 | 3 | HIGH | — |
| P5-006 | Service Profile Versioning | ADR-014 | 3 | HIGH | P5-005 |
| P5-007 | Worker Pod Security Baseline | ADR-016 | 4 | HIGH | — |
| P5-008 | Extraction Atomicity and Session Liveness | ADR-017 | 4 | HIGH | — |
| P5-009 | Log Sanitization Policy | ADR-018 | 4 | HIGH | — |
| P5-010 | Backup/DR Design | ADR-019 | 4 | MEDIUM | — |
| P5-011 | Observability Specification | ADR-020 | 4 | MEDIUM | — |
