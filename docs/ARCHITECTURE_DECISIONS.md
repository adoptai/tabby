# Architecture Decision Records

This document tracks all major design decisions for the Browser HITL project. Each record captures the context, options considered, decision rationale, and consequences. Future agents and developers should read this before proposing changes that contradict established decisions.

**Format:** Lightweight ADR (Architecture Decision Record), one section per decision.
**Status values:** `PROPOSED` → `ACCEPTED` → `SUPERSEDED` | `DEPRECATED`

---

## Index

| ID | Title | Status | Date | Impact |
|----|-------|--------|------|--------|
| [ADR-001](#adr-001-service-account-model-for-auth-sessions) | Service account model for auth sessions | ACCEPTED | 2026-02-21 | HIGH |
| [ADR-002](#adr-002-request-coalescing-for-concurrent-auth-requests) | Request coalescing for concurrent auth requests | ACCEPTED | 2026-02-21 | CRITICAL |
| [ADR-003](#adr-003-egress-allowlist-completeness-and-correctness) | Egress allowlist completeness and correctness | ACCEPTED | 2026-02-21 | HIGH |
| [ADR-004](#adr-004-anti-bot-detection-resilience-and-service-health-monitoring) | Anti-bot detection resilience and service health monitoring | ACCEPTED | 2026-02-21 | HIGH |
| [ADR-005](#adr-005-conditional-dsl-steps-with-recovery-semantics) | Conditional DSL steps with recovery semantics | ACCEPTED | 2026-02-21 | HIGH |
| [ADR-006](#adr-006-synchronous-pull-with-back-pressure-management) | Synchronous pull with back-pressure management | ACCEPTED | 2026-02-21 | CRITICAL |
| [ADR-007](#adr-007-proactive-credential-refresh-at-80-ttl-default) | Proactive credential refresh at 80% TTL (default) | ACCEPTED | 2026-02-21 | MEDIUM |
| [ADR-008](#adr-008-namespace-per-org-as-default-isolation-tier) | Namespace-per-org as default isolation tier | ACCEPTED | 2026-02-21 | HIGH |
| [ADR-009](#adr-009-api-only-for-v1-secret-store-push-critical-for-v2) | API-only for v1; secret store push critical for v2 | ACCEPTED | 2026-02-21 | HIGH |
| [ADR-010](#adr-010-agent-authentication-via-oauth-20-client-credentials) | Agent authentication via OAuth 2.0 Client Credentials | ACCEPTED | 2026-02-21 | CRITICAL |
| [ADR-011](#adr-011-redis-resilience-and-tiered-failure-modes) | Redis resilience and tiered failure modes | ACCEPTED | 2026-02-21 | CRITICAL |
| [ADR-012](#adr-012-defense-in-depth-for-login-serialization) | Defense-in-depth for login serialization | ACCEPTED | 2026-02-21 | CRITICAL |
| [ADR-013](#adr-013-credential-response-envelope-and-volatility-model) | Credential response envelope and volatility model | ACCEPTED | 2026-02-21 | HIGH |
| [ADR-014](#adr-014-service-profile-versioning-and-safe-deployment) | Service profile versioning and safe deployment | ACCEPTED | 2026-02-21 | HIGH |
| [ADR-015](#adr-015-startup-storm-prevention-and-global-login-coordination) | Startup storm prevention and global login coordination | ACCEPTED | 2026-02-21 | HIGH |
| [ADR-016](#adr-016-worker-pod-security-baseline) | Worker pod security baseline | ACCEPTED | 2026-02-21 | HIGH |
| [ADR-017](#adr-017-extraction-atomicity-and-session-liveness) | Extraction atomicity and session liveness | ACCEPTED | 2026-02-21 | HIGH |
| [ADR-018](#adr-018-log-sanitization-policy) | Log sanitization policy | ACCEPTED | 2026-02-21 | MEDIUM |
| [ADR-019](#adr-019-backup-and-disaster-recovery-design) | Backup and disaster recovery design | ACCEPTED | 2026-02-21 | MEDIUM |
| [ADR-020](#adr-020-observability-specification) | Observability specification | ACCEPTED | 2026-02-21 | MEDIUM |
| [ADR-021](#adr-021-dual-mode-browser-streaming-vnc-and-cdp) | Dual-mode browser streaming (VNC and CDP) | ACCEPTED | 2026-02-22 | HIGH |

---

## ADR-001: Service Account Model for Auth Sessions

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture, Product Owner

### Context

The Headless Auth Provider maintains persistent browser sessions for target services (Salesforce, Siebel, etc.). A fundamental question is the identity model: does each browser session authenticate as a shared service account, or as individual end-users?

### Options Considered

| Option | Description | Containers per Service per Org | Pros | Cons |
|--------|-------------|-------------------------------|------|------|
| **(A) Service account** | One browser session per service account per org. All agents in the org share credentials from the same session. | 1 (or few, if multiple service accounts) | Predictable resource usage; simple provisioning; matches enterprise integration patterns | All agents share one identity; per-user audit requires app-level tracking |
| **(B) Per-user** | One browser session per end-user per service per org. Each user gets their own isolated session. | N (one per user) | True per-user authorization; session isolation per user | Container count = users × services; cost explosion; credential management per user |

### Decision

**(A) Service account model.**

### Rationale

1. **Enterprise integration norms.** Most enterprise web-to-API integrations use service accounts or integration users, not end-user credentials. Salesforce, ServiceNow, SAP all support this pattern.
2. **Scalability.** One container per service per org scales linearly with services, not users. An org with 500 users and 5 services needs 5 containers, not 2,500.
3. **Credential management.** Service account credentials are managed by IT admins and stored in K8s Secrets. Per-user credentials would require a credential vault with user-facing UX — a different product.
4. **Future extensibility.** Per-user sessions can be added later as a service profile option (`identity_model: "per_user"`) without changing the core architecture.

### Consequences

- Agent requests do not carry end-user identity — the auth provider serves credentials for the service account.
- Per-user audit trail requires the consuming agent to log which end-user triggered the action.
- If a target service requires per-user auth (rare for API integrations), this model doesn't apply — flagged as a future extension.

---

## ADR-002: Request Coalescing for Concurrent Auth Requests

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture, Product Owner

### Context

Multiple agents may simultaneously request authentication for the same service profile and credential set. Without coordination, each request could trigger a separate login flow, leading to:

1. **Account lockout** on the target service (repeated login attempts)
2. **Resource waste** (multiple browser sessions for the same credential)
3. **Race conditions** (multiple sessions extracting credentials simultaneously, last-write-wins corruption)

This was identified as a **CRITICAL** concern by the product owner.

### Options Considered

| Option | Description | Complexity |
|--------|-------------|------------|
| **(A) No coalescing** | Each auth request triggers its own login flow | Low — but dangerous |
| **(B) Mutex with queue** | First request acquires lock, subsequent requests wait on lock release | Medium |
| **(C) Request coalescing with subscription** | First request creates an "auth_request" record; subsequent requests subscribe to its completion event | Medium-High |
| **(D) Dedicated auth request entity with state machine** | Full entity tracking auth request lifecycle: RECEIVED → IN_PROGRESS → COMPLETED/FAILED. Concurrent requests join the in-progress request. | High |

### Decision

**(D) Dedicated auth request entity with state machine.** The stakes are too high for a simpler approach.

### Design

```
AuthRequest Entity:
  id: UUID
  tenant_id: UUID
  profile_id: UUID (service profile)
  credential_set_id: UUID
  state: RECEIVED | IN_PROGRESS | COMPLETED | FAILED
  created_at: timestamptz
  completed_at: timestamptz (nullable)
  artifact_bundle_id: UUID (nullable, set on COMPLETED)
  failure_reason: text (nullable, set on FAILED)
  subscriber_count: integer (how many agents are waiting)
  lock_key: string (Redis distributed lock)
```

**Coalescing logic (pseudocode):**

```
on POST /auth/request {profile_id, credential_set_id}:

  1. CHECK credential cache
     → if FRESH: return cached credentials immediately (no auth_request created)

  2. ACQUIRE Redis lock: `auth_request_lock:{tenant}:{profile}:{cred_set}`
     → if lock acquired:
         a. CREATE AuthRequest(state=IN_PROGRESS)
         b. TRIGGER login flow
         c. On completion: SET state=COMPLETED, cache credentials, RELEASE lock
         d. PUBLISH NATS: auth.request.completed.{tenant}.{profile}
         e. Return credentials to this request

     → if lock NOT acquired (another request in progress):
         a. FIND existing IN_PROGRESS AuthRequest for this profile+cred_set
         b. INCREMENT subscriber_count
         c. SUBSCRIBE to NATS: auth.request.completed.{tenant}.{profile}
         d. WAIT (with timeout = login_timeout_ms + grace)
         e. On event received: return credentials from completed AuthRequest
         f. On timeout: return 504 Gateway Timeout
```

### Rationale

1. **Account lockout prevention** is a hard requirement. Parallel logins to the same service account can trigger lockouts on the target service (often 3-5 attempts within a window).
2. **Auditability.** The AuthRequest entity provides a complete trace of who requested what, when, and how many agents were served from a single login.
3. **Failure propagation.** If the login fails, all waiting subscribers receive the failure — they don't independently retry (which would compound the lockout risk). Retry policy is centralized.
4. **Metrics.** `subscriber_count` directly measures demand. High subscriber counts for a profile indicate the proactive refresh threshold should be lowered.

### Consequences

- New entity: `auth_requests` table (12th table, if we count it as operational state).
- Redis distributed lock required for correctness.
- NATS subscription pattern for completion notification.
- API layer must handle the "wait for in-progress request" pattern (long-poll or SSE).

### Risks

- **Lock contention under extreme load.** Mitigated by short lock TTL (= login_timeout_ms) and automatic release.
- **Subscriber starvation if login hangs.** Mitigated by timeout on the subscriber wait + maximum login duration.

---

## ADR-003: Egress Allowlist Completeness and Correctness

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture, Product Owner

### Context

Worker pods operate under deny-all-egress NetworkPolicies. The egress allowlist explicitly enumerates which domains the browser may reach. An incomplete allowlist causes silent login failures mid-redirect — the browser navigates to the corporate IdP, the NetworkPolicy blocks it, and the login DSL times out with no clear error.

This was flagged as requiring **COMPLETE correctness and hygiene**.

### Decision

Implement a multi-layer egress validation system.

### Design

#### Layer 1: Static Allowlist (Service Profile Config)

Defined during onboarding reconnaissance (§6.2 of the spec). Must include ALL domains in the SSO federation chain.

```json
{
  "egress_domains": [
    "login.salesforce.com",
    "*.salesforce.com",
    "*.force.com",
    "*.lightning.force.com",
    "login.microsoftonline.com",
    "*.okta.com",
    "corporate-idp.acme.com"
  ]
}
```

#### Layer 2: Discovery Mode (Onboarding Only)

During onboarding validation (§6.5), run the login flow in **discovery mode**:

1. Worker pod runs with permissive egress (allow-all, staging only)
2. Login DSL executes against the real target
3. All outbound DNS queries and HTTP requests are logged
4. Output: discovered domain list
5. Compare discovered domains against static allowlist
6. Flag any domains reached that are NOT in the allowlist → onboarding fails until resolved

**Implementation:** Sidecar container running a DNS/HTTP request logger (e.g., `tcpdump` filtered to DNS + HTTP CONNECT). Alternatively, instrument the egress proxy to log all CONNECT requests.

#### Layer 3: Runtime Egress Monitoring

In production, the egress proxy logs all CONNECT requests. If a worker attempts to reach a domain NOT in the allowlist:

1. Request is blocked (deny by default)
2. Event published: `egress.blocked.{tenantId}.{sessionId}.{domain}`
3. Alert generated if blocked count exceeds threshold
4. Dashboard shows blocked domains per profile — indicates allowlist may need updating

#### Layer 4: Allowlist Review Process

| Trigger | Action |
|---------|--------|
| Service profile creation | Mandatory: run discovery mode; diff against static allowlist |
| Target service login flow changes | Periodic: re-run discovery mode quarterly or on login failure spike |
| Blocked egress event spike | Reactive: investigate blocked domains; update allowlist if legitimate |
| SSO provider change | Manual: admin updates egress domains when corporate IdP changes |

### Rationale

1. **Silent failures are the worst failures.** A blocked egress request causes a timeout, not an error. The login DSL doesn't know the request was blocked — it just waits for a page load that never completes.
2. **SSO chains are unpredictable.** Corporate IdPs may redirect through multiple intermediaries. Discovery mode catches domains that the admin didn't anticipate.
3. **Runtime monitoring closes the feedback loop.** Even with careful onboarding, domains change. CDNs rotate. IdPs add new endpoints.

### Consequences

- Onboarding workflow requires a "discovery mode" step before production deployment.
- Egress proxy must support request logging (already exists: HMAC-authenticated proxy with logging).
- New NATS event type: `egress.blocked.*`.
- New alert rule: egress blocked count threshold.

---

## ADR-004: Anti-Bot Detection Resilience and Service Health Monitoring

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture, Product Owner

### Context

This system automates browser-based authentication to enterprise web applications. While the use cases are legitimate and authorized, the behavioral patterns (headless browser, automated form filling, repeated logins) are indistinguishable from malicious credential-stuffing or scraping workflows from the target service's perspective.

Enterprise services increasingly deploy anti-bot countermeasures:
- CAPTCHA (reCAPTCHA, hCaptcha, Cloudflare Turnstile)
- Device fingerprinting (canvas, WebGL, audio context)
- Behavioral analysis (typing speed, mouse movement patterns)
- Browser environment detection (headless markers, navigator.webdriver)
- IP reputation scoring

This was identified as a significant concern: **the legitimate use cases look similar to bad-actor workflows.**

### Decision

Implement a three-tier defense strategy: Evasion, Detection, and Escalation. Add a formal **Service Health** dimension that specifically tracks anti-bot friction.

### Design

#### Tier 1: Evasion (Reduce Detection Surface)

Browser hardening flags already in the worker pod, plus additional stealth measures:

| Measure | Implementation | Purpose |
|---------|---------------|---------|
| Remove `navigator.webdriver` | `--disable-blink-features=AutomationControlled` | Prevents basic headless detection |
| Realistic user-agent | Match current stable Chrome version string | Avoid user-agent blocklists |
| Human-like timing | Add configurable jitter to DSL step delays (50-200ms random between keystrokes) | Defeat behavioral analysis of typing speed |
| Mouse movement simulation | Generate realistic bezier-curve mouse paths before click actions | Defeat mouse-movement heuristics |
| Canvas/WebGL fingerprint | Use consistent (not randomized) canvas fingerprint per session | Randomized fingerprints are a detection signal |
| Viewport and screen size | Set realistic 1920x1080 viewport | Headless defaults (800x600) are a signal |
| Timezone consistency | Set `TZ` env var to match the org's locale | Timezone mismatch vs IP geolocation is a signal |
| WebRTC leak prevention | Disable WebRTC or route through proxy | Prevent real IP leakage that contradicts proxy IP |

#### Tier 2: Detection (Monitor Anti-Bot Friction)

New health dimension: **Service Anti-Bot Health Score.**

```
Service Health Indicators:
  ├── auth_health: Can we log in? (existing health predicates)
  ├── session_health: Is the session alive? (existing keepalive)
  └── friction_health: Is the service increasing anti-bot friction? (NEW)
```

**Friction health signals:**

| Signal | Detection | Score Impact |
|--------|-----------|-------------|
| CAPTCHA presented during login | Login DSL encounters unknown element matching CAPTCHA patterns (iframe with known CAPTCHA provider domains) | -30 |
| Login takes significantly longer than baseline | `login_duration_ms > 2× baseline_p95` | -10 |
| Additional verification steps appear | New pages/steps not in the login DSL | -20 |
| IP-based rate limit (HTTP 429) | Response status 429 from target service | -40 |
| Account temporarily locked | Specific error message patterns on login page | -50 (critical) |
| Device verification email/SMS sent | New page asking to verify device | -25 |
| Forced password change | Redirect to password-change page | -30 |

**Friction score** (0-100, 100 = no friction):
- Starts at 100 on successful login
- Decremented by friction signals
- Decays back toward 100 over time (friction events are weighted by recency)
- Thresholds: `>80` = GREEN, `50-80` = YELLOW, `<50` = RED

**Actions by threshold:**

| Threshold | Action |
|-----------|--------|
| GREEN (>80) | Normal operation |
| YELLOW (50-80) | Increase timing jitter; alert platform admin; log friction events |
| RED (<50) | Pause automated login; HITL-only mode; alert for service profile review |

#### Tier 3: Escalation (Human Fallback)

When anti-bot measures block automation:

1. **CAPTCHA detected** → HITL escalation. Human operator solves CAPTCHA via VNC stream. This is the existing baton system.
2. **Device verification** → HITL escalation. Human clicks verification link from email/SMS.
3. **Persistent RED friction score** → Service profile flagged for review. May need:
   - Different login flow (OAuth app-to-app instead of browser-based)
   - Whitelisting from the target service provider (authorized integration)
   - Dedicated IP address for the org (not shared proxy)

### Rationale

1. **Legitimate doesn't mean invisible.** Our automation is authorized, but the target service doesn't know that. We must minimize our detection surface.
2. **Friction is a leading indicator.** If CAPTCHAs start appearing where they didn't before, the service is increasing scrutiny. Detecting this early prevents sudden breakage.
3. **HITL is the safety net, not the primary path.** The goal is autonomous operation. HITL is for exceptions. If HITL is triggered frequently, the evasion strategy needs improvement.
4. **Per-service tuning is essential.** Salesforce's anti-bot is different from ServiceNow's. Stealth measures must be configurable per service profile.

### Consequences

- New config section in service profile: `stealth_config` (timing jitter, mouse simulation, viewport, timezone).
- New metric: `friction_health_score` per service profile per org.
- New alert: `friction_health_score < 50` → platform admin notification.
- CAPTCHA detection logic in login DSL runner (pattern matching on known CAPTCHA provider iframes/scripts).
- Potential future: partner with target service providers for authorized integration whitelisting.

---

## ADR-005: Conditional DSL Steps with Recovery Semantics

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture, Product Owner

### Context

Login flows are not deterministic. The same service may present different pages depending on:
- Whether MFA is required (trusted device, recent auth)
- Whether the session is partially authenticated (SSO cookie present)
- Whether the service presents interstitial pages (terms acceptance, announcements)
- Whether anti-bot challenges appear (CAPTCHA, device verification)

The current Login DSL executes steps sequentially with no branching. A step either succeeds or fails. This breaks on non-deterministic flows: a `fill #otp-input` step fails if the MFA page doesn't appear, which fails the entire login even though no MFA was needed.

### Options Considered

| Option | Description | Complexity |
|--------|-------------|------------|
| **(A) Conditional field on steps** | Add `conditional: "element_visible"` to skip steps when the target element isn't present | Low |
| **(B) Separate MFA DSL section** | Split login_dsl into `login_steps` and `mfa_steps` with auto-detection | Medium |
| **(C) State-machine DSL** | Steps define transitions between page states; runner detects current page and branches | High |
| **(D) Conditional + recovery blocks** | (A) plus named recovery sequences triggered on specific failure patterns | Medium |

### Decision

**(D) Conditional steps with recovery blocks.** Conditional steps handle the common case (MFA may/may not appear). Recovery blocks handle unexpected states (CAPTCHA, password change prompt, unknown page).

### Design

#### Conditional Steps

New fields on `BaseDslStep`:

```typescript
interface BaseDslStep {
  action: DslActionType;
  timeout_ms?: number;
  retry_count?: number;
  sensitive?: boolean;

  // NEW: Conditional execution
  conditional?: ConditionalType;
  // NEW: Step label for logging and recovery references
  label?: string;
}

type ConditionalType =
  | 'element_visible'    // Execute only if selector is visible in DOM
  | 'element_absent'     // Execute only if selector is NOT in DOM
  | 'url_matches'        // Execute only if current URL matches pattern
  | 'url_not_matches'    // Execute only if current URL does NOT match pattern
  | 'always';            // Default: always execute
```

**Evaluation semantics:**
- `element_visible`: Check if `selector` is visible (not hidden, not zero-size). Timeout for visibility check = 3 seconds (fast fail, not step timeout). If not visible → skip step (no error).
- `element_absent`: Inverse of `element_visible`. Used for "if we're NOT on the expected page" scenarios.
- `url_matches` / `url_not_matches`: Match against `conditional_pattern` (glob). Used for redirect detection.

#### Recovery Blocks

New top-level section in login config:

```json
{
  "login_config": {
    "dsl_steps": [ "/* main login flow */" ],

    "recovery_blocks": [
      {
        "name": "captcha_recovery",
        "trigger": {
          "type": "element_detected",
          "selectors": [
            "iframe[src*='recaptcha']",
            "iframe[src*='hcaptcha']",
            "#captcha-container",
            "[data-callback='onCaptchaSuccess']"
          ]
        },
        "action": "hitl_escalate",
        "message": "CAPTCHA detected on {profile_name}. Human intervention required.",
        "timeout_ms": 300000
      },
      {
        "name": "password_change_recovery",
        "trigger": {
          "type": "url_matches",
          "pattern": "**/change-password**"
        },
        "action": "abort",
        "failure_reason": "password_change_required",
        "alert": true
      },
      {
        "name": "device_verification_recovery",
        "trigger": {
          "type": "element_detected",
          "selectors": ["#device-verification", ".verify-identity"]
        },
        "action": "hitl_escalate",
        "message": "Device verification required for {profile_name}.",
        "timeout_ms": 600000
      },
      {
        "name": "unknown_page_recovery",
        "trigger": {
          "type": "timeout",
          "after_step": "any"
        },
        "action": "screenshot_and_abort",
        "failure_reason": "unexpected_page_state",
        "alert": true
      }
    ]
  }
}
```

**Recovery block evaluation:**

After each DSL step AND on step failure, the runner checks all recovery block triggers:

```
for each step in dsl_steps:
  evaluate conditional → skip if not met
  execute step
  if step FAILS:
    check recovery_blocks for matching trigger
    → if match: execute recovery action (hitl_escalate, abort, screenshot_and_abort)
    → if no match: standard failure handling (retry, then fail)
  if step SUCCEEDS:
    check recovery_blocks with type "element_detected" (proactive scan)
    → if match: pause main flow, execute recovery action
```

#### Recovery Actions

| Action | Behavior |
|--------|----------|
| `hitl_escalate` | Pause login DSL. Set baton to HUMAN_REQUESTED. Publish HITL event. Wait for human to resolve + release baton. Resume DSL from current step. |
| `abort` | Fail the login immediately. Set session to FAILED. Publish failure event with `failure_reason`. |
| `screenshot_and_abort` | Take screenshot of current page (for debugging). Then abort. Screenshot stored as artifact (not credential — no encryption needed, but not logged). |
| `retry_from_start` | Restart the entire login DSL from step 0. Used for recoverable errors. Max 1 retry. |

### Rationale

1. **Non-deterministic flows are the norm, not the exception.** Every enterprise SSO flow has conditional branches (MFA, consent screens, announcements). A linear DSL can't handle this.
2. **Recovery blocks separate concerns.** The main DSL describes the happy path. Recovery blocks describe what to do when the happy path breaks. This keeps the DSL readable.
3. **CAPTCHA detection must be proactive, not reactive.** We shouldn't wait for a step to timeout to discover a CAPTCHA appeared. The recovery block scanner checks after every step.
4. **Screenshot on unknown state is essential for debugging.** When a service changes its login flow, the screenshot shows exactly what the browser is seeing.

### Consequences

- Extend `BaseDslStep` with `conditional`, `conditional_pattern`, and `label` fields.
- New `recovery_blocks` section in login config schema.
- Login DSL runner must implement recovery block evaluation loop.
- Service profile onboarding must define relevant recovery blocks (CAPTCHA, password change, device verification at minimum).
- Screenshot storage for debugging (separate from credential artifacts, shorter retention).

---

## ADR-006: Synchronous Pull with Back-Pressure Management

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture, Product Owner

### Context

How do agents receive authentication credentials from the Headless Auth Provider? The synchronous pull model (`POST /auth/request` → block → receive credentials) is the simplest for agent developers, but naive blocking without back-pressure management creates cascading failure risk:

- **Upstream:** If many agents block simultaneously waiting for a slow login, the API server exhausts its connection pool, starving health checks and other requests.
- **Downstream:** If the login flow fails, all blocked callers receive errors simultaneously and may retry in a thundering herd.

The product owner's requirement: **"yes, as long as it is sensibly orchestrated and there's no critical back pressure / failures UPSTREAM or DOWNSTREAM... essential the behaviour is rigorously designed from a sequence and signalling perspective."**

### Decision

**Synchronous pull with explicit back-pressure management at every layer.** Not "just block and wait" but a structured pipeline with admission control, load shedding, signalling, and graceful degradation.

### Design: The Full Request Pipeline

Every auth request passes through 7 stages. Each stage has explicit capacity limits, failure modes, and signals.

```
Agent                                      Auth Provider API
  │                                              │
  │  POST /auth/request                          │
  │─────────────────────────────────────────────→│
  │                                              │
  │                          ┌───────────────────┤
  │                          │ STAGE 1: Admission │
  │                          │ Gate               │
  │                          │                    │
  │                          │ • Rate limit check │
  │                          │ • Tenant quota     │
  │                          │ • Circuit breaker  │
  │                          │   state check      │
  │                          │                    │
  │                          │ REJECT → 429 / 503 │
  │                          └────────┬───────────┘
  │                                   │ ADMIT
  │                          ┌────────┴───────────┐
  │                          │ STAGE 2: Cache      │
  │                          │ Lookup              │
  │                          │                     │
  │                          │ Redis GET            │
  │                          │ key: {tenant}:       │
  │                          │   {profile}:{cred}   │
  │                          │                     │
  │                          │ HIT (fresh) → 200   │
  │                          └────────┬────────────┘
  │                                   │ MISS or STALE
  │                          ┌────────┴────────────┐
  │                          │ STAGE 3: Coalescing  │
  │                          │ Check                │
  │                          │                      │
  │                          │ Redis SETNX lock:    │
  │                          │  auth_req:{t}:{p}:{c}│
  │                          │                      │
  │                          │ LOCKED (in-progress) │
  │                          │  → go to STAGE 4     │
  │                          │ ACQUIRED (first req) │
  │                          │  → go to STAGE 5     │
  │                          └────────┬─────────────┘
  │                                   │
  │   ┌───────────────────────────────┼───────────────────────────┐
  │   │ STAGE 4: Subscriber Wait      │ STAGE 5: Login Trigger    │
  │   │ (for coalesced requests)       │ (for first request)       │
  │   │                                │                           │
  │   │ Subscribe to NATS:             │ Create AuthRequest entity │
  │   │  auth.completed.{t}.{p}        │ state = IN_PROGRESS       │
  │   │                                │                           │
  │   │ Wait with timeout:             │ Signal Controller/Worker  │
  │   │  login_timeout_ms + 10s grace  │ via NATS                  │
  │   │                                │                           │
  │   │ Increment subscriber_count     │ Worker executes login DSL │
  │   │ on AuthRequest entity          │                           │
  │   └──────────────┬─────────────────┴─────────────┬─────────────┘
  │                  │                                │
  │                  │         ┌───────────────────────┘
  │                  │         │
  │                  │ ┌───────┴───────────┐
  │                  │ │ STAGE 6: Result    │
  │                  │ │ Resolution         │
  │                  │ │                    │
  │                  │ │ Login SUCCEEDED:   │
  │                  │ │  • Cache creds     │
  │                  │ │  • Publish NATS:   │
  │                  │ │    auth.completed  │
  │                  │ │  • Release lock    │
  │                  │ │  • Update entity:  │
  │                  │ │    COMPLETED       │
  │                  │ │                    │
  │                  │ │ Login FAILED:      │
  │                  │ │  • Publish NATS:   │
  │                  │ │    auth.failed     │
  │                  │ │  • Release lock    │
  │                  │ │  • Update entity:  │
  │                  │ │    FAILED          │
  │                  │ │  • Update circuit  │
  │                  │ │    breaker         │
  │                  │ └───────┬────────────┘
  │                  │         │
  │                  └────┬────┘
  │                       │
  │              ┌────────┴────────┐
  │              │ STAGE 7: Response│
  │              │ Delivery         │
  │              │                  │
  │              │ SUCCESS:         │
  │              │  200 {creds}     │
  │              │                  │
  │              │ FAILURE:         │
  │              │  see table below │
  │              └─────────────────┘
  │                       │
  │←──────────────────────┘
```

#### Stage 1: Admission Gate (Upstream Back-Pressure)

The admission gate prevents overload **before** any work is done. Every request must pass all three checks:

```
┌─────────────────────────────────────────────────────────────┐
│                     ADMISSION GATE                           │
│                                                              │
│  CHECK 1: Per-tenant rate limit                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ Token bucket: 30 requests/minute per tenant          │     │
│  │ Redis key: rate:auth:{tenant_id}                     │     │
│  │ REJECT: 429 Too Many Requests                        │     │
│  │ Headers: Retry-After: {seconds}, X-RateLimit-*       │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
│  CHECK 2: Concurrent request limit                           │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ Max concurrent blocked requests per tenant: 50       │     │
│  │ Redis INCR: concurrent:auth:{tenant_id}              │     │
│  │ DECR on response (finally block)                     │     │
│  │ REJECT: 503 Service Unavailable                      │     │
│  │ Body: {reason: "concurrent_limit_exceeded",          │     │
│  │        current: 50, limit: 50}                       │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
│  CHECK 3: Circuit breaker state                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ Per-profile circuit breaker (see ADR-002)            │     │
│  │ If OPEN: reject immediately                          │     │
│  │ REJECT: 503 Service Unavailable                      │     │
│  │ Body: {reason: "circuit_breaker_open",               │     │
│  │        profile_id: "...",                            │     │
│  │        retry_after: {cooldown_remaining_seconds}}     │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
│  ALL PASS → request admitted to pipeline                     │
└─────────────────────────────────────────────────────────────┘
```

**Why three checks:**
1. **Rate limit** prevents a misbehaving agent from flooding the system (regardless of cache state).
2. **Concurrent limit** prevents connection pool exhaustion. 50 blocked connections × ~90s max = bounded resource consumption.
3. **Circuit breaker** prevents queuing requests for a profile that is known-broken. Fail fast, inform the agent.

#### Stage 4: Subscriber Wait (Detailed Signalling)

When a request coalesces onto an in-progress login, it must wait. The wait is NOT a blind sleep — it subscribes to a NATS completion event with explicit timeout and cancellation semantics.

```typescript
// Pseudocode — subscriber wait logic

async function waitForInProgressAuth(
  tenantId: string,
  profileId: string,
  credSetId: string,
  timeoutMs: number,
): Promise<AuthResult> {
  const subject = `auth.completed.${tenantId}.${profileId}.${credSetId}`;
  const failSubject = `auth.failed.${tenantId}.${profileId}.${credSetId}`;

  // Subscribe to both success and failure events
  const subscription = nats.subscribe(subject);
  const failSubscription = nats.subscribe(failSubject);

  // Create a timeout promise
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new GatewayTimeoutError()), timeoutMs)
  );

  // Create a circuit-breaker-opened promise (early exit if profile breaks)
  const circuitWatch = watchCircuitBreaker(tenantId, profileId);

  try {
    const result = await Promise.race([
      // SUCCESS path: credentials published
      (async () => {
        for await (const msg of subscription) {
          return { status: 'success', credentials: JSON.parse(msg.data) };
        }
      })(),
      // FAILURE path: login failed
      (async () => {
        for await (const msg of failSubscription) {
          const failure = JSON.parse(msg.data);
          return { status: 'failed', reason: failure.reason };
        }
      })(),
      // TIMEOUT path: nothing happened in time
      timeout,
      // CIRCUIT BREAK path: profile broke while we were waiting
      circuitWatch,
    ]);

    return result;
  } finally {
    subscription.unsubscribe();
    failSubscription.unsubscribe();
    // CRITICAL: decrement concurrent request counter
    await redis.decr(`concurrent:auth:${tenantId}`);
  }
}
```

**Key properties:**
- **No polling.** NATS subscription is push-based. Zero wasted cycles.
- **Three exit paths besides success:** failure event, timeout, circuit breaker opened. Every path produces a specific, actionable error for the agent.
- **Resource cleanup is guaranteed** via `finally` block. The concurrent counter is always decremented — no counter leak on error paths.

#### Response Contract

Every response includes enough information for the agent to decide what to do next:

| HTTP Status | Condition | Response Body | Agent Action |
|-------------|-----------|---------------|-------------|
| `200` | Credentials available | `{credentials: {...}, freshness: "cached"\|"extracted"\|"degraded", extracted_at, expires_at, session_id}` | Use credentials |
| `202` | Login in progress, MFA pending (HITL escalated) | `{status: "awaiting_human", request_id, estimated_wait_seconds, stream_url}` | Wait and retry, or notify user |
| `429` | Rate limit exceeded | `{error: "rate_limit_exceeded", retry_after_seconds}` | Back off, retry after delay |
| `503` (concurrent) | Too many concurrent requests | `{error: "concurrent_limit_exceeded", current, limit}` | Back off with jitter, retry |
| `503` (circuit) | Circuit breaker open | `{error: "circuit_breaker_open", profile_id, retry_after_seconds, last_failure_reason}` | Do not retry until retry_after. Alert user if persistent. |
| `503` (session) | No healthy session, login not possible | `{error: "session_unavailable", profile_id, session_state, recovery_eta_seconds}` | Wait for recovery_eta, retry |
| `504` | Login timed out (subscriber wait expired) | `{error: "login_timeout", profile_id, timeout_ms, suggestion: "check service health"}` | Retry once. If repeated → alert. |

**Design principle:** Every non-200 response tells the agent exactly **why** it failed, **when** to retry (or not), and **what** to do. No ambiguous 500s.

#### Upstream Protection: API Server Health

The auth request endpoint must not starve the rest of the API. Protections:

| Protection | Implementation |
|-----------|----------------|
| **Separate connection pool** | Auth request handler uses a dedicated HTTP keep-alive pool, sized to `max_concurrent_per_tenant × max_tenants`. Does not share with health/CRUD endpoints. |
| **Health endpoint priority** | `/health/live` and `/health/ready` are served by a lightweight handler that does NOT go through the auth request middleware chain. Health never blocks. |
| **Request abort on client disconnect** | If the agent closes the connection (timeout on their side), the server detects the abort and decrements the concurrent counter immediately. Does NOT cancel the underlying login (which other subscribers may need). |
| **Graceful shutdown** | On SIGTERM, stop accepting new auth requests (503). Allow in-flight requests to complete up to `SHUTDOWN_TIMEOUT_MS`. Login flows in progress continue independently (worker pods are separate processes). |

#### Downstream Protection: Worker Pod Isolation

The login flow in the worker pod must not be affected by API-layer pressure:

| Protection | Implementation |
|-----------|----------------|
| **Login is fire-and-forget from API perspective** | API publishes a NATS event to trigger login, then subscribes for result. API does not hold a direct connection to the worker. If the API restarts, the worker continues. |
| **Worker has its own rate limits** | `max_login_attempts_per_hour` on the worker prevents target-service lockout regardless of how many auth requests arrive at the API. |
| **Result publication is idempotent** | Worker publishes `auth.completed` to NATS. If NATS is temporarily unavailable, the worker retries publication. Credentials are still stored in MinIO regardless of NATS delivery. |
| **No fan-out amplification** | One login flow serves N subscribers. The worker doesn't know or care how many agents are waiting. It does one login and publishes one event. |

#### Signal Flow Summary

```
 UPSTREAM (Agent → API)            INTERNAL                    DOWNSTREAM (API → Worker)
 ───────────────────────           ────────────────────        ────────────────────────
 Rate limit exceeded        →  429 (immediate)
 Concurrent limit exceeded  →  503 (immediate)
 Circuit breaker open       →  503 (immediate)
 Cache HIT                  →  200 (immediate, <50ms)
                                                               Login triggered via NATS
                                                               (one-way, fire-and-forget)
 Subscriber waits           ←  NATS subscription
                                                               Worker publishes result
 Login success              ←  auth.completed event   ←       Worker: auth.completed
 Login failure              ←  auth.failed event      ←       Worker: auth.failed
 Timeout (nothing happened) →  504 (from timer)
 Client disconnects         →  decrement counter
                               (login continues for
                                other subscribers)
```

### Rationale

1. **Blocking is acceptable only when bounded.** The concurrent limit (50 per tenant) caps resource consumption. The timeout (login_timeout_ms + grace) caps wait time. The circuit breaker prevents queuing for broken profiles.
2. **Every failure is informative.** The agent never receives an opaque 500. Every error response includes a reason, a retry strategy, and context for debugging.
3. **Upstream and downstream are decoupled via NATS.** API server pressure doesn't affect worker pods. Worker pod failures don't crash the API. The only coupling is the event bus.
4. **The system degrades gracefully under load.** Excess requests are shed at admission (Stage 1) before consuming resources. In-flight requests complete or timeout cleanly.
5. **Connection pool isolation protects health checks.** K8s liveness/readiness probes are never starved by auth request traffic.

### Future Extensions

- **Async pull (202 + poll):** For agents that can't hold a 90-second connection. Returns `request_id`, agent polls `GET /auth/request/{id}/status`.
- **Server-Sent Events (SSE):** For agents that want streaming status updates during login (e.g., "logging in...", "MFA detected...", "extracting credentials...").
- **Push to secret store:** See ADR-009. Decoupled delivery for non-API consumers.

### Consequences

- New middleware: `AuthAdmissionGate` (rate limit + concurrent limit + circuit breaker check).
- Redis keys: `rate:auth:{tenant}`, `concurrent:auth:{tenant}`, `circuit:{tenant}:{profile}`.
- NATS subjects: `auth.completed.{t}.{p}.{c}`, `auth.failed.{t}.{p}.{c}`.
- API must configure separate connection pool for auth endpoints.
- Agent SDK/docs must document all response codes and retry strategies.
- Health endpoints must be exempt from auth request middleware.

---

## ADR-007: Proactive Credential Refresh at 80% TTL (Default)

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture, Product Owner

### Context

When should the system refresh (re-extract) credentials from a healthy browser session? This must balance:
- **Agent experience:** Agents should never see stale credentials in normal operation.
- **Target service load:** Unnecessary extractions waste cycles and may trigger anti-bot heuristics.
- **Service variability:** Session lifetimes vary widely — Salesforce (2h), some legacy apps (15min), some SSO (8h).

### Decision

Proactive refresh at **80% of `auth_ttl`** as the system default. **Tunable per service profile** via `refresh_threshold` (0.0–1.0).

### Configuration

```json
{
  "export_policy": {
    "auth_ttl_seconds": 3600,
    "refresh_threshold": 0.8,
    "refresh_interval_seconds": 1800
  }
}
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `auth_ttl_seconds` | 3600 | How long extracted credentials are considered valid |
| `refresh_threshold` | 0.8 | Fraction of `auth_ttl` at which proactive re-extraction triggers |
| `refresh_interval_seconds` | `auth_ttl × refresh_threshold` | Explicit override. If set, takes precedence over threshold calculation. |

**Tuning guidance by session lifetime:**

| Session Lifetime | Recommended `refresh_threshold` | Buffer | Rationale |
|------------------|---------------------------------|--------|-----------|
| >= 1 hour | 0.8 (default) | >= 12 min | Ample buffer for extraction + network latency |
| 30 min | 0.7 | 9 min | Tighter window, still comfortable |
| 15 min | 0.6 | 6 min | Very short sessions need earlier refresh |
| < 10 min | 0.5 | 5 min | Aggressively early; consider whether browser-based auth is viable |

### Refresh Trigger Logic

```
Keepalive cycle (every keepalive_interval):
  1. Execute health predicates
  2. If health PASS:
     a. Check: now > extracted_at + (auth_ttl × refresh_threshold)?
     b. YES → re-extract credentials → update cache → publish auth.credential.refreshed
     c. NO → skip extraction
  3. If health AUTH_FAIL:
     → Forced re-auth (overrides TTL — see ADR-004)
```

**Key invariant:** The credential cache TTL is always set to `auth_ttl_seconds`, NOT `auth_ttl × refresh_threshold`. The proactive refresh replaces the cached value before it expires. Agents that read cached credentials between the refresh and the old expiry get the freshly-extracted value.

### Rationale

1. **Agents should never see stale credentials in normal operation.** If `auth_ttl` is 3600s, refresh at 2880s — 12 minutes of buffer before any agent could receive expired credentials.
2. **Extraction is cheap when the session is healthy.** It's a `context.cookies()` + `context.storageState()` call + MinIO upload. No login required. Sub-second operation.
3. **20% buffer accounts for real-world variance** — clock skew between worker and API, network latency on MinIO upload, brief Redis propagation delay.
4. **Per-service tuning is essential.** A 15-minute session needs a 60% threshold (6-minute buffer). A 2-hour session is comfortable at 80%. One size does not fit all.

### Consequences

- Service profile schema includes `refresh_threshold` with default 0.8.
- Keepalive runner evaluates refresh threshold on every health-pass cycle.
- Dashboard metric: `credential_refresh_count` per profile (monitors refresh frequency).
- Alert: if a profile refreshes more than `3 × expected` per hour, the auth_ttl may be misconfigured or the session is churning.

---

## ADR-008: Namespace-per-Org as Default Isolation Tier

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture, Product Owner

### Context

What is the Kubernetes isolation boundary for each organization? See §11.1 of the Headless Auth Provider Spec.

### Decision

**K8s namespace per org** (Standard Tier) as the default. Dedicated clusters available for compliance-heavy organizations.

### Tier Definitions

| Tier | Isolation Boundary | Shared Infrastructure | Trigger |
|------|-------------------|----------------------|---------|
| **Standard** | K8s Namespace + NetworkPolicy | PostgreSQL (RLS), Redis (key prefix), NATS (ACL), MinIO (bucket-per-tenant) | Default for all orgs |
| **Enhanced** | Namespace + dedicated node pool (`nodeSelector`) | Same as Standard, but worker pods scheduled on tenant-reserved nodes | SOC2, regulated data, explicit request |
| **Dedicated** | Separate K8s cluster | All infrastructure dedicated | HIPAA, PCI-DSS, >50 service profiles, explicit contractual requirement |

### Namespace Provisioning

When a new organization is onboarded, the following resources are created:

```yaml
# 1. Namespace
apiVersion: v1
kind: Namespace
metadata:
  name: browser-hitl-{org-slug}
  labels:
    browser-hitl/tenant-id: "{tenant-uuid}"
    browser-hitl/tier: "standard"

# 2. ResourceQuota
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-quota
  namespace: browser-hitl-{org-slug}
spec:
  hard:
    pods: "20"
    requests.cpu: "20"
    requests.memory: "40Gi"
    limits.cpu: "40"
    limits.memory: "60Gi"

# 3. Default-deny NetworkPolicy
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: browser-hitl-{org-slug}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]

# 4. Allow cross-namespace access to shared services
# (individual policies for PostgreSQL, Redis, NATS, MinIO, egress proxy)
```

### Rationale

1. **Cost efficiency.** Dedicated K8s clusters cost ~$500/mo minimum (managed). Namespace isolation is effectively free.
2. **NetworkPolicies provide strong network isolation.** Worker pods in `browser-hitl-acme` cannot reach pods in `browser-hitl-globex`. Default-deny ensures new pods are isolated by default.
3. **ResourceQuotas prevent noisy-neighbor resource exhaustion.** One org cannot starve another of CPU/memory.
4. **Shared infrastructure with logical isolation is the existing model** — already tested and proven in the PoC phase (RLS, key prefixes, ACL, bucket-per-tenant).
5. **Dedicated cluster is a known upgrade path** when contractual or compliance requirements demand it. Same Helm chart, different infrastructure.

### Consequences

- Controller must manage worker pods across multiple namespaces (cross-namespace RBAC).
- Org onboarding automation must create namespace + ResourceQuota + NetworkPolicies.
- Monitoring must be namespace-aware (Prometheus relabeling by tenant).
- Controller ServiceAccount needs `ClusterRole` for cross-namespace pod management.

---

## ADR-009: API-Only for v1; Secret Store Push Critical for v2

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture, Product Owner

### Context

Some organizations want credentials pushed to a secret store (HashiCorp Vault, AWS Secrets Manager, etc.) rather than pulled via API. This enables decoupled architectures where the agent reads credentials from a known path without calling the auth provider directly.

### Decision

**API-only (pull model) for v1.** Design the push interface abstractly so secret store backends are pluggable. **Secret store push is a critical requirement for the next major iteration (v2).**

### v1 Implementation

- Credentials served exclusively via `POST /auth/request` response (ADR-006).
- `CredentialPublisher` interface defined in code with a single implementation: `ApiResponsePublisher` (returns credentials in HTTP response body).
- Service profile has `export_policy.push_to_secret_store: false` as default. Field exists in schema but is not actionable in v1.

### v2 Roadmap (Committed)

> **This section is a binding commitment, not aspirational.** Secret store push was explicitly identified as critical for the next major release.

**v2 will implement:**

| Backend | Integration | Priority |
|---------|------------|----------|
| HashiCorp Vault | KV v2 secrets engine, AppRole auth, per-tenant policy | HIGH — most common enterprise secret store |
| K8s External Secrets Operator | `ExternalSecret` CRD, operator syncs to K8s Secret | HIGH — Kubernetes-native, no extra infrastructure |
| AWS Secrets Manager | IAM role, per-tenant secret path, rotation support | MEDIUM — for AWS-hosted orgs |
| Azure Key Vault | Managed identity, per-tenant vault or secret scope | MEDIUM — for Azure-hosted orgs |

**Push flow (v2):**

```
Worker extracts credentials
  → CredentialPublisher.publish(tenantId, profileId, credentials)
    → VaultPublisher: PUT /v1/secret/data/browser-hitl/{tenant}/{profile}
    → ExternalSecretPublisher: update K8s Secret, ESO syncs
    → API cache: update Redis (same as v1)
  → NATS: auth.credential.refreshed.{tenant}.{profile}
  → Agents reading from secret store get fresh credentials automatically
```

**Interface contract (defined now, implemented in v2):**

```typescript
interface CredentialPublisher {
  /**
   * Publish credentials to the configured store.
   * Called after every successful extraction.
   * Must be idempotent (repeated calls with same data are safe).
   * Must not throw — failures are logged and metriced, not propagated.
   */
  publish(
    tenantId: string,
    profileId: string,
    credentialSetId: string,
    credentials: EncryptedCredentialBundle,
  ): Promise<PublishResult>;
}

interface PublishResult {
  backend: string;       // "vault", "k8s-external-secrets", "api-response"
  success: boolean;
  version?: string;      // secret version (Vault KV v2 version number)
  error?: string;        // on failure
}
```

### Rationale

1. **Pull model works for all agents now.** Every agent can make an HTTP call. Not every agent has Vault access configured.
2. **Push adds operational complexity** that would delay v1. Vault credentials, policies, and paths must be managed per org. ESO requires operator installation.
3. **Defining the interface now prevents architectural debt.** The `CredentialPublisher` abstraction ensures v2 push is a new implementation, not a refactor.
4. **Secret store push is critical for production at scale.** Agents in CI/CD pipelines, serverless functions, and non-interactive contexts cannot easily make synchronous API calls. They need credentials at a known path.

### Consequences

- v1: `CredentialPublisher` interface with `ApiResponsePublisher` only.
- v1: `export_policy.push_to_secret_store` exists in schema, validated as `false`. Setting to `true` returns a 501 Not Implemented with message: "Secret store push is planned for v2. Use API pull model."
- v2: tracked as a top-priority epic. Scoping should begin when v1 is in production.
- Documentation: v1 QUICKSTART and API docs must note that secret store push is planned.

---

## ADR-010: Agent Authentication via OAuth 2.0 Client Credentials

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture
**Resolves:** GAP-001

### Context

The Headless Auth Provider spec defines agents calling `POST /auth/request` but never specifies how agents authenticate to the auth provider itself. Without this, any HTTP client can request enterprise credentials for any tenant. This is the most fundamental security gap in the system.

The existing codebase has two mechanisms: human login (email/password → JWT) and service tokens (client_id/client_secret → JWT). The service token mechanism is structurally closest to what agents need, but has critical limitations for production multi-agent use: single shared client_id/client_secret, no per-agent identity, no per-agent scoping or revocation.

### Decision

**OAuth 2.0 Client Credentials flow (RFC 6749 §4.4)** with per-agent registration, scoped tokens, and short TTL. Extend the existing service token infrastructure rather than replacing it.

### Design

#### Agent Registration

Each agent (or agent deployment) is registered as a **client** in the system. Registration is an admin-only operation.

```
POST /admin/agent-clients
Authorization: Bearer {admin_jwt}
{
  "name": "salesforce-integration-agent",
  "tenant_id": "uuid",
  "allowed_profiles": ["salesforce-standard", "servicenow-itsm"],
  "role": "agent",
  "token_ttl_seconds": 3600,
  "rate_limit_override": null
}

Response:
{
  "client_id": "agent_cl_a1b2c3d4e5f6",
  "client_secret": "secret_sk_...",       // shown ONCE, never again
  "tenant_id": "uuid",
  "created_at": "2026-02-21T..."
}
```

**Agent client entity (new):**

```
agent_clients table:
  id: UUID (PK)
  client_id: string (unique, indexed) — format: agent_cl_{random}
  client_secret_hash: string (HMAC-SHA256, NOT bcrypt — see amendment below)
  name: string
  tenant_id: UUID (FK)
  allowed_profiles: string[] — which service profiles this agent can request creds for
  role: enum ['agent'] — dedicated role, distinct from Admin/Operator/Viewer
  token_ttl_seconds: integer (default 3600, max 86400)
  rate_limit_per_minute: integer (default 30)
  enabled: boolean (default true)
  last_used_at: timestamptz
  created_at: timestamptz
  revoked_at: timestamptz (nullable — soft revocation)
```

#### Token Issuance

Agents authenticate using the standard Client Credentials flow:

```
POST /auth/agent-token
Content-Type: application/json
{
  "client_id": "agent_cl_a1b2c3d4e5f6",
  "client_secret": "secret_sk_...",
  "grant_type": "client_credentials"
}

Response:
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "auth:request profile:salesforce-standard profile:servicenow-itsm"
}
```

**JWT payload for agent tokens:**

```json
{
  "sub": "agent:agent_cl_a1b2c3d4e5f6",
  "tenant_id": "uuid",
  "role": "agent",
  "jti": "uuid",
  "kid": "v1",
  "token_type": "agent",
  "agent_client_id": "agent_cl_a1b2c3d4e5f6",
  "allowed_profiles": ["salesforce-standard", "servicenow-itsm"],
  "iat": 1740000000,
  "exp": 1740003600
}
```

#### Authorization Enforcement

The `POST /auth/request` endpoint validates:

1. **Token present and valid** (JWT signature, expiry, not revoked)
2. **Token type is `agent`** (human and service tokens cannot call `/auth/request`)
3. **Requested `profile_id` is in `allowed_profiles`** from the token
4. **Tenant matches** (token tenant_id = requested tenant_id)
5. **Agent client is `enabled`** (DB check, cached in Redis for 60s)
6. **Per-agent rate limit** not exceeded

```
POST /auth/request
Authorization: Bearer {agent_jwt}
{
  "profile_id": "salesforce-standard",
  "credential_set_id": "default"
}

Authorization checks:
  ✓ JWT valid, not expired, not revoked
  ✓ token_type == "agent"
  ✓ "salesforce-standard" in token.allowed_profiles
  ✓ token.tenant_id matches profile's tenant
  ✓ agent_client.enabled == true
  ✓ rate limit: < 30 req/min for this agent_client_id
```

#### Agent Role Permissions

| Permission | Admin | Operator | Viewer | Agent |
|-----------|-------|----------|--------|-------|
| Manage users/tenants | Yes | No | No | No |
| Manage service profiles | Yes | No | No | No |
| Register agent clients | Yes | No | No | No |
| View sessions | Yes | Yes | Yes | Own tenant only |
| HITL takeover/release | Yes | Yes | No | No |
| Submit OTP | Yes | Yes | No | No |
| **Request credentials** | No | No | No | **Yes** |
| View VNC stream | Yes | Yes | Yes | No |

**Key constraint:** Agents can request credentials but cannot perform HITL operations, manage profiles, or access VNC streams. This limits blast radius of a compromised agent token.

#### Revocation

- **Immediate:** Admin calls `DELETE /admin/agent-clients/{id}` → sets `revoked_at`, `enabled=false`. Token blacklist entry added for the client's current token jti.
- **Rotation:** Admin calls `POST /admin/agent-clients/{id}/rotate-secret` → new client_secret generated, old one invalidated, all existing tokens for this client blacklisted.
- **Expiry:** Short-lived tokens (1h default) limit blast radius. Compromised token is usable for at most `token_ttl_seconds`.

#### Amendment: Secret Hashing Strategy (RT-01)

**Problem:** bcrypt cost 12 takes ~250ms per hash. At scale (thousands of agents requesting tokens), this creates a CPU-bound bottleneck. Agent secrets are machine-generated high-entropy strings (`secret_sk_{64 random chars}`) — they are NOT user-chosen passwords and do NOT need memory-hard hashing.

**Resolution:** Use **HMAC-SHA256** with a server-side secret key for `client_secret_hash`:

```
Hashing:   client_secret_hash = HMAC-SHA256(SERVER_SECRET_KEY, client_secret)
Validation: constant_time_compare(stored_hash, HMAC-SHA256(SERVER_SECRET_KEY, input_secret))
```

| Property | bcrypt | HMAC-SHA256 |
|----------|--------|-------------|
| Time per hash | ~250ms | ~0.01ms |
| CPU at 1000 concurrent agents | 100% utilization | negligible |
| Appropriate for | User passwords (low entropy) | Machine secrets (high entropy) |
| Brute force resistance | Memory-hard | Key-dependent (secure if SERVER_SECRET_KEY is strong) |

**SERVER_SECRET_KEY** is a 256-bit key stored in K8s Secret, distinct from `JWT_SECRET`. Rotation: if key changes, all existing agent client secrets must be re-registered.

**Note:** Human user passwords (`users.password_hash`) REMAIN bcrypt cost 12. This change applies ONLY to `agent_clients.client_secret_hash`.

#### Amendment: Token Refresh Pattern (RT-08)

**Problem:** No documented pattern for token refresh before expiry. Agent token expires mid-workflow → 401 → agent fails.

**Resolution:** Agent SDK must implement the following pattern:

```
Token lifecycle:
  1. Agent calls POST /auth/agent-token → receives access_token with expires_in
  2. Agent stores token_expiry = now() + expires_in
  3. Before each API call, agent checks: token_expiry - now() < 300s (5 min buffer)?
     If yes → call POST /auth/agent-token again to get fresh token
  4. On 401 from any endpoint → immediately re-authenticate

No refresh token is issued. Agents re-authenticate with client_id/client_secret.
This is standard OAuth 2.0 Client Credentials behavior — no refresh tokens in this flow.
```

The `POST /auth/agent-token` response includes `expires_in` and `refresh_before`:

```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_before": 3300,
  "scope": "auth:request profile:salesforce-standard"
}
```

#### Why Not mTLS

mTLS is technically superior for in-cluster machine-to-machine auth but:
1. Requires PKI infrastructure (cert-manager, CA, rotation) — adds complexity.
2. Agents outside the cluster (SaaS agents, CI/CD pipelines) can't use mTLS easily.
3. OAuth 2.0 Client Credentials is universally understood by enterprise customers.
4. mTLS can be layered on TOP of Client Credentials as defense-in-depth for the Enhanced/Dedicated tiers (ADR-008) — not as a replacement.

### Rationale

1. **OAuth 2.0 Client Credentials is the industry standard** for machine-to-machine auth. Every enterprise security team understands it.
2. **Per-agent registration provides granular audit.** Every credential request is traceable to a specific agent client.
3. **Profile scoping limits blast radius.** A compromised agent token for "salesforce-standard" cannot request ServiceNow credentials.
4. **Short-lived tokens limit exposure.** 1-hour default means a leaked token is usable for at most 60 minutes.
5. **Extends existing infrastructure.** The `issueServiceToken` method is 80% of what's needed. New endpoint + agent_clients entity + profile scoping.

### Consequences

- New entity: `agent_clients` table.
- New role: `agent` in the RBAC enum.
- New endpoint: `POST /auth/agent-token` (client credentials grant).
- New admin endpoints: CRUD for agent clients, secret rotation.
- JwtStrategy must validate `allowed_profiles` on auth request endpoints.
- Agent SDK/docs must document the client credentials flow and token refresh pattern.

---

## ADR-011: Redis Resilience and Tiered Failure Modes

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture
**Resolves:** GAP-002, GAP-010

### Context

Redis is used for 10 distinct purposes across the system. A single Redis instance is a single point of failure. The system currently has inconsistent failure behavior — some operations fail open (security risk), some fail closed (availability risk), some are undefined.

The production-grade answer is: **no single Redis failure should simultaneously compromise security AND availability.** Every Redis use case must have an explicit, tested failure mode.

### Decision

Three-part strategy: **Redis HA infrastructure**, **tiered failure mode policy**, and **graceful degradation for every key category**.

### Part 1: Redis HA Infrastructure

| Environment | Topology | Failover |
|-------------|----------|----------|
| Local/dev | Single instance | None (acceptable) |
| Production Standard (ADR-008) | Redis Sentinel (3 nodes: 1 master + 2 replicas) | Automatic failover, ~5-15s detection |
| Production Dedicated | Redis Cluster (6 nodes: 3 masters + 3 replicas) | Automatic, sub-second |

**Why Sentinel, not Cluster, for Standard tier:** Cluster adds hash-slot complexity. Our key patterns are simple (no cross-key transactions except Lua scripts). Sentinel gives HA with simpler operations. Cluster for Dedicated tier where scale justifies complexity.

### Part 2: Tiered Failure Mode Policy

Every Redis use case is assigned to exactly one of three tiers:

| Tier | Failure Mode | Rationale | Recovery |
|------|-------------|-----------|----------|
| **SECURITY** | **Fail closed** | These operations protect access control. Allowing bypass is a security breach. | Reject the operation. Return 503 to client. |
| **CONSISTENCY** | **Fail closed with grace period** | These operations protect data consistency. Brief unavailability is better than corruption. Grace period prevents flapping. | Use stale value for grace period (30s), then reject. |
| **AVAILABILITY** | **Fail open with degradation** | These operations improve performance but aren't security-critical. Serving degraded is better than not serving at all. | Fall through to slower path. Log degradation metric. |

### Part 3: Key Category Assignments

| Key Pattern | Purpose | Tier | Redis Down Behavior |
|------------|---------|------|-------------------|
| `token:revoked:{jti}` | JWT blacklist | **SECURITY** | **Fail closed.** All token validations fail → 503. Effective: system pauses auth until Redis is back. Short-lived tokens (1h) limit window. |
| `stream_token:{jti}` | VNC stream token | SECURITY | Fail closed (already implemented). |
| `artifact_token:{id}` | Download token | SECURITY | Fail closed (already implemented). |
| `auth_req_lock:{t}:{p}:{c}` | Coalescing lock | **CONSISTENCY** | Fail closed. No lock = no login triggered. Agent gets 503. See ADR-012 for defense-in-depth. |
| `concurrent:auth:{tenant}` | Admission counter | **CONSISTENCY** | Grace: use last-known value for 30s, then reject new requests. Prevents counter leak. |
| `circuit:{tenant}:{profile}` | Circuit breaker | **CONSISTENCY** | Grace: assume circuit CLOSED for 30s (allow requests), then assume OPEN (reject). Prevents both stampede and permanent block. |
| `rate:auth:{tenant}` | Rate limit | **AVAILABILITY** | Fail open. Allow requests without rate limiting. Log `rate_limit_degraded` metric. Agents won't notice. |
| `cred:{t}:{p}:{c}` | Credential cache | **AVAILABILITY** | Fall through to MinIO. Decrypt artifact bundle directly. Slower (~200ms vs ~5ms) but functional. |
| `otp:{session_id}` | OTP relay | **AVAILABILITY** | OTP delivery fails. HITL flow stalls. Operator retries. Not a security risk — just operational delay. |
| `idempotency:agent:*` | Deduplication | **AVAILABILITY** | Fail open. Duplicate execution is the lesser evil vs blocking all agent runs. |

### Implementation: Redis Health Monitor

```typescript
class RedisHealthMonitor {
  private state: 'HEALTHY' | 'DEGRADED' | 'DOWN' = 'HEALTHY';
  private lastHealthy: Date = new Date();
  private readonly GRACE_PERIOD_MS = 30_000;

  async checkHealth(): Promise<void> {
    try {
      await this.redis.ping();
      this.state = 'HEALTHY';
      this.lastHealthy = new Date();
    } catch {
      const elapsed = Date.now() - this.lastHealthy.getTime();
      this.state = elapsed < this.GRACE_PERIOD_MS ? 'DEGRADED' : 'DOWN';
    }
  }

  shouldFailClosed(tier: 'SECURITY' | 'CONSISTENCY' | 'AVAILABILITY'): boolean {
    if (this.state === 'HEALTHY') return false;
    if (tier === 'SECURITY') return true;  // always fail closed
    if (tier === 'CONSISTENCY') return this.state === 'DOWN';  // grace period
    return false;  // AVAILABILITY: never fail closed
  }
}
```

### Token Blacklist: Fail-Closed with Circuit Breaker

The existing code has a comment: "fail-closed would DoS all users if Redis goes down." This is true for long outages. The solution:

1. **Fail closed immediately** (revoked tokens cannot be used).
2. **Short-lived tokens limit blast radius** (1h for agents per ADR-010, 24h for humans).
3. **If Redis is DOWN for > 5 minutes**, the system enters **emergency mode**: reject ALL auth requests (not just blacklist checks) with `503 Service Unavailable: infrastructure degraded`. This prevents both the security hole AND the DoS — the system simply stops serving until Redis is back.
4. **Health endpoint reports Redis state** so K8s can detect the degradation.

Emergency mode is a deliberate and explicit circuit breaker. It's better than the current situation where the system silently serves revoked tokens.

### Amendment: Health Endpoint Protection During Emergency Mode (RT-02)

**Problem:** Emergency mode rejects ALL auth requests. If health endpoints (`/health/live`, `/health/ready`) require JWT validation, they return 503. K8s liveness probe fails → pod restart → Redis still down → restart loop. System never recovers.

**Resolution:** Three rules that MUST be enforced:

1. **Health endpoints (`/health/live`, `/health/ready`) NEVER require JWT authentication.** This is already the case in the current codebase — these endpoints are explicitly excluded from `JwtAuthGuard`. This exclusion MUST be preserved and tested with an adversarial test.

2. **Emergency mode applies ONLY to business endpoints** (`/auth/request`, `/auth/agent-token`, etc.). It does NOT apply to health probes, metrics (`/metrics`), or the admin emergency API.

3. **Readiness probe behavior during Redis outage:**
   - `/health/ready` returns `200` with degraded status: `{"status": "degraded", "redis": "down", "postgres": "up"}`
   - It does NOT return `503`. This prevents K8s from removing the pod from service.
   - The pod remains in the service mesh so it can resume immediately when Redis returns.
   - K8s readiness gate: use a **custom condition** instead of HTTP readiness probe for Redis dependency.

```
Emergency mode scope:
  AFFECTED:     POST /auth/request, POST /auth/agent-token, POST /auth/service-token
  NOT AFFECTED: GET /health/live, GET /health/ready, GET /metrics, all admin endpoints
```

**Adversarial test required:** Start system → stop Redis → verify health endpoints still return 200 → verify business endpoints return 503 → start Redis → verify system recovers within 30s.

### Amendment: CONSISTENCY Tier Grace Period Default (RT-09)

**Problem:** CONSISTENCY tier says "use stale value for grace period (30s)." But if the concurrent counter was at max when Redis went down, the stale value IS the rejection value. Grace period just delays the rejection by 30s without helping.

**Resolution:** For CONSISTENCY tier, grace period uses a **safe default**, not the last-known value:

| Key Category | Safe Default During Grace | Rationale |
|-------------|--------------------------|-----------|
| Concurrent counter | **0** (allow requests) | Better to allow a few extra requests than to block all requests |
| Circuit breaker | **CLOSED** (allow requests) | Better to retry than to block permanently |
| Coalescing lock | **Not acquired** (fall through to PG lock) | Barrier 2 handles serialization |

This means during the 30s grace period after Redis goes down, the system continues operating with relaxed limits. After 30s, CONSISTENCY tier fails closed.

### Consequences

- Production: Redis Sentinel (3 nodes) in `values-production.yaml`.
- New `RedisHealthMonitor` service with state machine.
- Every Redis-using service receives the monitor and checks tier before operating.
- Token blacklist becomes fail-closed. Emergency mode at 5-minute threshold.
- Emergency mode scoped to business endpoints only — health/metrics/admin excluded.
- Readiness probe returns degraded status (200), not failure (503), during Redis outage.
- CONSISTENCY tier grace period uses safe defaults, not stale values.
- Credential cache fallback to MinIO direct read.
- New metric: `redis_health_state` gauge (0=healthy, 1=degraded, 2=down).
- New alert: `redis_health_state == 2` for > 30 seconds.
- **Required adversarial test:** Redis stop → health endpoints still 200 → business endpoints 503 → Redis start → full recovery.

---

## ADR-012: Defense-in-Depth for Login Serialization

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture
**Resolves:** GAP-003, GAP-006, GAP-011

### Context

ADR-002 uses a Redis distributed lock for request coalescing. This lock is vulnerable to split-brain during Redis failover (Redlock problem) and TTL expiry during slow MFA flows. The consequence — duplicate concurrent logins — is the exact scenario that causes account lockout on target services.

Additionally, system startup creates a thundering herd: all sessions re-login simultaneously after a restart, overwhelming target services.

A single lock is not enough. Production-grade login serialization requires defense-in-depth: multiple independent barriers, any one of which prevents duplicate logins.

### Decision

**Three-barrier login serialization** with each barrier operating independently. A login flow must pass ALL barriers to execute. Any barrier blocking prevents the login from starting.

### Design: Three Barriers

```
Auth request arrives → needs login

BARRIER 1: Redis Lock (fast path, distributed)
  ├── SETNX auth_req_lock:{t}:{p}:{c} TTL=login_timeout+60s
  ├── ACQUIRED → proceed to barrier 2
  └── NOT ACQUIRED → coalesce (subscribe to NATS completion event)

BARRIER 2: PostgreSQL Row-Level Lock on AuthRequest entity (durable, survives Redis failover)
  ├── INSERT auth_request with state=IN_PROGRESS
  ├── SELECT ... FOR UPDATE SKIP LOCKED on existing IN_PROGRESS row
  ├── If INSERT succeeds → this process owns the login → proceed to barrier 3
  ├── If row already exists (IN_PROGRESS) → another process is logging in → coalesce
  └── Lock held by the transaction, released on COMMIT/ROLLBACK
  └── If API process crashes → connection closes → transaction rolls back → row unlocked

BARRIER 3: Worker-Side Rate Guard (per-credential-set, PG-persisted)
  ├── Worker checks: session.last_login_attempt_at in DB
  ├── If < MIN_LOGIN_INTERVAL (60s) → refuse, return error
  ├── If OK → UPDATE session SET last_login_attempt_at = now() → execute login DSL
  └── This barrier works even if BOTH Redis and PostgreSQL locks fail
  └── Persisted to DB → survives worker restart
```

#### Amendment: Row-Level Lock Instead of Advisory Lock (RT-04)

**Problem with PG advisory locks:** Advisory locks are session-scoped — they are bound to the database connection, NOT a transaction. If the API process crashes, the connection pool closes, and the advisory lock is released. This is the **same failure mode as Redis locks** (both release on process death). The "defense-in-depth" claim was misleading because barriers 1 and 2 failed in the same scenario.

**Resolution:** Replace PG advisory lock with a **row-level lock on the AuthRequest entity**. The AuthRequest row itself is the lock:

```
Lock acquisition:
  1. Attempt INSERT INTO auth_requests (tenant_id, profile_id, cred_set_id, state)
     VALUES (..., 'IN_PROGRESS')
     ON CONFLICT (tenant_id, profile_id, cred_set_id) WHERE state = 'IN_PROGRESS'
     DO NOTHING
     RETURNING id;

  2. If row returned → we inserted → we own the login
  3. If no row returned → IN_PROGRESS row exists → coalesce (subscribe to NATS event)

Lock release:
  On login success: UPDATE auth_requests SET state = 'COMPLETED'
  On login failure: UPDATE auth_requests SET state = 'FAILED'
  On crash: Controller stale detection (see lifecycle below) expires the row
```

**Key difference from advisory lock:** The row persists after process crash. The lock is NOT released by process death — it's released by explicit state transition or stale detection timeout. This makes Barrier 2 genuinely independent from Barrier 1.

**Unique constraint:**
```sql
CREATE UNIQUE INDEX idx_auth_req_active_unique
  ON auth_requests (tenant_id, profile_id, credential_set_id)
  WHERE state = 'IN_PROGRESS';
```

This PostgreSQL partial unique index ensures at most ONE IN_PROGRESS record per credential set.

#### Amendment: Worker Rate Guard Persistence (RT-10)

**Problem:** Worker-side rate guard stored `last_login_attempt_at` in memory. Worker restart = timestamp lost = guard ineffective.

**Resolution:** `last_login_attempt_at` is a column on the `sessions` table, updated by the worker before executing login DSL. Survives worker restart because it's in PostgreSQL.

**Why three barriers (revised):**

| Barrier | Survives Redis Failover | Survives PG Failover | Survives API Crash | Survives Worker Restart | Speed |
|---------|------------------------|---------------------|-------------------|------------------------|-------|
| Redis Lock | No | Yes | No (TTL expiry) | Yes | ~1ms |
| PG Row Lock | Yes | No | **Yes** (row persists) | Yes | ~5ms |
| Worker Rate Guard (PG) | Yes | No | Yes | **Yes** (persisted) | ~5ms |

**Critical improvement:** Barrier 2 now survives API process crash (row persists in PG, stale detection handles timeout). Barrier 3 now survives worker restart (timestamp in PG). The only scenario that defeats all three barriers simultaneously is a PG outage — which is acceptable because PG outage = complete system outage (PG is the primary datastore).

### AuthRequest Entity Lifecycle

The `AuthRequest` entity from ADR-002 needs lifecycle management:

```
States: RECEIVED → IN_PROGRESS → COMPLETED | FAILED | EXPIRED

Cleanup rules:
  COMPLETED: retained for 24 hours (audit), then archived/deleted
  FAILED:    retained for 7 days (debugging), then archived/deleted
  EXPIRED:   IN_PROGRESS records not resolved within 2× login_timeout
             → auto-transitioned to EXPIRED by Controller reconcile loop
             → Redis lock released (DEL key)
             → PG row no longer blocks (state != IN_PROGRESS)

Stale detection:
  Every 60s, Controller scans for IN_PROGRESS records older than login_timeout
  → Marks as EXPIRED
  → Publishes auth.failed event (unblocks subscribers)
  → Releases all locks

Index:
  CREATE INDEX idx_auth_req_active
    ON auth_requests (tenant_id, profile_id, credential_set_id)
    WHERE state = 'IN_PROGRESS';
```

### Startup Storm Prevention

On system restart, the Controller does NOT immediately re-login all sessions:

```
1. Controller starts
2. Reconcile loop detects N sessions need re-provisioning
3. For each session, assign a STARTUP DELAY:
     delay = (session_index × STAGGER_INTERVAL) + random_jitter(0, JITTER_MAX)
     where STAGGER_INTERVAL = 10s, JITTER_MAX = 5s
4. Sessions are queued for provisioning with their delay
5. Global login rate limit: max 3 concurrent login flows system-wide
   (separate from per-tenant limits)
6. Global target-service rate limit: max 3 concurrent logins per target domain
   across ALL tenants (configurable per-domain, see ADR-015 amendment RT-06)
```

**Example:** 20 sessions to restart:
- Session 0: delay 0-5s
- Session 1: delay 10-15s
- Session 2: delay 20-25s
- ...
- Session 19: delay 190-195s
- Total startup time: ~3.5 minutes (vs 0 seconds without staggering)
- Max concurrent logins to any single target service: 3 (configurable per-domain)

### Consequences

- Login flow acquires Redis lock, then PG row-level lock (AuthRequest INSERT), then proceeds.
- PG row-level lock uses partial unique index on `(tenant_id, profile_id, credential_set_id) WHERE state = 'IN_PROGRESS'`.
- Worker persists `last_login_attempt_at` to `sessions` table; refuses login if too recent.
- AuthRequest entity has cleanup sweep in Controller reconcile loop (stale detection every 60s).
- Startup includes staggered delay queue with global rate limits.
- New session column: `last_login_attempt_at` (timestamptz).
- New constants: `MIN_LOGIN_INTERVAL_MS` (60000), `STARTUP_STAGGER_INTERVAL_MS` (10000), `STARTUP_JITTER_MAX_MS` (5000), `GLOBAL_MAX_CONCURRENT_LOGINS` (3), `GLOBAL_MAX_CONCURRENT_PER_TARGET_DOMAIN` (3).

---

## ADR-013: Credential Response Envelope and Volatility Model

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture
**Resolves:** GAP-004, GAP-007

### Context

The spec says the API returns "cookies, headers, CSRF token" but defines no schema. Agents need a standardized envelope to know what they're getting and how to use each credential type. Additionally, different credential types have fundamentally different volatility: session cookies may last hours, CSRF tokens rotate on every page load.

### Decision

Standardized credential response envelope with per-credential-type volatility classification and usage metadata.

### Credential Volatility Model

| Class | TTL Behavior | Examples | Cache Strategy |
|-------|-------------|----------|---------------|
| **Stable** | Valid for `auth_ttl`. Rarely changes mid-session. | Session cookies (`sid`, `oid`), OAuth access tokens | Cache for `auth_ttl`. Proactive refresh at 80% (ADR-007). |
| **Semi-stable** | Valid for minutes-to-hours, but may rotate unpredictably. | Bearer tokens, some authorization headers | Cache with shorter TTL (`auth_ttl / 2`). Re-extract on 401 from agent. |
| **Volatile** | May change on every page navigation. Cannot be reliably cached. | CSRF tokens, nonces, anti-forgery tokens | **Never cached.** Extracted on-demand per agent request. |

### Response Envelope Schema

```json
{
  "request_id": "uuid",
  "profile_id": "salesforce-standard",
  "credential_set_id": "default",
  "freshness": "cached | extracted | on_demand | degraded",
  "extracted_at": "2026-02-21T10:00:00Z",
  "session_state": "HEALTHY",
  "session_id": "uuid",

  "credentials": {
    "cookies": [
      {
        "name": "sid",
        "value": "...",
        "domain": ".salesforce.com",
        "path": "/",
        "secure": true,
        "httpOnly": true,
        "sameSite": "Lax",
        "expires": "2026-02-21T12:00:00Z",
        "volatility": "stable"
      }
    ],

    "headers": {
      "Authorization": {
        "value": "Bearer eyJ...",
        "volatility": "semi_stable",
        "usage": "Include in all API requests to *.salesforce.com"
      }
    },

    "csrf": {
      "token": "abc123",
      "header_name": "X-CSRF-Token",
      "volatility": "volatile",
      "warning": "This token may already be stale. If rejected, re-request credentials with force_refresh=true."
    }
  },

  "usage": {
    "target_domains": ["*.salesforce.com", "*.force.com"],
    "instructions": "Set cookies on the target domain. Include headers in all requests. CSRF token goes in X-CSRF-Token header.",
    "on_auth_failure": "Call POST /auth/request with force_refresh=true"
  },

  "metadata": {
    "cache_hit": true,
    "cache_age_seconds": 120,
    "next_refresh_at": "2026-02-21T10:48:00Z"
  }
}
```

### On-Demand Volatile Credential Extraction

When the response includes volatile credentials (CSRF), two strategies:

**Strategy A: Include with warning (default)**
Return the last-extracted CSRF value with `volatility: "volatile"` and a warning. Agent uses it; if rejected, re-requests with `force_refresh=true`.

**Strategy B: Real-time extraction (opt-in)**
Agent calls `POST /auth/request` with `include_volatile: true`. The system triggers a fresh extraction from the live browser session (not from cache). Adds ~2-5 seconds of latency but guarantees freshness.

```
POST /auth/request
{
  "profile_id": "salesforce-standard",
  "include_volatile": true    // triggers real-time extraction
}
```

### Agent-Side Credential Handling Guidance

Mandatory section in agent SDK documentation:

| Rule | Rationale |
|------|-----------|
| **NEVER log the response body.** | Contains plaintext credentials. Use `request_id` for correlation instead. |
| **Store credentials in memory only.** | Do not persist to disk, database, or environment variables. |
| **Respect `volatility` classification.** | Volatile credentials must not be cached by the agent. |
| **On 401 from target service, re-request with `force_refresh: true`.** | Don't retry with the same credentials — they're stale. |
| **Treat all credential material as secrets.** | Apply the same handling as passwords and API keys. |

### Amendment: force_refresh Coalescing (RT-11)

**Problem:** If multiple agents receive stale CSRF tokens simultaneously, all send `force_refresh=true` at once. This creates a thundering herd on the extraction path — the worker processes N simultaneous extraction requests.

**Resolution:** `force_refresh` requests are coalesced using the same pattern as login coalescing (ADR-012):

```
force_refresh request arrives:

1. Check: is there an active extraction for this credential_set?
   (Redis key: extract_lock:{tenant}:{profile}:{cred_set} with short TTL, 30s)

2. If NO active extraction:
   → Acquire lock → trigger worker extraction → wait for result → respond

3. If YES active extraction:
   → Subscribe to NATS event auth.extraction.{tenant}.{profile}.{cred_set}
   → Wait (max 15s timeout)
   → When event arrives → respond with fresh credentials

Result: N simultaneous force_refresh requests trigger only ONE extraction.
The worker is never hit with concurrent extraction requests for the same credential set.
```

### Amendment: Volatile Credential Fallback (RT-14)

**Problem:** ADR-011 says credential cache (AVAILABILITY tier) falls through to MinIO on Redis outage. But volatile credentials (CSRF tokens) are NEVER in MinIO — they require live browser extraction. If the worker is unreachable, volatile credential requests have no fallback path.

**Resolution:** Explicit failure modes for volatile credentials:

| Scenario | Response |
|----------|----------|
| Worker healthy, extraction succeeds | Return volatile credentials normally |
| Worker healthy, extraction fails | Return stable credentials + `"csrf": null` with `"warning": "Volatile credentials unavailable. Target service may reject CSRF-protected requests."` |
| Worker unreachable | Return stable credentials from cache/MinIO + `"csrf": null` + `"volatile_available": false` |
| Worker unreachable + no cached stable credentials | Return `503` with `"error": "session_unavailable"` |

**Key principle:** Volatile credential failure NEVER blocks stable credential delivery. An agent that only needs cookies can still get them even when CSRF extraction fails. The response envelope explicitly communicates what's available and what isn't.

### Consequences

- Response schema is a formal contract — breaking changes require a major version bump.
- Service profile config includes `credential_types` with volatility classification per field.
- Volatile credential extraction triggers a worker-side page interaction (adds latency).
- force_refresh requests are coalesced — at most one concurrent extraction per credential set.
- Volatile credential failure is non-blocking: stable credentials still delivered with explicit warning.
- Agent SDK must document the response schema, handling rules, and volatile fallback behavior.
- `force_refresh` parameter on auth request triggers cache bypass + fresh extraction.

---

## ADR-014: Service Profile Versioning and Safe Deployment

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture
**Resolves:** GAP-005

### Context

Target services change their login flows. A profile that works today may break tomorrow. Without versioning and safe deployment, a broken profile update takes down all orgs using that service simultaneously with no rollback.

### Decision

Semantic versioning per profile with a staging → canary → production promotion pipeline.

### Profile Version Model

```
ServiceProfile:
  profile_id: "salesforce-standard"       // immutable identifier
  version: "2.1.0"                         // semver
  version_state: "staging" | "canary" | "active" | "retired"
  parent_version: "2.0.0"                 // what this version replaces
```

**Version state machine:**

```
STAGING ──→ CANARY ──→ ACTIVE ──→ RETIRED
   │           │          │
   │           │          └──→ ACTIVE (rollback: re-activate previous)
   │           └──→ STAGING (canary failed: pull back)
   └──→ (deleted, never deployed)
```

### Deployment Pipeline

```
Step 1: STAGING
  • New profile version created via admin API
  • Validated in staging environment (discovery mode, login test)
  • No production traffic

Step 2: CANARY
  • Promoted to canary: assigned to 1 specific org (the profile author's org)
  • Production traffic for that org only
  • Monitored for: login success rate, health predicate pass rate, friction score
  • Duration: configurable (default 24 hours)
  • MINIMUM TRAFFIC THRESHOLD: at least 3 login attempts before canary can promote
    (RT-05: prevents 0/0 = pass with zero traffic)
  • Auto-rollback trigger: login failure rate > 20% in any 1-hour window
    (only evaluated when sample size >= 3)

Step 3: ACTIVE
  • Promoted to active: all orgs using this profile pick up the new version
  • Previous version moved to RETIRED (but retained for rollback)
  • Rollback: admin calls POST /admin/profiles/{id}/rollback → previous ACTIVE restored

Step 4: RETIRED
  • Retained for 30 days for rollback capability
  • Then archived (read-only, not assignable)
```

### Rollback Mechanism

Rollback is instantaneous because:
1. Both old and new versions exist in the database simultaneously.
2. Rollback flips the `version_state`: current ACTIVE → RETIRED, previous RETIRED → ACTIVE.
3. Active sessions continue with whatever version they started with.
4. New sessions and re-authentications pick up the rolled-back version.
5. No pod restart required — the worker reads profile config from the database at each login cycle.

### Consequences

- Profile entity gains `version`, `version_state`, `parent_version` columns.
- Admin API: `POST /admin/profiles/{id}/promote` (staging→canary→active) and `POST /admin/profiles/{id}/rollback`.
- Controller reconcile loop checks profile version_state when triggering logins.
- Canary evaluation runs as a scheduled check during the canary window.
- Auto-rollback publishes alert event + NATS notification.

---

## ADR-015: Startup Storm Prevention and Global Login Coordination

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture
**Resolves:** GAP-006

> **Note:** The staggered startup design is specified in ADR-012. This ADR covers the complementary **global login rate coordination** that prevents target-service overload under normal operation, not just startup.

### Decision

A **global login coordinator** that enforces system-wide and per-target-domain login rate limits.

### Design

```
Global Login Coordinator (runs in Controller):

  LIMIT 1: Max concurrent login flows system-wide
    default: 5
    purpose: bound total resource consumption

  LIMIT 2: Max concurrent login flows per target domain
    default: 3  (RT-06 amendment: was 1, increased — see below)
    purpose: prevent target service rate-limiting or lockout
    key: normalized root domain (e.g., "salesforce.com" for login.salesforce.com)

  LIMIT 3: Min interval between logins for same credential set
    default: 60 seconds
    purpose: prevent retry storms (also enforced at worker in ADR-012)

Implementation:
  PostgreSQL-backed queue (not Redis — must survive Redis outage)
  login_queue table:
    id SERIAL, tenant_id, profile_id, credential_set_id,
    target_domain, requested_at, started_at (nullable),
    completed_at (nullable), state (queued/running/done/failed)

  Controller reconcile loop checks queue every cycle:
    for each QUEUED entry (oldest first):
      if system_concurrent < LIMIT_1
        AND domain_concurrent(target_domain) < LIMIT_2
        AND last_login(credential_set) > LIMIT_3 ago:
          → mark RUNNING, trigger worker login
```

### Amendment: Per-Domain Concurrency Limit (RT-06)

**Problem:** Max 1 concurrent login per target domain × 50 tenants × ~60s login time = 50-minute queue for Salesforce at startup. This is unacceptable.

**Analysis:** Enterprise web services like Salesforce, ServiceNow, and SAP handle millions of logins per hour. 3-5 concurrent logins from the same IP are well within normal traffic patterns. Rate limiting and anti-bot detection triggers at 10-20+ concurrent from a single source, not at 3.

**Resolution:** Default `GLOBAL_MAX_CONCURRENT_PER_TARGET_DOMAIN` increased from 1 to **3**. This is configurable per-domain in the service profile:

```
Per-domain concurrency config (in service_profile):
  login_concurrency_limit: 3    // default for most services
  // Can be overridden per profile:
  // salesforce-standard: 3 (large-scale service, handles concurrent logins)
  // legacy-intranet:     1 (fragile auth, must serialize strictly)
```

**Impact on startup:** 50 tenants × Salesforce at limit=3 → ~17 batches × ~60s = ~17 minutes. At limit=5 → ~10 batches × ~60s = ~10 minutes. Acceptable.

### Amendment: Event-Driven Queue Processing (RT-12)

**Problem:** login_queue is polled by the Controller reconcile loop. If reconcile_interval = 30s, queue processing has 30s worst-case latency. During normal operation, an agent's auth request → queue insert → 30s wait → login start is too slow.

**Resolution:** Add **PG LISTEN/NOTIFY** for immediate queue processing:

```
Queue insertion:
  INSERT INTO login_queue (...) → trigger NOTIFY login_queue_ready

Controller:
  LISTEN login_queue_ready
  On notification → immediately run queue processing step (outside reconcile cycle)
  Reconcile loop remains as fallback (catches missed notifications)

Result:
  Normal operation: ~0ms queue latency (event-driven)
  Degraded (missed notification): 30s max (reconcile loop fallback)
```

### Consequences

- New `login_queue` table in PostgreSQL (durability, not Redis).
- Controller reconcile loop gains queue processing step.
- PG LISTEN/NOTIFY provides event-driven queue processing with reconcile loop fallback.
- Login is no longer triggered directly — it's enqueued, then dequeued by the coordinator.
- Per-domain concurrency is configurable in service profile (default: 3).
- Metrics: `login_queue_depth`, `login_queue_wait_time_seconds`, `login_concurrent_total`, `login_concurrent_by_domain`.
- Startup staggering (ADR-012) feeds into this same queue with delay offsets.

---

## ADR-016: Worker Pod Security Baseline

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture
**Resolves:** GAP-008

### Context

Worker pods run untrusted browser sessions against external websites. They are the highest-risk component: they handle plaintext credentials, execute arbitrary web content, and make external network requests. Current security context is incomplete.

### Decision

Mandatory security baseline for all worker pods. No exceptions.

### Required Security Context

```yaml
securityContext:
  # Pod level
  runAsNonRoot: true
  fsGroup: 1000
  seccompProfile:
    type: RuntimeDefault

containers:
  - name: worker
    securityContext:
      runAsUser: 1000
      runAsGroup: 1000
      readOnlyRootFilesystem: true
      allowPrivilegeEscalation: false
      capabilities:
        drop: ["ALL"]
    volumeMounts:
      - name: tmp
        mountPath: /tmp
      - name: xvfb-tmp
        mountPath: /tmp/.X11-unix
      - name: chrome-data
        mountPath: /home/worker/.cache/chromium
      - name: dshm
        mountPath: /dev/shm
      - name: credentials
        mountPath: /var/run/secrets/browser-hitl
        readOnly: true
      - name: encryption-key
        mountPath: /var/run/secrets/encryption
        readOnly: true

  - name: novnc
    securityContext:
      runAsUser: 65534
      runAsGroup: 65534
      readOnlyRootFilesystem: true
      allowPrivilegeEscalation: false
      capabilities:
        drop: ["ALL"]

volumes:
  - name: tmp
    emptyDir: { sizeLimit: "500Mi" }
  - name: xvfb-tmp
    emptyDir: { medium: "Memory", sizeLimit: "10Mi" }
  - name: chrome-data
    emptyDir: { sizeLimit: "1Gi" }
  - name: dshm
    emptyDir: { medium: "Memory", sizeLimit: "256Mi" }
  - name: credentials
    secret:
      secretName: "{credential-secret-name}"
  - name: encryption-key
    secret:
      secretName: "tenant-key-{tenant-id}"
```

### Key Changes from Current State

| Control | Before | After | Impact |
|---------|--------|-------|--------|
| `readOnlyRootFilesystem` | `false` | `true` | Requires writable mounts for /tmp, Chrome cache, Xvfb socket |
| `allowPrivilegeEscalation` | unset (`true`) | `false` | Blocks privilege escalation exploits |
| `capabilities` | default Linux set | Drop ALL | Removes unnecessary kernel capabilities |
| `seccompProfile` | unset | `RuntimeDefault` | Restricts system calls to kernel default allowlist |
| `TENANT_ENCRYPTION_KEY` | Environment variable | K8s Secret volume mount | No longer visible in `kubectl describe pod` |
| Writable volumes | Implicit (writable rootfs) | Explicit emptyDirs with size limits | Bounded disk usage, no rootfs writes |
| `/dev/shm` | Default (64MB, read-only with readOnlyRootFilesystem) | Explicit emptyDir Memory mount (256Mi) | **RT-07: Chromium requires shared memory for rendering. Without this mount, Chromium crashes or produces rendering artifacts.** |

### Consequences

- Worker Docker image must support `readOnlyRootFilesystem` (write to /tmp and emptyDir mounts only).
- Chromium data dir explicitly mounted as emptyDir.
- `/dev/shm` explicitly mounted as in-memory emptyDir (256Mi) — **required for Chromium shared memory** (RT-07).
- Xvfb socket uses in-memory emptyDir.
- Encryption key loaded from file mount instead of env var — code change in artifact-extractor.
- Pod spec construction in `pod-manager.service.ts` updated.
- Size limits on emptyDirs prevent runaway disk consumption.

---

## ADR-017: Extraction Atomicity and Session Liveness

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture
**Resolves:** GAP-009

### Context

If the browser crashes during credential extraction, the system enters an inconsistent state: the session appears HEALTHY (last health check passed) but no credentials were exported. Agents that request credentials get a cache miss, trigger a login, but the session entity says HEALTHY so no login is triggered — deadlock.

### Decision

Two mechanisms: **atomic extraction with verification** and **a liveness heartbeat distinct from health predicates**.

### Atomic Extraction

Extraction is all-or-nothing. The artifact bundle is committed only if ALL extraction steps succeed:

```
1. Begin extraction transaction (in-memory)
2. Extract cookies         → temp buffer
3. Extract headers         → temp buffer
4. Extract CSRF            → temp buffer
5. Extract localStorage    → temp buffer (if configured)
6. Extract sessionStorage  → temp buffer (if configured)
7. Verify: all configured fields present and non-empty
8. Encrypt bundle
9. Upload to MinIO
10. Update database record
11. Publish NATS event
12. Update Redis cache

If ANY step (1-12) fails:
  → Log error with step number
  → Do NOT update cache, database, or publish event
  → Set extraction_state = "failed" on session
  → Next health check detects stale credentials → triggers re-extraction
```

**Key property:** If the agent reads from cache, it gets the PREVIOUS valid credentials (or no credentials). It never gets a partial or corrupted bundle.

### Liveness Heartbeat

Two independent health signals, tracked separately:

| Signal | Source | Frequency | Meaning |
|--------|--------|-----------|---------|
| **Health predicate** (existing) | Keepalive runner evaluates URL/DOM/network checks | Every `keepalive_interval` (300s) | "The browser session is authenticated and the target service is responding" |
| **Liveness heartbeat** (new) | Worker process writes timestamp to session entity | Every 30 seconds | "The worker process is alive, the browser is responding, the event loop is not frozen" |

```
Session health evaluation:
  predicate_healthy = last_health_check < now - (keepalive_interval × 2)
                      AND last_health_result = PASS
  process_alive     = last_heartbeat < now - 90s  (3 missed heartbeats)

  session is trustworthy ONLY IF predicate_healthy AND process_alive

  if NOT process_alive:
    → session state = UNHEALTHY (regardless of last predicate result)
    → credentials marked untrusted
    → re-provisioning triggered
```

**This breaks the deadlock:** If Chrome crashes, the heartbeat stops within 30 seconds. Controller detects missing heartbeat within 90 seconds. Session moves to UNHEALTHY. Re-provisioning triggers a new login. Agents that request credentials during this window get `503 session_unavailable` (not stale cached credentials from a dead session).

### Amendment: Heartbeat Must Run in Separate Async Loop (RT-13)

**Problem:** If the heartbeat runs on the same event loop as extraction, a long extraction (encrypt + upload = 30s+) blocks the heartbeat. Controller sees missing heartbeat → falsely concludes worker is dead → triggers re-provisioning of a healthy worker.

**Resolution:** The liveness heartbeat runs in a **dedicated `setInterval` loop**, separate from the extraction/keepalive pipeline:

```
Worker startup:
  1. Start heartbeat loop: setInterval(sendHeartbeat, 30_000)
     - sendHeartbeat() = single UPDATE sessions SET last_heartbeat = now() WHERE id = ?
     - Uses a SEPARATE database connection (not from the shared pool)
     - Catches errors silently (missing one heartbeat is fine — 3 must miss)
     - NEVER awaits any other operation — pure fire-and-forget

  2. Start keepalive loop: runs health predicates + extraction pipeline
     - This loop may block for 30s+ during extraction
     - Heartbeat continues independently on its own timer

  Key: setInterval on Node.js event loop runs between I/O callbacks.
  Even during heavy async extraction work, setInterval will fire as long as
  the event loop isn't blocked by synchronous CPU work.
```

**Edge case — synchronous CPU block:** AES-256-GCM encryption of a large artifact bundle could block the event loop for 100-500ms. This is well within the 30s heartbeat interval. If encryption routinely takes >1s, move it to a worker thread (`worker_threads`). For v1, this is not expected to be an issue.

### Consequences

- Worker writes `last_heartbeat` timestamp to session entity every 30 seconds (lightweight: single column UPDATE).
- Heartbeat runs in a **dedicated setInterval loop with its own DB connection**, independent of extraction pipeline.
- Controller reconcile loop checks `last_heartbeat` in addition to `last_health_result`.
- Extraction steps wrapped in try-catch with step-level error reporting.
- No partial artifact bundles can exist in MinIO (upload happens only after full encryption).
- Cache update happens only after MinIO upload succeeds.
- New session columns: `last_heartbeat` (timestamptz), `last_login_attempt_at` (timestamptz, for ADR-012).

---

## ADR-018: Log Sanitization Policy

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture
**Resolves:** GAP-012

### Context

Error messages are logged unsanitized. If a login DSL step fails on a URL containing query parameters (e.g., OAuth callback with `code=...`), the error message includes the full URL — credentials leak to log aggregators. Additionally, email addresses (PII) are logged in plaintext in audit records.

The system handles enterprise credentials across multiple services. Any credential material in logs creates a security liability that scales with log retention period and the number of people with log access.

### Decision

Mandatory log sanitization middleware applied at the logger level — all log output passes through sanitization before reaching any transport (stdout, file, log aggregator).

### Design

#### URL Redaction

All URLs in log output are processed through a redaction function:

```
Redaction rules for URLs:
  1. Query parameters matching sensitive patterns are replaced:
     code=*, token=*, key=*, secret=*, password=*, auth=*,
     access_token=*, refresh_token=*, client_secret=*, api_key=*
     → Replaced with: code=REDACTED

  2. Fragment identifiers (#...) containing tokens are stripped entirely.

  3. Basic auth in URLs (https://user:pass@host) → https://REDACTED:REDACTED@host

Example:
  Input:  "OAuth callback failed: https://login.salesforce.com/callback?code=abc123&state=xyz"
  Output: "OAuth callback failed: https://login.salesforce.com/callback?code=[REDACTED]&state=xyz"
```

#### PII Hashing

Email addresses in audit records are hashed for correlation without revealing the actual address:

```
Hashing rule:
  email → SHA-256(email + AUDIT_SALT)[:16]  (first 16 hex chars)
  Produces a deterministic 16-char identifier: same email always produces same hash
  AUDIT_SALT is a deployment-specific secret (not the JWT secret)

Usage in audit:
  "user_email": "a3f2b7c9d4e18106"  // correlatable within deployment, not reversible
```

#### Error Message Scrubbing

All error messages from external HTTP calls (Playwright, fetch, axios) are scrubbed:

```
Scrubbing rules:
  1. HTTP response bodies: truncated to first 200 chars, no credential fields
  2. Request headers: Authorization header value → "[REDACTED]"
  3. Cookie values: all values → "[REDACTED]", names preserved
  4. Stack traces: file paths preserved, inline values scrubbed
```

#### Implementation

The `JsonLoggerService` (existing) gains a `sanitize()` method called before `JSON.stringify()`:

```typescript
// Applied in JsonLoggerService.log(), .warn(), .error()
private sanitize(message: string, context?: object): [string, object] {
  return [
    this.redactUrls(this.scrubCredentials(message)),
    context ? this.deepSanitize(context) : context,
  ];
}
```

### Consequences

- All log output sanitized at the logger level — no per-callsite changes needed.
- URL query parameters matching sensitive patterns are redacted.
- Email addresses in audit records use salted SHA-256 hash prefix.
- Error messages from external HTTP calls are scrubbed.
- New deployment secret: `AUDIT_SALT` (256-bit).
- Performance: sanitization adds ~0.1ms per log line (regex-based). Negligible.
- **Required adversarial test:** Log a message containing credentials, verify credentials not present in output.

---

## ADR-019: Backup and Disaster Recovery Design

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture, Operations
**Resolves:** GAP-013

### Context

The spec doesn't address data loss scenarios. The system stores enterprise authentication credentials and audit records across 4 data stores (PostgreSQL, Redis, MinIO, NATS). Each has different durability characteristics and recovery requirements.

### Decision

Define explicit RPO (Recovery Point Objective) and RTO (Recovery Time Objective) targets per data store, with tested backup/restore procedures.

### RPO/RTO Targets

| Data Store | Data Classification | RPO | RTO | Strategy |
|-----------|-------------------|-----|-----|----------|
| **PostgreSQL** | Sessions, profiles, audit trail, tenants, users, agent clients | **1 hour** | **30 minutes** | Automated pg_dump every hour to MinIO + WAL archiving for point-in-time recovery |
| **Redis** | Ephemeral: cache, rate limits, locks, OTP relay | **N/A (ephemeral)** | **5 minutes** | No backup. System re-derives all state from PG on Redis restart. Cold start acceptable. |
| **MinIO** | Encrypted artifact bundles (AES-256-GCM) | **4 hours** | **1 hour** | Workers re-extract credentials on next keepalive cycle. Brief gap where agents get cache miss → triggers fresh extraction. |
| **NATS JetStream** | In-flight events (24h retention, file storage) | **Tolerable loss** | **2 minutes** | JetStream persistence is built-in. Consumers replay from last ack. Brief message loss during outage is acceptable. |

### PostgreSQL Backup Strategy

```
Tier 1: Automated pg_dump (existing CronJob, enhanced)
  Schedule: Every 1 hour
  Target: MinIO bucket "pg-backups/{date}/{timestamp}.sql.gz"
  Retention: 7 daily, 4 weekly, 3 monthly
  Encryption: AES-256-GCM before upload (reuse TENANT_ENCRYPTION_KEY infrastructure)
  Validation: After each dump, run pg_restore --list to verify archive integrity

Tier 2: WAL Archiving (production only, managed PG recommended)
  For managed PostgreSQL (RDS, CloudSQL): enable automated backups + point-in-time recovery
  For self-managed: configure archive_command to ship WAL segments to MinIO
  Enables recovery to any point within the retention window

Tier 3: Logical replication (Dedicated tier only, ADR-008)
  Read replica for reporting/analytics
  Doubles as warm standby for failover
```

### Redis Recovery Procedure

Redis state is entirely ephemeral and re-derivable. On Redis restart:

```
1. RedisHealthMonitor detects HEALTHY state
2. Credential cache: EMPTY → next agent request triggers fresh extraction from MinIO/worker
3. Rate limit counters: RESET to 0 → briefly more permissive, self-corrects within 1 minute
4. Circuit breaker state: RESET to CLOSED → briefly allows all requests, self-corrects on failure
5. Coalescing locks: CLEARED → next login request acquires fresh lock
6. OTP relay: LOST → operator must re-send OTP (operational inconvenience, not data loss)
7. Token blacklist: EMPTY → revoked tokens temporarily accepted until Redis TTLs re-populate
   MITIGATION: Short-lived tokens (1h) limit window. Emergency revocation: rotate JWT secret.
```

**Key design principle:** Redis is a cache and coordination layer, NEVER a primary data store. All durable state lives in PostgreSQL. Redis loss = temporary degradation, not data loss.

### DR Runbook Section

Added to operational runbook (not this ADR):
- Step-by-step restore from pg_dump
- Redis cold start procedure
- MinIO bucket recovery
- Full system restore validation checklist
- Contact escalation matrix

### Consequences

- pg_dump CronJob enhanced: hourly schedule, MinIO target, encryption, validation.
- Backup retention policy: 7 daily / 4 weekly / 3 monthly.
- Redis explicitly documented as ephemeral — no backup required.
- MinIO artifacts regenerated by workers on demand — no backup required for v1.
- New operational runbook section for DR procedures.
- **Required test:** Restore from pg_dump backup → verify all entities intact → verify system functional.

---

## ADR-020: Observability Specification

**Status:** ACCEPTED
**Date:** 2026-02-21
**Deciders:** Solution Architecture
**Resolves:** GAP-014

### Context

ADR-006 defines a 7-stage pipeline but specifies no distributed tracing, stage-level metrics, or request ID propagation. Debugging a slow or failed auth request requires correlating logs across 5+ services manually. Production operations require observability to diagnose issues, monitor SLAs, and detect anomalies.

### Decision

Structured observability at three levels: **request tracing**, **stage-level metrics**, and **operational dashboards**.

### Part 1: Request ID Propagation

Every inbound request receives a unique `X-Request-Id` header (generated if not provided):

```
Flow:
  Agent → POST /auth/request (X-Request-Id: req_abc123)
    → API logs: {request_id: "req_abc123", stage: "admission", ...}
    → NATS message header: request_id = "req_abc123"
    → Worker logs: {request_id: "req_abc123", stage: "extraction", ...}
    → Response: X-Request-Id: req_abc123

Correlation:
  grep "req_abc123" across all service logs → full request timeline
```

Implementation: NestJS middleware that reads or generates `X-Request-Id`, stores in `AsyncLocalStorage` (cls-hooked), and includes in all log output via `JsonLoggerService`.

### Part 2: Stage-Level Metrics

Latency histograms for each stage of the 7-stage pipeline (ADR-006):

```
Metrics (all Prometheus histograms with labels):

  # Per-stage latency
  hitl_auth_request_stage_duration_seconds{stage, tenant_id, profile_id, outcome}
    stages: admission, cache_lookup, coalesce_check, subscriber_wait,
            login_dsl, extraction, total

  # Queue metrics (ADR-015)
  hitl_login_queue_depth{target_domain}
  hitl_login_queue_wait_seconds{target_domain}

  # Credential cache
  hitl_credential_cache_hit_total{tenant_id, profile_id, result}  // hit, miss, degraded
  hitl_credential_extraction_duration_seconds{profile_id, outcome}

  # Session health
  hitl_session_heartbeat_age_seconds{session_id}
  hitl_session_health_state{session_id, state}  // HEALTHY, UNHEALTHY, etc.

  # Redis health
  hitl_redis_health_state  // 0=healthy, 1=degraded, 2=down
  hitl_redis_operation_duration_seconds{operation, tier}
  hitl_redis_fallback_total{operation}  // count of MinIO fallbacks

  # Agent auth
  hitl_agent_token_issued_total{tenant_id}
  hitl_agent_token_rejected_total{tenant_id, reason}

  # Login coordination
  hitl_login_concurrent_total{target_domain}
  hitl_login_duration_seconds{profile_id, outcome}
```

### Part 3: OpenTelemetry Distributed Tracing (v1: Optional, v2: Required)

For v1, tracing is opt-in. Request ID correlation provides basic observability. Full OpenTelemetry integration is planned for v2:

```
v1 (implemented):
  - X-Request-Id propagation across all services
  - Structured JSON logs with request_id in every log line
  - Stage-level Prometheus metrics

v2 (planned):
  - OpenTelemetry SDK integration
  - W3C Trace Context propagation (traceparent header)
  - Spans for each pipeline stage
  - Jaeger/Tempo backend for trace visualization
  - Auto-instrumentation for HTTP, NATS, PostgreSQL, Redis
```

### Part 4: Operational Dashboard Specification

Minimum dashboard panels for production monitoring:

```
Dashboard: Auth Provider Overview
  Row 1: Request volume and latency
    - Auth requests/min (by tenant, profile)
    - P50/P95/P99 total latency
    - Error rate by stage

  Row 2: Login coordination
    - Login queue depth by domain
    - Concurrent logins by domain
    - Login duration distribution

  Row 3: Session health
    - Sessions by state (HEALTHY, UNHEALTHY, etc.)
    - Heartbeat freshness (max age across all sessions)
    - Credential extraction success rate

  Row 4: Infrastructure
    - Redis health state
    - Redis operation latency by tier
    - Cache hit rate
    - MinIO fallback rate

  Row 5: Security
    - Agent token issuance rate
    - Token rejection rate by reason
    - Rate limit hits
    - Emergency mode activations
```

### Consequences

- `X-Request-Id` middleware in NestJS with `AsyncLocalStorage`.
- `JsonLoggerService` includes `request_id` in all log output.
- NATS message headers carry `request_id` for cross-service correlation.
- ~15 new Prometheus metrics covering all pipeline stages.
- Dashboard JSON template for Grafana (importable).
- OpenTelemetry deferred to v2 — X-Request-Id correlation is sufficient for v1.

---

## ADR-021: Dual-Mode Browser Streaming (VNC and CDP)

**Status:** ACCEPTED
**Date:** 2026-02-22
**Deciders:** Solution Architecture
**Relates to:** ADR-016 (Worker Pod Security Baseline)

### Context

The system observes live browser sessions so human operators can perform HITL (Human-in-the-Loop) actions: viewing the browser, entering OTP codes, solving CAPTCHAs, and verifying login state. The original architecture uses a VNC-based streaming chain:

```
VNC Mode (original):
  Worker Pod:
    Chromium (headless: false)
      → DISPLAY=:99 → Xvfb (virtual framebuffer)
        → x11vnc (VNC server on :5900)
          → websockify sidecar container (:6080, WebSocket-to-TCP bridge)
            → API VncWsProxyService (TCP pipe to sidecar:6080)
              → Browser: noVNC RFB client
```

This works reliably but requires **3 extra processes per pod** (Xvfb, x11vnc, websockify) and a **dedicated sidecar container**. Chrome DevTools Protocol (CDP) offers a lighter alternative: Chromium's built-in `Page.startScreencast` sends JPEG frames over a WebSocket, and `Input.dispatch*Event` commands handle keyboard/mouse input — no X11 stack or sidecar needed.

### Options Considered

| Option | Description | Containers per Pod | Extra Processes | Pros | Cons |
|--------|-------------|-------------------|----------------|------|------|
| **(A) VNC only** | Keep existing architecture | 2 (worker + novnc sidecar) | 3 (Xvfb, x11vnc, websockify) | Proven, reliable, high-quality video | Higher resource usage, more attack surface |
| **(B) CDP only** | Replace VNC with CDP screencast | 1 (worker only) | 0 | Lighter, fewer processes, smaller attack surface | Screencast quality/FPS may be lower, less mature |
| **(C) Dual-mode, per-app** | Support both modes, configured per application via `browser_policy.streaming_mode` | 1 or 2 depending on mode | 0 or 3 depending on mode | Flexibility, backward-compatible, operators choose the right trade-off | More code paths to maintain |

### Decision

**(C) Dual-mode, per-app.** Each application configures `browser_policy.streaming_mode` as `"vnc"` (default) or `"cdp"`. The system provisions the correct pod shape and streaming chain based on this setting. No database migration needed (JSONB column in `browser_policy`).

### Architecture: VNC vs CDP

```
VNC Mode (headed, default):
  Worker Pod [2 containers]:
    ┌─────────────────────────────────────────────────┐
    │ worker container                                │
    │   Xvfb (:99) → x11vnc (:5900)                  │
    │   Chromium (headless: false, DISPLAY=:99)       │
    │   Node.js worker process                        │
    ├─────────────────────────────────────────────────┤
    │ novnc sidecar container                         │
    │   websockify (:6080 → :5900)                    │
    └─────────────────────────────────────────────────┘
         │
         ▼ WebSocket (RFB protocol)
    API: VncWsProxyService (TCP pipe to sidecar:6080)
         │
         ▼
    Browser: noVNC canvas (RFB client)


CDP Mode (headless):
  Worker Pod [1 container]:
    ┌─────────────────────────────────────────────────┐
    │ worker container                                │
    │   Chromium (headless: true, --remote-debugging  │
    │            -port=9222, localhost only)           │
    │   CDP Relay Server (:9223, 0.0.0.0)             │
    │   Node.js worker process                        │
    └─────────────────────────────────────────────────┘
         │
         ▼ WebSocket (CDP JSON messages)
    API: CdpWsProxyService (message-level filtering)
         │
         ▼
    Browser: HTML5 Canvas viewer
             (JPEG frames from Page.screencastFrame)
             (Input.dispatch*Event for keyboard/mouse)
```

### Security Model

CDP mode exposes Chromium's DevTools Protocol, which provides arbitrary code execution via `Runtime.evaluate`. The security model is built on **strict whitelisting** — only explicitly allowed commands and events pass through.

| Risk | Mitigation | Enforcement Point |
|------|-----------|-------------------|
| Command injection (`Runtime.evaluate`, `Target.*`) | **Inbound command whitelist** — only 6 commands allowed | CDP Relay Server (worker) + CdpWsProxyService (API) |
| Event leakage (domains auto-send events on enable) | **Outbound event whitelist** — only 2 events forwarded | CDP Relay Server (worker) + CdpWsProxyService (API) |
| Malformed JSON / oversized frames | Parse + validate every message; reject > 64KB | Both relay and proxy |
| Raw TCP pipe bypass | **Must NOT** use `socket.pipe()` — every message inspected individually | CdpWsProxyService (API) |
| DevTools keyboard shortcuts (F12, Ctrl+Shift+I) | `--disable-dev-tools` in CHROMIUM_FLAGS | Worker entrypoint |
| Screencast parameter exhaustion | Enforce limits: quality <= 80, maxWidth <= 1920, maxHeight <= 1080 | `sanitizeScreencastParams()` in shared whitelist |
| CDP session targeting | Pin to single page session; reject `Target.*` domain | CDP Relay Server |

**Allowed CDP commands (client -> Chromium):**

| Command | Purpose |
|---------|---------|
| `Page.startScreencast` | Begin JPEG frame streaming |
| `Page.stopScreencast` | Stop frame streaming |
| `Page.screencastFrameAck` | Acknowledge receipt of frame (flow control) |
| `Input.dispatchKeyEvent` | Keyboard input |
| `Input.dispatchMouseEvent` | Mouse input |
| `Input.dispatchTouchEvent` | Touch input |

**Allowed CDP events (Chromium -> client):**

| Event | Purpose |
|-------|---------|
| `Page.screencastFrame` | JPEG frame data (base64 encoded) |
| `Page.screencastVisibilityChanged` | Tab visibility change |

All other commands and events are silently dropped. Connection is terminated if a blocked command is sent more than 3 times.

### Resource Comparison (Measured)

E2E proof-of-life test on Kind cluster, same workload (test-harness login + dashboard authentication):

| Metric | VNC Mode | CDP Mode | Savings |
|--------|----------|----------|---------|
| Containers per pod | 2 (worker + novnc) | 1 (worker) | 1 fewer |
| Extra processes | 3 (Xvfb, x11vnc, websockify) | 0 | 3 fewer |
| CPU request | 1100m | 1000m | 100m (9%) |
| Memory request | 2176Mi | 2048Mi | 128Mi (6%) |
| CPU limit | 2100m | 2000m | 100m |
| Memory limit | 4224Mi | 4096Mi | 128Mi |
| Network hops (pod-internal) | 3 (Xvfb->x11vnc->websockify) | 1 (CDP relay) | 2 fewer |
| Chromium mode | headed (`headless: false`) | headless (`headless: true`) | Lower GPU/rendering overhead |

At scale (100 worker pods), CDP mode saves: 10 CPU cores, 12.5 GiB memory, 100 sidecar containers, 300 processes.

### Component Changes

**Shared package (`packages/shared`):**
- `StreamingMode` enum: `'vnc' | 'cdp'`
- `CDP_PORTS`: relay (9223), internal (9222)
- `CDP_LIMITS`: max frame size, screencast bounds
- `cdp-whitelist.ts`: command/event allow-lists, `sanitizeScreencastParams()`

**Worker (`apps/worker`):**
- `cdp-relay-server.ts`: WebSocket relay on :9223, connects to Chromium CDP on :9222, filters commands/events
- `main.ts`: conditional `headless: true/false` based on `STREAMING_MODE` env var; conditional CDP relay startup
- `worker-entrypoint.sh`: skips Xvfb + x11vnc when `STREAMING_MODE=cdp`

**Controller (`apps/controller`):**
- `pod-manager.service.ts`: conditional pod spec (1 vs 2 containers), CDP service CRUD, NetworkPolicy port selection (9223 vs 6080)
- `reconcile.service.ts`: mode-aware service creation/cleanup

**API (`apps/api`):**
- `StreamProviderFactory`: resolves VNC or CDP provider based on `app.browser_policy.streaming_mode`
- `CdpStreamProvider`: CDP implementation of `BrowserStreamProvider`
- `CdpWsProxyService`: message-level WebSocket proxy with whitelist filtering (NOT pipe)
- `CdpStreamingController`: serves HTML5 canvas viewer at `/cdp/:sessionId`
- `HitlService`: uses `StreamProviderFactory` instead of direct `VncStreamProvider`

### Configuration

Per-application, in `browser_policy` JSONB:

```json
{
  "browser_policy": {
    "streaming_mode": "cdp",
    "viewport": { "width": 1920, "height": 1080 }
  }
}
```

Default is `"vnc"` for full backward compatibility. No database migration required — `browser_policy` is an existing JSONB column that accepts arbitrary keys.

### When to Use Each Mode

| Use Case | Recommended Mode | Rationale |
|----------|-----------------|-----------|
| Standard HITL observation | VNC | Higher frame rate, smoother video, proven reliability |
| Resource-constrained clusters | CDP | Fewer processes, less memory, no sidecar |
| High-density deployments (>50 pods) | CDP | Significant aggregate resource savings |
| Air-gapped or minimal images | CDP | No X11 stack required |
| Complex visual debugging | VNC | Full-fidelity headed rendering |

### Consequences

- Worker pods conditionally provision 1 or 2 containers based on streaming mode.
- CDP mode removes the X11 display stack entirely — no Xvfb, no x11vnc, no websockify sidecar.
- Both modes produce identical session behavior: login, health checks, credential extraction, OTP relay all work the same.
- Streaming mode is per-application, not per-session — all sessions for an app use the same mode.
- Mode switch requires pod recreation (new pod spec), not live reconfiguration.
- CDP relay server adds ~2MB to worker memory footprint (ws library + message buffers).
- Both modes verified via E2E proof-of-life: identical screenshots at login and authenticated states.

### Verification Evidence

Dual-mode E2E test (2026-02-22): 16/16 checks PASS.

| Screenshot | Mode | Stage | Content |
|-----------|------|-------|---------|
| `vnc_01_starting.png` | VNC | Login | OTP code entry page |
| `vnc_03_authenticated.png` | VNC | Authenticated | Dashboard: HEALTHY, logged in as admin@example.com |
| `cdp_01_starting.png` | CDP | Login | OTP code entry page (identical) |
| `cdp_03_authenticated.png` | CDP | Authenticated | Dashboard: HEALTHY, logged in as admin@example.com (identical) |

Both modes reach HEALTHY state, authenticate successfully, and produce visually identical output.

---

## Cross-ADR Interaction Analysis

### RT-15: Dual SPOF for Login Initiation

**Finding:** The login flow now touches BOTH PostgreSQL (login_queue from ADR-015, AuthRequest row lock from ADR-012) AND Redis (barrier 1 lock from ADR-012). Either being down blocks login initiation. This creates two SPOFs for the login path.

**Analysis:**

| Outage | Impact | Acceptable? |
|--------|--------|-------------|
| **Redis down** | Barrier 1 skipped (CONSISTENCY tier, grace → fail closed). Barrier 2 (PG) still works. login_queue still works. **Logins proceed** (slower, PG-only serialization). | **Yes.** Degraded but functional. |
| **PG down** | Barrier 2 fails. login_queue fails. AuthRequest entity unavailable. **Complete system outage.** | **Yes.** PG is the primary datastore — PG outage = complete outage is the accepted failure domain. |
| **Both down** | Everything fails. | Obvious. |

**Resolution:** This is acceptable. PostgreSQL is the single accepted SPOF for the entire system (sessions, profiles, users, audit — everything requires PG). Redis outage should NOT block logins if PG is healthy.

To ensure Redis outage doesn't block logins:
1. Barrier 1 (Redis lock) follows CONSISTENCY tier: grace period → safe default (lock not acquired → fall through to Barrier 2).
2. login_queue is PG-only — unaffected by Redis.
3. Credential cache falls through to MinIO — unaffected by Redis.
4. The only Redis-critical path is token blacklist (SECURITY tier, fail-closed). If an agent's token was revoked, they get 503 during Redis outage. Non-revoked agents continue normally.

**Net result:** Redis down = revoked tokens can't be validated (fail-closed, secure), everything else continues with degraded performance. This is the intended design of ADR-011's tiered failure modes.

### RT-16: CDP Mode and Worker Pod Security Baseline (ADR-016 × ADR-021)

**Finding:** ADR-016 defines the worker pod security baseline assuming the VNC architecture (2 containers, Xvfb socket volume, novnc sidecar security context). CDP mode (ADR-021) changes the pod shape.

**Analysis:**

| Security Control | VNC Mode | CDP Mode | Impact |
|-----------------|----------|----------|--------|
| `readOnlyRootFilesystem` | Both containers | Worker container only (no sidecar) | **Same or better** — fewer writable surfaces |
| `allowPrivilegeEscalation: false` | Both containers | Worker container only | **Same or better** |
| `capabilities: drop ALL` | Both containers | Worker container only | **Same or better** |
| Xvfb socket volume (`/tmp/.X11-unix`) | Required (Memory emptyDir) | **Not mounted** | **Better** — no X11 socket attack surface |
| `/dev/shm` mount (256Mi) | Required for headed Chromium rendering | Still required for headless Chromium shared memory | **Same** |
| novnc sidecar (runAsUser: 65534) | Present | **Absent** | **Better** — one fewer container to secure |
| Network exposure | Port 6080 (websockify) | Port 9223 (CDP relay) | **Same risk level** — different port, same NetworkPolicy enforcement |
| CDP relay attack surface | N/A | New WebSocket server on :9223 | **New risk** — mitigated by command/event whitelisting (ADR-021 security model) |

**Resolution:** CDP mode has a **smaller attack surface** than VNC mode (fewer processes, no X11 stack, no sidecar). The new CDP relay server is the only added surface, mitigated by strict whitelisting at two enforcement points (worker relay + API proxy). ADR-016's security baseline applies to the worker container in both modes; CDP mode simply omits the sidecar-specific controls that are no longer needed.
