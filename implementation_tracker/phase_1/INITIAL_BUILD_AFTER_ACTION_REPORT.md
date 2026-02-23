# Initial Build After-Action Report

**Date**: 2026-02-19
**Author**: Claude Opus 4.6 (agentic session)
**Scope**: Full MVP implementation across 10 phases, 69 spec tasks
**Verdict**: ALIVE WITH CAVEATS — see honest assessment below

---

## 1. Executive Summary

The codebase compiles, tests pass, and core services start and respond to real HTTP traffic against real infrastructure (PostgreSQL, Redis). This is not a hallucinated codebase — it is a real, functional monorepo. However, **"compiles and has tests" is not "production-ready"**, and this report is brutally honest about what works, what doesn't, and what was never tested.

---

## 2. Proof of Life — What Was Actually Verified

### 2.1 Compilation (VERIFIED)
```
7 packages build successfully (0 errors):
  packages/shared    ✓ tsc
  apps/api           ✓ nest build
  apps/controller    ✓ nest build
  apps/worker        ✓ tsc
  apps/slack-bot     ✓ tsc
  apps/teams-bot     ✓ tsc
  apps/admin-ui      ✓ (stub)
```

### 2.2 Test Suite (VERIFIED — 181 tests, 10 suites, 0 failures)
```
  packages/shared     69 tests  (state machine, DSL validator, health policy engine)
  apps/api            48 tests  (auth, stream tokens, artifact pipeline, audit chain)
  apps/controller     40 tests  (all transitions, CAS locking, backoff, HITL escalation)
  apps/worker         24 tests  (DSL runner, OTP relay)
```
**Caveat**: All tests mock external dependencies. Zero tests hit a real database, Redis, NATS, MinIO, or Playwright browser.

### 2.3 Test Harness (VERIFIED — live)
```
  GET  /login             → 200 (login page with #email, #password, #login-button)
  POST /login (creds)     → 302 → /otp
  GET  /otp               → 200 (OTP page with #otp, #otp-submit)
  POST /otp (123456)      → 302 → /dashboard
  GET  /dashboard         → 200 (page with #user-menu ✓, csrf-token ✓)
  GET  /api/me            → 200 {"user_id":"admin@example.com","authenticated":true}
  GET  /logout            → 302 → /login
  GET  /api/me (no auth)  → 401 {"error":"Not authenticated"}
```
All 8 endpoints verified with curl against a live running instance.

### 2.4 NestJS API Service (VERIFIED — live against Postgres + Redis)
```
  Bootstrap:     Created tenant + admin user (bcrypt hash, UUID PKs)  ✓
  POST /login:   Returns valid JWT with sub, tenant_id, role, kid     ✓
  GET /tenants:  Returns paginated tenants with JWT auth              ✓
  GET /tenants:  Returns 401 without JWT                              ✓
  GET /metrics:  Returns Prometheus text format                       ✓
  Database:      12 tables created via TypeORM migrations             ✓
  Routes:        22 routes mapped (all controllers registered)        ✓
```

### 2.5 NestJS Controller (VERIFIED — starts)
```
  All modules initialize                                              ✓
  TypeORM connects to Postgres                                        ✓
  ScheduleModule loads (reconcile interval would fire)                ✓
  Fails only when DB unavailable (expected)                           ✓
```

---

## 3. Bugs Found and Fixed During Verification

### BUG-001: bcrypt native module not compiled (FIXED)
- **Symptom**: `Cannot find module 'bcrypt/lib/binding/napi-v3/bcrypt_lib.node'`
- **Cause**: `bcrypt` npm package requires C++ native compilation that failed silently during `pnpm install`
- **Fix**: Replaced `bcrypt` with `bcryptjs` (pure JavaScript, API-compatible)
- **Impact**: Auth service, bootstrap service, all tests
- **Status**: FIXED and verified

### BUG-002: Test harness smoke test used wrong password (FIXED)
- **Symptom**: Login returned 200 (re-rendered login page) instead of 302
- **Cause**: Test script used `admin123` but valid password is `P@ssw0rd12345`
- **Fix**: Corrected the smoke test credentials
- **Impact**: Test procedure only, not the code
- **Status**: FIXED

---

## 4. Honest Red-Team Assessment

### 4.1 What Is GENUINELY Working
| Area | Confidence | Evidence |
|------|-----------|----------|
| TypeScript compilation | HIGH | `tsc --noEmit` clean on all packages |
| Shared types/validators | HIGH | 69 real tests with real assertions |
| State machine logic | HIGH | 40 tests covering all transitions, edge cases, backoff |
| Auth (JWT + bcrypt) | HIGH | Live login returning real JWT, DB write verified |
| Database migrations | HIGH | 12 tables created on live Postgres via TypeORM |
| Bootstrap flow | HIGH | Idempotent tenant + admin creation verified |
| API routing | HIGH | 22 routes mapped, auth guards active |
| Test harness | HIGH | Full login→OTP→dashboard→logout flow verified live |

### 4.2 What COMPILES But Has Never Run Against Real Infrastructure
| Area | Confidence | Gap |
|------|-----------|-----|
| Session controller reconcile loop | MEDIUM | Logic is sound, tested with mocks. Never ran against a real K8s cluster. Pod creation calls are stubs that log but don't execute. |
| Worker login DSL runner | MEDIUM | All 15 actions mapped to correct Playwright APIs. Never ran against a real browser. The Playwright mocks in tests don't prove browser automation works. |
| Worker health predicates | MEDIUM | Logic tested with mocks. Never ran a real `fetch()` or `page.waitForSelector()`. |
| Worker artifact extraction | MEDIUM | AES-256-GCM encryption roundtrip verified in test. Never extracted from a real browser context. |
| OTP relay | MEDIUM | Redis mock works. Never tested with real Redis pub/sub timing. |
| MinIO upload/download | LOW | Code exists. Never tested against real MinIO. Presigned URL generation untested live. |
| NATS publishing | LOW | Code exists. Never connected to a real NATS server. |
| Slack bot | LOW | Code compiles. @slack/bolt never connected to real Slack API. |
| Teams bot | LOW | Code compiles. botbuilder never connected to real Teams. |
| VNC streaming | LOW | VncStreamProvider generates JWT tokens. Never tested with real noVNC/websockify. |
| Helm charts | LOW | YAML templates exist. Never deployed to a cluster. Probably has templating bugs. |
| Dockerfiles | LOW | Written per spec. Never built. Likely has path/COPY issues. |
| GitHub Actions CI | LOW | YAML exists. Never ran. |

### 4.3 What Is Definitely Missing or Broken

1. **Admin UI (apps/admin-ui)**: Complete stub. No React/Next.js code. Just a `package.json`. The spec calls for a full admin dashboard.

2. **WebSocket /events endpoint**: Spec section 11.6 requires `WS /events` for real-time event relay from NATS to UI clients. Not implemented.

3. **Worker RLS migration**: The migration creates a `worker` database role and RLS policies, but the worker's `session-db.ts` connects as `postgres` (the default). It should connect as `worker` role for RLS to take effect.

4. **Credential management**: Worker's `resolveCredentials()` reads from env vars. The spec says credentials should be loaded from K8s Secrets mounted as volumes. This is a stub.

5. **Egress proxy**: Spec requires an egress proxy (Squid or similar) for FQDN-aware domain allowlisting. Not implemented. NetworkPolicy generation writes the policy but there's no actual proxy.

6. **NATS JWT resolver**: Spec mentions dynamic NATS account provisioning with JWT resolver for per-tenant ACL enforcement. `NatsAclService` generates config objects but doesn't configure a real NATS server.

7. **Rate limiting**: `ThrottlerModule` is imported but no `@Throttle()` decorators are applied to specific routes. The spec requires different limits per endpoint.

8. **OpenTelemetry**: `ObservabilityService` is a lightweight in-memory shim. No `@opentelemetry/*` packages are installed. No real traces or OTLP export.

9. **SBOM pipeline**: `sbom.sh` script exists but `syft` and `cosign` aren't installed or tested.

10. **Artifact expiration CronJob**: Uses `@nestjs/schedule` which was installed, but the `ArtifactExpirationService` queries `artifact_bundles` with a `tenant_id` relation that may not be eagerly loaded — needs integration testing.

### 4.4 Architectural Concerns

1. **Entity duplication**: Controller copies entity files from API. Any schema change must be updated in both places. This WILL cause drift.

2. **No shared database package**: The spec doesn't call for one, but the current approach of duplicating entities across apps is fragile.

3. **In-memory stream tracking**: `VncStreamProvider` tracks active streams in a `Map`. This breaks with multiple API replicas.

4. **No graceful shutdown coordination**: The controller's reconcile loop and the cron jobs don't coordinate shutdown. An in-flight reconcile during SIGTERM could leave orphaned pods.

5. **Session state_version bigint**: TypeORM handles JavaScript `number` which loses precision above 2^53. The column is `bigint` in Postgres. This could cause CAS failures at very high version numbers (unlikely in practice but architecturally wrong).

---

## 5. Test Coverage Sanity Check

### What the 181 tests ACTUALLY test:
- **State machine transitions**: All 11 valid, 3 invalid, terminal state, backoff math, HITL escalation logic — REAL business logic testing
- **DSL validator**: All 15 actions, config validation, edge cases — REAL
- **Health policy engine**: all/any/quorum with mixed results — REAL
- **AES-256-GCM**: Encryption/decryption roundtrip, wrong key rejection, tamper detection — REAL CRYPTO
- **Audit hash chain**: Chain integrity, tamper detection, anchor computation — REAL
- **Auth service**: bcrypt hashing, JWT claims, unauthorized rejection — REAL (with mocked DB)
- **Stream token CAS**: issued→consumed lifecycle, replay rejection, fail-closed — REAL (with mocked Redis)

### What the tests DON'T test:
- Any real database query
- Any real Redis operation
- Any real Playwright browser automation
- Any real HTTP server integration (NestJS e2e)
- Any real MinIO/NATS interaction
- Any Kubernetes API call
- Any Slack/Teams API call
- Any Docker build
- Any Helm template rendering

### Test quality assessment: **HONEST B-**
The unit tests are well-structured and test real business logic. But they're all mocked. The gap between "tests pass" and "system works" is substantial. Integration tests are named "integration" but are really unit tests with mocked boundaries.

---

## 6. How to Confirm Proof of Life (For the Human)

### Level 1: Instant verification (30 seconds)
```bash
make build && make test
# Expected: 7 packages build, 181 tests pass
```

### Level 2: Live service verification (2 minutes)
```bash
# Terminal 1: Start Postgres
docker run -d --name hitl-pg -e POSTGRES_DB=browser_hitl -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine

# Terminal 2: Start API (wait 5s for DB)
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/browser_hitl"
export JWT_SIGNING_KEY="test-jwt-signing-key-at-least-32-chars-long"
export ADMIN_BOOTSTRAP_EMAIL="admin@example.com"
export ADMIN_BOOTSTRAP_PASSWORD="TestPassword123"
node apps/api/dist/main.js

# Terminal 3: Hit the API
curl -s -X POST http://localhost:8080/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"TestPassword123"}'
# Expected: {"token":"eyJ...","expires_at":"..."}
```

### Level 3: Test harness verification (1 minute)
```bash
cd test-harness && pip install -r requirements.txt
python -m uvicorn app:app --port 8000
# In another terminal:
curl -c /tmp/c.txt -X POST http://localhost:8000/login -d "email=admin@example.com&password=P@ssw0rd12345"
curl -b /tmp/c.txt -c /tmp/c.txt -X POST http://localhost:8000/otp -d "otp=123456"
curl -b /tmp/c.txt http://localhost:8000/api/me
# Expected: {"user_id":"admin@example.com","email":"admin@example.com","authenticated":true}
```

### Level 4: Full smoke test
```bash
make smoke-test
# Runs: build → test → lint
```

---

## 7. Confidence Scorecard

| Component | Compiles | Unit Tests | Integration Tested | Live Tested | Production Ready |
|-----------|----------|------------|-------------------|-------------|-----------------|
| Shared types | YES | YES (69) | N/A | N/A | YES |
| Test harness | N/A | N/A | N/A | YES | YES |
| API service | YES | YES (48) | NO | YES (partial) | NO |
| Controller | YES | YES (40) | NO | STARTS | NO |
| Worker | YES | YES (24) | NO | NO | NO |
| Slack bot | YES | NO | NO | NO | NO |
| Teams bot | YES | NO | NO | NO | NO |
| Admin UI | STUB | NO | NO | NO | NO |
| Helm charts | N/A | NO | NO | NO | NO |
| Dockerfiles | N/A | NO | NO | NO | NO |
| CI pipeline | N/A | NO | NO | NO | NO |

---

## 8. What "Phase 2" of Development Should Focus On

1. **Integration tests with real infrastructure** (Postgres, Redis, NATS, MinIO via docker-compose)
2. **Docker image builds** — get the Dockerfiles actually building
3. **Worker end-to-end** — run login DSL against the test harness with real Playwright
4. **Helm chart deployment** — deploy to a local k3d cluster
5. **WebSocket /events endpoint** — missing from spec compliance
6. **Admin UI** — currently a complete stub
7. **Rate limiting decorators** — ThrottlerModule imported but not applied
8. **Entity deduplication** — shared database package to eliminate controller/API entity drift

---

## 9. Final Honest Assessment

**Is this a hallucination?** No. The code compiles, the tests run real assertions with real logic, and the API starts, connects to Postgres, runs migrations, creates tables, bootstraps data, and responds to authenticated HTTP requests with valid JWTs.

**Is this production-ready?** Absolutely not. This is a well-structured MVP scaffold with solid business logic in the shared/controller layers, but it has never been deployed, the Dockerfiles have never been built, the Helm charts have never been rendered, and most integrations (NATS, MinIO, Playwright, Slack, Teams) are code that compiles but has never executed against real services.

**Is this a good foundation?** Yes. The architecture is sound, the state machines are correct, the security primitives (CAS locking, hash chains, encryption) are implemented correctly at the unit level, and the code follows the spec faithfully. The gap to production is integration testing and deployment — not fundamental design flaws.

**Biggest risk?** The worker. It's the most complex component (browser automation, Xvfb, VNC, artifact extraction) and has zero live testing. The DSL runner could have subtle Playwright API mismatches that only surface at runtime.

---

*This report was generated after real verification against live services, not from memory or assumption. Every claim marked VERIFIED was tested during this session with curl against running processes.*
