# Phase 5 Execution Log

## Governance

1. This log tracks only verified actions performed in Phase 5 scope.
2. All ADR changes require red team validation before marking complete.
3. No code is written without a fully refined, accepted ADR.

## Status: IN PROGRESS — Sprint 2 Implementation

### Red Team Iterations
- Round 1: Initial gap analysis (docs/SPEC_GAP_ANALYSIS.md) — 14 gaps identified
- Round 2: ADR-010 through ADR-017 proposed (docs/ARCHITECTURE_DECISIONS.md)
- Round 3: Deep dive red team on proposed ADRs — 15 findings (7 CRITICAL, 8 HIGH)
- Round 4: ADR amendments applied — all CRITICAL findings resolved

---

## P5-001: Agent Authentication (ADR-010) — COMPLETE

**Commit:** `16a02fc` (feat: implement agent authentication via OAuth 2.0 Client Credentials)

**Files changed:** 10 files, 993 insertions, 19 deletions

| File | Action |
|------|--------|
| `packages/shared/src/enums.ts` | Added `AGENT` to UserRole enum |
| `packages/shared/src/constants.ts` | Added agent-specific DEFAULTS |
| `apps/api/src/entities/agent-client.entity.ts` | NEW — AgentClientEntity |
| `apps/api/src/entities/index.ts` | Added AgentClientEntity export |
| `apps/api/src/modules/auth/auth.service.ts` | Agent credential + token methods |
| `apps/api/src/modules/auth/auth.controller.ts` | Agent token + admin endpoints |
| `apps/api/src/modules/auth/auth.module.ts` | Added AgentClientEntity to TypeORM |
| `apps/api/src/migrations/1708300000002-AgentClients.ts` | NEW — migration |
| `apps/api/src/data-source.ts` | Registered migration |
| `apps/api/src/modules/auth/agent-auth.spec.ts` | NEW — 24 tests |

**Test results:** 24 new tests pass, 16 existing auth tests pass, 254 total tests green.

---

## P5-002: Redis Resilience (ADR-011) — COMPLETE

**Files changed:** 10 files

| File | Action |
|------|--------|
| `packages/shared/src/redis.types.ts` | NEW — RedisHealthState, RedisFailureTier enums, REDIS_TIER_CLASSIFICATION |
| `packages/shared/src/constants.ts` | Added REDIS_PROBE_INTERVAL_MS, REDIS_DOWN_THRESHOLD, etc. |
| `packages/shared/src/index.ts` | Added redis.types export |
| `apps/api/src/modules/redis/redis-health-monitor.ts` | NEW — State machine (HEALTHY→DEGRADED→DOWN), probe, tier evaluation |
| `apps/api/src/modules/redis/redis.module.ts` | NEW — @Global RedisModule |
| `apps/api/src/app.module.ts` | Imported RedisModule |
| `apps/api/src/modules/auth/token-blacklist.service.ts` | Injected monitor, changed fail-open → fail-closed (SECURITY tier) |
| `apps/api/src/modules/auth/token-blacklist.service.spec.ts` | Updated: 8→11 tests, added fail-closed and monitor DOWN tests |
| `apps/api/src/modules/health/health.controller.ts` | Added Redis to readiness check |
| `apps/api/src/modules/redis/redis-health-monitor.spec.ts` | NEW — 28 tests (state machine, tier evaluation, probe, edge cases) |

**Test results:** 28 new monitor tests + 11 blacklist tests pass, 284 total tests green across 19 suites.

**Key decisions:**
- RedisHealthMonitor runs independent PING probe every 5s with 3-state machine
- SECURITY tier (token blacklist): fail-closed when DOWN — all tokens treated as revoked
- CONSISTENCY tier: skip with safe defaults when DEGRADED/DOWN
- AVAILABILITY tier: fail-open when DOWN
- Health endpoints bypass emergency mode (RT-02) — unprotected by JWT auth
- Readiness returns 200 with degraded status, never 503 (RT-03)

---

## P5-003: Three-Barrier Login Serialization (ADR-012) — COMPLETE

**Files changed:** 13 files

| File | Action |
|------|--------|
| `packages/shared/src/enums.ts` | Added AuthRequestState enum |
| `packages/shared/src/constants.ts` | Added REDIS_KEYS.authReqLock, MIN_LOGIN_INTERVAL_MS, LOGIN_LOCK_TTL_MS, AUTH_REQUEST_STALE_MS |
| `packages/shared/src/redis.types.ts` | Added auth_req_lock to SECURITY tier classification |
| `apps/api/src/entities/auth-request.entity.ts` | NEW — AuthRequestEntity with partial unique index |
| `apps/api/src/entities/session.entity.ts` | Added last_login_attempt_at column (Barrier 3, RT-10) |
| `apps/api/src/entities/index.ts` | Added AuthRequestEntity export |
| `apps/api/src/migrations/1708300000003-AuthRequests.ts` | NEW — auth_requests table, partial unique index, sessions column |
| `apps/api/src/data-source.ts` | Registered migration |
| `apps/api/src/modules/login/login-serialization.service.ts` | NEW — Three-barrier service |
| `apps/api/src/modules/login/login-serialization.module.ts` | NEW — LoginSerializationModule |
| `apps/api/src/app.module.ts` | Imported LoginSerializationModule |
| `apps/api/src/modules/login/login-serialization.spec.ts` | NEW — 21 tests |
| `implementation_tracker/phase_5/PHASE_5_EXECUTION_LOG.md` | Updated |

**Test results:** 21 new tests pass, 305 total tests green across 20 suites.

**Three barriers implemented:**
- **Barrier 1 (Redis SETNX):** Fast-path lock on `auth_req_lock:{tenant_id}:{app_id}` with TTL. SECURITY tier fail-closed when Redis DOWN (ADR-011 integration).
- **Barrier 2 (PG partial unique index):** `INSERT ON CONFLICT DO NOTHING` on `(tenant_id, app_id) WHERE state = 'IN_PROGRESS'`. Row persists after process crash (RT-04 amendment).
- **Barrier 3 (Worker rate guard):** `last_login_attempt_at` persisted to sessions table in PG (RT-10 amendment). Minimum 60s interval between login attempts.

**Rollback on partial failure:** If Barrier 2 or 3 fails, all previously-acquired barriers are released. Redis lock DEL + auth request EXPIRED transition.

**Stale detection:** `sweepStaleRequests()` finds IN_PROGRESS auth requests older than threshold, transitions to EXPIRED, releases Redis locks.

---

## P5-004: Global Login Coordinator (ADR-015) — COMPLETE

**Files changed:** 12 files

| File | Action |
|------|--------|
| `packages/shared/src/enums.ts` | Added LoginQueueState enum (QUEUED, RUNNING, DONE, FAILED) |
| `packages/shared/src/constants.ts` | Added GLOBAL_MAX_CONCURRENT_LOGINS (5), MAX_CONCURRENT_PER_DOMAIN (3), QUEUE_PROCESS_INTERVAL_MS, STARTUP_STAGGER_MS |
| `apps/api/src/entities/login-queue.entity.ts` | NEW — LoginQueueEntity with target_domain, priority, state lifecycle |
| `apps/api/src/entities/index.ts` | Added LoginQueueEntity export |
| `apps/api/src/migrations/1708300000004-LoginQueue.ts` | NEW — login_queue table, partial indices, PG NOTIFY trigger |
| `apps/api/src/data-source.ts` | Registered LoginQueue1708300000004 migration |
| `apps/api/src/modules/login/login-coordinator.service.ts` | NEW — Global login coordinator with queue processing |
| `apps/api/src/modules/login/login-coordinator.module.ts` | NEW — LoginCoordinatorModule |
| `apps/api/src/app.module.ts` | Imported LoginCoordinatorModule |
| `apps/api/src/modules/login/login-coordinator.spec.ts` | NEW — 34 tests |
| `implementation_tracker/phase_5/PHASE_5_EXECUTION_LOG.md` | Updated |

**Test results:** 34 new tests pass, 339 total tests green across 21 suites, 7 projects.

**Three rate limits (ADR-015):**
- **LIMIT 1 (System-wide):** Max 5 concurrent logins globally. Bounds total resource consumption.
- **LIMIT 2 (Per-domain):** Max 3 concurrent logins per target domain (RT-06 amendment). Domain normalized: `login.salesforce.com` → `salesforce.com`.
- **LIMIT 3 (Credential interval):** Min 60s between logins for same credential set (enforced by ADR-012 Barrier 3).

**Queue processing:**
- PG-backed queue (survives Redis outages per ADR-015 design)
- Event-driven via PG LISTEN/NOTIFY trigger on INSERT (RT-12 amendment, ~0ms latency)
- Fallback polling every 5s (catches missed notifications)
- Priority-first, then FIFO ordering within same domain

**Startup stagger:** 10s delay before queue processing begins, prevents thundering herd after pod restart.

**Domain normalization:** Strips auth subdomains (login., auth., sso., accounts., id., signin.) for consistent rate limiting across URL variants.

**Stale sweep:** `sweepStaleEntries()` finds RUNNING entries stuck beyond threshold, transitions to FAILED.
