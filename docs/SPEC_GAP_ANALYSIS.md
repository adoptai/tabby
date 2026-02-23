# Headless Auth Provider — Specification Gap Analysis

**Date:** 2026-02-21
**Method:** Red team review of specification, ADRs, and codebase
**Scope:** Everything in `docs/HEADLESS_AUTH_PROVIDER_SPEC.md`, `docs/ARCHITECTURE_DECISIONS.md`, and the implementing codebase

---

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| **CRITICAL** | 3 | Will cause production incidents or security breaches if not addressed |
| **HIGH** | 6 | Will cause operational failures or significant security weaknesses |
| **MEDIUM** | 5 | Best-practice gaps that compound under stress |

---

## CRITICAL Gaps

### GAP-001: Agent Authentication to the Auth Provider Is Undefined

**Category:** Specification gap
**Severity:** CRITICAL

The entire spec describes agents calling `POST /auth/request` — but **never defines how agents authenticate to our API.** This is the most fundamental security question in the system and it's completely absent.

The existing codebase has two auth mechanisms:
- **JWT** (user login with email/password, 24h TTL)
- **Service token** (client_id/client_secret → scoped JWT)

Neither is designed for the agent use case. Questions that must be answered:

| Question | Why It Matters |
|----------|---------------|
| Do agents use service tokens? | If yes, who provisions client_id/client_secret? How are they distributed? |
| One token per agent, or per org? | Per-agent = granular audit trail. Per-org = simpler provisioning. |
| What scopes/roles can agent tokens have? | An agent should be able to request credentials but NOT onboard profiles or manage users. |
| Token lifetime? | 24h JWT means agents need a token refresh flow or re-authentication daily. |
| mTLS as an option? | For machine-to-machine in Kubernetes, mTLS is often preferred over bearer tokens. |
| What if an agent token is compromised? | Revocation mechanism. Currently fails open if Redis is down (see GAP-002). |

**Impact:** Without this, the auth provider has no auth. Any HTTP client can request credentials for any tenant.

**Resolution required:** New ADR defining agent authentication mechanism.

---

### GAP-002: Redis Is a Single Point of Failure for the Entire System

**Category:** Architecture gap (specification + code)
**Severity:** CRITICAL

The spec and ADRs layer MORE Redis dependencies on top of an already Redis-heavy system. Current Redis usage:

| Use Case | Key Pattern | Failure Mode |
|----------|-------------|-------------|
| JWT blacklist (revocation) | `token:revoked:{jti}` | **FAILS OPEN** — revoked tokens work |
| Stream tokens (single-use) | `stream_token:{jti}` | Fails closed — streams blocked |
| Artifact tokens (single-use) | `artifact_token:{id}` | Fails closed — downloads blocked |
| OTP relay | `otp:{session_id}` | Fails — HITL broken |
| Idempotency (agent runs) | `idempotency:agent:*` | Fails open — duplicate runs |

New ADR-006 adds:

| Use Case | Key Pattern | Failure Mode |
|----------|-------------|-------------|
| Per-tenant rate limit | `rate:auth:{tenant}` | **?? Undefined** |
| Concurrent request counter | `concurrent:auth:{tenant}` | **?? Undefined** — counter leak = permanent rejection |
| Distributed lock (coalescing) | `auth_req_lock:{t}:{p}:{c}` | **?? Undefined** — lock loss = duplicate logins |
| Circuit breaker state | `circuit:{tenant}:{profile}` | **?? Undefined** |
| Credential cache | `cred:{tenant}:{profile}:{cred}` | **?? Undefined** |

That's **10 distinct Redis use cases**, 5 of which are new from our spec. Redis failure cascades:

```
Redis down
  ├── JWT blacklist fails open → revoked tokens reusable (SECURITY)
  ├── Rate limits fail → admission gate broken (UPSTREAM FLOOD)
  ├── Concurrent counters fail → counters never decrement (PERMANENT LOCK)
  ├── Distributed locks fail → duplicate logins (ACCOUNT LOCKOUT)
  ├── Circuit breaker state lost → broken profiles get retried (CASCADE)
  ├── Credential cache lost → all requests trigger re-login (THUNDERING HERD)
  ├── OTP relay broken → all HITL flows fail (OPERATIONAL)
  └── Stream/artifact tokens fail closed → VNC + downloads blocked
```

**The entire ADR-006 back-pressure design collapses if Redis is unavailable.** This is not an edge case — Redis restarts, failovers, and brief outages are routine in production.

**Impact:** Redis failure takes down the auth provider AND compromises security simultaneously.

**Resolution required:** New ADR defining Redis resilience strategy with explicit fail-mode decisions for every key category.

---

### GAP-003: Split-Brain During Request Coalescing Can Cause Account Lockout

**Category:** ADR-002 design flaw
**Severity:** CRITICAL

ADR-002 uses a Redis distributed lock (`SETNX`) for request coalescing. The scenario:

```
T=0   Request A acquires lock, starts login for Salesforce
T=5   Redis master fails, sentinel promotes replica
T=5   Replica does NOT have the lock (async replication lag)
T=6   Request B acquires the SAME lock on new master
T=6   TWO login flows running for the same Salesforce service account
T=7   Both attempt username/password on login.salesforce.com
T=8   Salesforce sees 2 concurrent logins → possible account lockout
```

This is the **Redlock problem** — well-documented by Martin Kleppmann. Single-instance Redis locks are not safe against failover.

Worse: even without failover, lock TTL expiry during a slow login (MFA wait) releases the lock while the first login is still in progress.

**Impact:** The exact scenario ADR-002 was designed to prevent — concurrent logins leading to account lockout.

**Resolution required:** Addendum to ADR-002 with defense-in-depth strategy that doesn't rely solely on Redis locks.

---

## HIGH Gaps

### GAP-004: No Credential Response Schema or Agent Consumption Contract

**Category:** Specification gap
**Severity:** HIGH

The spec says the API returns "cookies, headers, CSRF token" but never defines:

1. **The response envelope schema.** What exact JSON structure does the agent receive?
2. **Credential type variance.** Service A might return cookies only, Service B returns Authorization header, Service C returns CSRF + cookies. How does the agent know what it's getting and how to apply each credential type to its outbound requests?
3. **Credential usage instructions.** Cookies need to be set on a specific domain. Headers need to be sent with specific requests. CSRF tokens go in specific header names. The agent needs this metadata.
4. **Response security.** The HTTP response body contains plaintext credentials. If the agent logs the response (common in debugging), all credentials leak to log aggregators. No guidance on agent-side credential handling.

**Impact:** Agents can't reliably consume credentials without a standardized contract.

**Resolution required:** New section in spec defining the credential response schema with usage metadata.

---

### GAP-005: No Service Profile Versioning or Change Management

**Category:** Specification gap
**Severity:** HIGH

Target services change their login flows (new UI, new MFA method, new interstitial pages). The spec defines onboarding but has no mechanism for:

| Missing Capability | Consequence |
|--------------------|-------------|
| Profile versioning | Can't tell which version is in production vs staging |
| Canary deployment | New profile goes to 100% of traffic instantly — if broken, all agents fail |
| Rollback | If new profile breaks login, no automated way to revert |
| Pre-deployment validation | No gate to verify a profile works before going live |
| Change audit | No record of who changed what, when |

**Impact:** The first time Salesforce updates their login page, the profile breaks, all agents for all orgs using Salesforce lose auth simultaneously, and there's no fast rollback.

**Resolution required:** New ADR for service profile lifecycle management.

---

### GAP-006: Thundering Herd on System Startup

**Category:** Specification gap
**Severity:** HIGH

If the system restarts (cluster reboot, controller deployment, full outage recovery):

1. All worker pods are dead
2. All sessions are in unknown state
3. Controller reconcile loop detects ALL sessions need re-provisioning
4. ALL pods provisioned simultaneously
5. ALL login DSLs fire simultaneously
6. Target services see a burst of logins from one IP — rate limits, lockouts, anti-bot flags

The spec's circuit breaker (§8.2) only fires AFTER failures. It doesn't prevent the initial burst.

ADR-006's admission gate only limits per-tenant request rate, not cross-tenant system-wide login rate.

**Impact:** Full system restart → mass login storm → mass account lockouts across all target services.

**Resolution required:** Staggered startup design with login jitter and global login rate coordination.

---

### GAP-007: Credential Cache Invalidation Race Condition

**Category:** ADR-007 design flaw
**Severity:** HIGH

Scenario:

```
T=0    Worker extracts credentials, caches them. Cache TTL = 3600s.
T=1    User loads a new page in the browser session, CSRF token rotates.
T=2    Agent requests credentials, receives cached CSRF from T=0.
T=3    Agent uses CSRF token → rejected by target service (stale CSRF).
```

The 80% TTL refresh doesn't help because the credentials were stale **immediately** after extraction — not after 80% of TTL elapsed. CSRF tokens specifically rotate on navigation, not on a timer.

More broadly: **the credential cache assumes credentials are valid for `auth_ttl` seconds from extraction.** This is only true for session cookies. CSRF tokens, nonces, and some headers have much shorter effective lifetimes.

**Impact:** Agents get "fresh" credentials that are already invalid for CSRF-protected operations.

**Resolution required:** Spec addendum differentiating credential types by volatility, with per-type caching strategies.

---

### GAP-008: Worker Pod Security Hardening Incomplete

**Category:** Existing code gap
**Severity:** HIGH

The current worker pod security context is incomplete. The spec inherits these weaknesses:

| Control | Current | Required |
|---------|---------|----------|
| `readOnlyRootFilesystem` | `false` | `true` — writable rootfs allows arbitrary file creation |
| `allowPrivilegeEscalation` | not set (defaults to `true`) | `false` — must be explicit |
| `capabilities.drop` | not set | `['ALL']` — default Linux capabilities are excessive |
| `seccompProfile` | not set | `RuntimeDefault` — restrict system calls |
| Encryption key delivery | Environment variable | K8s Secret volume mount — env vars visible in `kubectl describe` |

Additionally: `TENANT_ENCRYPTION_KEY` is passed as an env var to the worker pod. This is visible to anyone with `kubectl describe pod` access. It should be mounted as a Secret volume (read-only), matching how login credentials are already mounted.

**Impact:** Container escape or lateral movement from a compromised worker is easier than it should be.

**Resolution required:** ADR or spec section defining mandatory pod security baseline.

---

### GAP-009: No Browser Crash Detection or Extraction Atomicity

**Category:** Specification + code gap
**Severity:** HIGH

The codebase has no explicit handler for Chromium process crashes. When the browser dies:

1. Playwright throws `"Target page, context or browser has been closed"`
2. Error is caught and classified generically
3. Health status becomes stale (no updates)
4. Controller eventually transitions to UNHEALTHY (after missing heartbeats)

But if the crash happens **during credential extraction**:

```
T=0  Extract cookies from browser   ✓ (in memory, plaintext)
T=1  Extract headers                ✓ (in memory, plaintext)
T=2  Chromium crashes               ╳
T=3  Encrypt bundle                 NEVER HAPPENS
T=4  Upload to MinIO                NEVER HAPPENS
T=5  Publish event                  NEVER HAPPENS
```

Result: session state says HEALTHY (last health check passed), but no credentials were ever exported. Agent requests credentials → cache miss → triggers login → but session entity says HEALTHY so no login is triggered → **deadlock**.

**Impact:** Browser crash during extraction creates an inconsistent state where the session appears healthy but has no exportable credentials.

**Resolution required:** Spec must define extraction atomicity (all-or-nothing) and a heartbeat-based health signal separate from the predicate-based signal.

---

## MEDIUM Gaps

### GAP-010: Token Blacklist Fails Open on Redis Outage

**Category:** Existing code issue
**Severity:** MEDIUM (elevated to HIGH if combined with GAP-002)

The `TokenBlacklistService` currently fails open — if Redis is unreachable during token validation, revoked tokens are accepted. Code comment says this is intentional to avoid DoS if Redis is down.

For the current PoC this was acceptable. For a production auth provider serving enterprise credentials, a revoked agent token providing access to Salesforce sessions is not acceptable.

**Resolution required:** Decision in Redis resilience ADR (GAP-002 resolution).

---

### GAP-011: AuthRequest Entity Lifecycle Not Defined

**Category:** ADR-002 gap
**Severity:** MEDIUM

ADR-002 creates an `AuthRequest` entity with states `RECEIVED → IN_PROGRESS → COMPLETED → FAILED`. But:

- **Retention:** How long are completed records kept? Indefinitely = unbounded table growth.
- **Cleanup:** When does a FAILED or IN_PROGRESS record that was never resolved get cleaned up? (Orphan records from crashed API instances.)
- **Index strategy:** Lookup by `{tenant_id, profile_id, credential_set_id, state}` needs a composite index or it's a table scan on every auth request.
- **Stale lock detection:** If the API process that created an IN_PROGRESS record crashes, the record is stuck. Other requests will coalesce onto it forever (waiting for an event that never comes).

**Resolution required:** Addendum to ADR-002 with lifecycle, TTLs, and stale record recovery.

---

### GAP-012: No Log Sanitization for Credential Material

**Category:** Existing code gap
**Severity:** MEDIUM

Error messages are logged unsanitized. If a login DSL step fails on a URL containing query parameters (e.g., OAuth callback with `code=...`), the error message includes the full URL → credentials in log output.

Additionally, email addresses (PII) are logged in plaintext in audit records.

**Resolution required:** Log sanitization middleware spec: URL redaction, PII hashing, error message scrubbing.

---

### GAP-013: No Backup/Disaster Recovery Design

**Category:** Specification gap
**Severity:** MEDIUM

The spec doesn't address data loss scenarios:

| Data Store | Lost Data | Recovery |
|-----------|-----------|----------|
| PostgreSQL | Sessions, profiles, audit trail, tenants, users | **Not defined.** CronJob backup exists in Helm chart (production) but restore procedure is undocumented. |
| Redis | Credential cache, rate limits, locks, OTP relay | **Not recoverable.** All ephemeral. System must re-derive state. Logins re-triggered. |
| MinIO | Encrypted artifact bundles | **Not defined.** Worker re-extracts on next keepalive. Brief gap where agents get cache miss. |
| NATS | In-flight events | **Tolerable.** JetStream is persistent (file storage, 24h retention). Brief message loss during outage. |

**Resolution required:** DR section in spec with RPO/RTO targets per data store.

---

### GAP-014: No Observability Specification for the Auth Request Pipeline

**Category:** Specification gap
**Severity:** MEDIUM

ADR-006 defines a 7-stage pipeline but specifies no:

- **Distributed tracing.** No mention of OpenTelemetry, trace IDs, or span propagation. The agent sends a request → it passes through admission, cache, coalescing, NATS, worker, MinIO, back to API. Without tracing, debugging a slow or failed request requires correlating logs across 5+ services manually.
- **Stage-level metrics.** No spec for latency histograms at each stage (admission, cache lookup, subscriber wait, login DSL, extraction, total).
- **Request ID propagation.** No `X-Request-Id` header specified for correlation.
- **Dashboard specification.** No definition of what operators should see.

**Resolution required:** Observability section in spec or ADR.

---

## Resolution Tracker

| Gap | Severity | Resolution | ADR | Status |
|-----|----------|-----------|-----|--------|
| GAP-001 | CRITICAL | Agent auth via OAuth 2.0 Client Credentials | ADR-010 | **ACCEPTED** |
| GAP-002 | CRITICAL | Redis HA + tiered failure modes | ADR-011 | **ACCEPTED** |
| GAP-003 | CRITICAL | Three-barrier login serialization | ADR-012 | **ACCEPTED** |
| GAP-004 | HIGH | Credential envelope with volatility model | ADR-013 | **ACCEPTED** |
| GAP-005 | HIGH | Profile versioning with canary pipeline | ADR-014 | **ACCEPTED** |
| GAP-006 | HIGH | Startup stagger + global login coordinator | ADR-012, ADR-015 | **ACCEPTED** |
| GAP-007 | HIGH | Credential volatility model (stable/semi/volatile) | ADR-013 | **ACCEPTED** |
| GAP-008 | HIGH | Mandatory pod security baseline | ADR-016 | **ACCEPTED** |
| GAP-009 | HIGH | Extraction atomicity + liveness heartbeat | ADR-017 | **ACCEPTED** |
| GAP-010 | MEDIUM | Token blacklist fail-closed in tiered model | ADR-011 | **ACCEPTED** |
| GAP-011 | MEDIUM | AuthRequest lifecycle + stale detection | ADR-012 | **ACCEPTED** |
| GAP-012 | MEDIUM | Log sanitization policy | ADR-018 | **ACCEPTED** |
| GAP-013 | MEDIUM | Backup/DR design | ADR-019 | **ACCEPTED** |
| GAP-014 | MEDIUM | Observability specification | ADR-020 | **ACCEPTED** |
