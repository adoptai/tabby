# Browser HITL — Architecture & Production Readiness Assessment

## System Overview

Browser HITL is a Kubernetes-native microservice platform for maintaining persistent authenticated browser sessions with human-in-the-loop (HITL) intervention support. It solves the problem of credential delegation for services that require interactive login (MFA, CAPTCHA, SSO federation) by keeping headless browser sessions alive and extracting fresh credentials on demand.

**Core value proposition:** An agent requests credentials for "Salesforce" → the system either returns cached credentials from a live browser session or orchestrates a fresh login (including OTP relay from a human operator) and returns decrypted, structured credentials.

---

## Service Map (7 services)

```
                                ┌──────────────┐
                                │   Admin UI   │ :3000
                                │  (static JS) │
                                └──────┬───────┘
                                       │
                  ┌────────────────────┼─────────────────────┐
                  │                    │                      │
           ┌──────▼──────┐     ┌──────▼──────┐       ┌──────▼──────┐
           │  Slack Bot   │     │    API      │       │ Teams Bot   │
           │  (NATS sub)  │     │  (NestJS)   │       │ (Bot Frmwk) │
           │  :no port    │     │  :8080      │       │ :3978       │
           └──────┬───────┘     └──┬───┬───┬──┘       └──────┬──────┘
                  │                │   │   │                  │
                  └────────┬───────┘   │   └───────┬──────────┘
                           │           │           │
                   ┌───────▼───────┐ ┌─▼───────┐ ┌─▼───────────┐
                   │     NATS      │ │  Redis  │ │ PostgreSQL  │
                   │  (JetStream)  │ │  (7)    │ │   (16)      │
                   │  :4222        │ │  :6379  │ │   :5432     │
                   └───────┬───────┘ └─────────┘ └──────┬──────┘
                           │                            │
                   ┌───────▼────────────────────────────▼──────┐
                   │              Controller                    │
                   │           (NestJS, :8090)                  │
                   │     Reconcile loop · Pod lifecycle         │
                   └──────────┬───────────────┬────────────────┘
                              │ creates/deletes│
               VNC mode       │               │       CDP mode
         ┌────────────────────▼──┐   ┌────────▼──────────────────┐
         │  Worker Pod (2 cont.) │   │  Worker Pod (1 container) │
         │ ┌────────┐ ┌───────┐ │   │ ┌────────────────────────┐ │
         │ │Chromium │ │ noVNC │ │   │ │ Chromium (headless)    │ │
         │ │+Xvfb   │ │sidecar│ │   │ │ + CDP Relay :9223      │ │
         │ │:8091   │ │:6080  │ │   │ │ :8091                  │ │
         │ └───┬────┘ └───────┘ │   │ └───────┬────────────────┘ │
         │     │                 │   │         │                  │
         │     ▼                 │   │         ▼                  │
         │  MinIO (blobs)        │   │  MinIO (blobs)             │
         │  :9000                │   │  :9000                     │
         └───────────────────────┘   └────────────────────────────┘
```

> **Streaming mode** is configured per-application via `browser_policy.streaming_mode` (`"vnc"` default, or `"cdp"`). VNC mode uses headed Chromium + Xvfb + x11vnc + websockify sidecar. CDP mode uses headless Chromium + built-in `Page.startScreencast` with a WebSocket relay — no X11 stack or sidecar needed.

### 1. API (`apps/api`) — NestJS 10, `:8080`

Central REST + WebSocket gateway. 16 modules, 13 controllers. Handles auth (JWT with revocation), multi-tenant RBAC, session orchestration, HITL coordination, artifact decryption, credential delivery, audit logging, Prometheus metrics.

### 2. Controller (`apps/controller`) — NestJS standalone, `:8090`

Kubernetes pod lifecycle manager. 15-second reconcile loop reads session table, creates/deletes worker pods to match desired state. Implements state machine transitions (7 states), retry with exponential backoff, and NATS event publishing.

### 3. Worker (`apps/worker`) — Node.js + Playwright, `:8091`

One pod per session. Supports two streaming modes:

- **VNC mode (headed):** Runs Chromium with `headless: false` in Xvfb virtual framebuffer. x11vnc exposes the display, websockify sidecar bridges to WebSocket. 2 containers, 3 extra processes. Operator views via noVNC RFB client.
- **CDP mode (headless):** Runs Chromium with `headless: true`. Built-in `Page.startScreencast` sends JPEG frames via a CDP relay server on `:9223`. 1 container, 0 extra processes. Operator views via HTML5 canvas. CDP commands/events filtered through strict whitelists (6 allowed commands, 2 allowed events).

Both modes: execute 15-action login DSL, manage OTP relay via Redis polling, run health predicate keepalive loop (300s), extract and encrypt artifacts (AES-256-GCM), upload to MinIO. Monitor memory watermark and session age for graceful recycling. Mode selected per-app via `browser_policy.streaming_mode`.

### 4. Slack Bot (`apps/slack-bot`) — NATS subscriber

Receives `hitl.otp-requested` events, posts interactive messages to Slack for operator OTP entry. Routes responses back to API.

### 5. Teams Bot (`apps/teams-bot`) — Bot Framework, `:3978`

Equivalent to Slack bot for Microsoft Teams channels.

### 6. Admin UI (`apps/admin-ui`) — Static JS, `:3000`

Dashboard for session monitoring, VNC takeover, artifact browsing.

### 7. Egress Proxy — HTTP proxy, `:3128`

FQDN-based allowlist for worker browser traffic. Prevents credential exfiltration.

---

## Data Layer

### PostgreSQL (15 entities, 9 migrations)

- **Core domain:** `tenants` → `applications` → `sessions` → `artifact_bundles` → `artifact_consumptions`
- **HITL:** `session_batons` (4-state baton machine), `interventions` (OTP/CAPTCHA tracking)
- **Security:** `users` (bcrypt, lockout fields), `agent_clients` (OAuth 2.0 client credentials, HMAC-SHA256), `audit_events` + `audit_anchors` (SHA-256 hash chain)
- **Operational:** `auth_requests` (request coalescing, ADR-002), `login_queue` (global login serialization, ADR-015), `service_profiles` (versioned credential configs, ADR-014)
- **Row-Level Security:** Enabled on `sessions`, `interventions`, `artifact_bundles`, `artifact_consumptions`, `auth_requests`, `audit_events` — all scoped by `tenant_id`.

### Redis

OTP relay (`otp:{sessionId}`, 60s TTL), JWT blacklist, stream tokens, artifact tokens, distributed locks (login serialization, extraction coalescing). 3-tier resilience model (HEALTHY → DEGRADED → DOWN) with DB fallback.

### NATS (JetStream)

2 streams: `HITL_EVENTS` (OTP requests, takeover) and `SESSION_EVENTS` (state changes, artifact exports). File-backed persistence. Subject patterns: `hitl.otp-requested.{tenantId}.{sessionId}`, `session.state.changed.*.*`.

### MinIO

Encrypted AES-256-GCM artifact blobs keyed `{tenantId}/{sessionId}/{timestamp}.enc`. Per-tenant encryption keys stored in K8s Secrets, key version tracked for rotation.

---

## Security Model

| Layer | Implementation |
|---|---|
| **AuthN** | JWT (human + service + agent), bcrypt cost 12, account lockout (5 failures → 15 min), OAuth 2.0 Client Credentials for agents |
| **AuthZ** | 4-role RBAC (Admin/Operator/Viewer/Agent) enforced on all 13 controllers |
| **Token Revocation** | Redis-backed `jwt_blacklist:{jti}` with TTL matching token expiry |
| **Data at Rest** | AES-256-GCM with per-tenant keys, key version tracking for rotation |
| **Data in Transit** | TLS via cert-manager (production), ClusterIP for internal traffic |
| **Network** | K8s NetworkPolicies (deny-all default, explicit whitelist), egress proxy FQDN allowlist |
| **Audit** | Immutable append-only log with SHA-256 hash chain + daily integrity anchors |
| **Secrets** | K8s Secret volume mounts (no env vars in prod), External Secrets Operator recommended |
| **Login Safety** | 3-barrier serialization (Redis lock → DB transaction → per-worker rate limit) preventing account lockout |
| **Browser Hardening** | 15 Chromium flags, disabled downloads/clipboard/file chooser, `--disable-dev-tools`, no `--remote-debugging` to external |
| **CDP Streaming Security** | Strict command/event whitelists (6 commands, 2 events), message-level inspection (no TCP pipe), 64KB frame limit, screencast parameter clamping, `Target.*` domain rejection |

40+ red team remediations completed and graded (S/A tier).

---

## Architecture Decision Records (21 ADRs)

Key decisions that shape the system:

| ADR | Decision | Why It Matters |
|-----|----------|----------------|
| 002 | Request coalescing via `auth_requests` table + Redis lock | 10 concurrent agent requests → 1 login (prevents lockout) |
| 010 | OAuth 2.0 Client Credentials for agents | Headless access without human JWT |
| 011 | Redis 3-tier resilience (HEALTHY/DEGRADED/DOWN) | System degrades gracefully, never hard-fails on Redis outage |
| 012 | 3-barrier login serialization | Defense-in-depth against concurrent logins to same account |
| 013 | Credential envelope with freshness + volatility | Agents know if credentials are CACHED vs EXTRACTED, which fields are VOLATILE |
| 014 | Profile versioning (STAGING→CANARY→ACTIVE) | Safe rollout of login DSL changes without breaking live sessions |
| 015 | PG-backed global login queue | Prevents "startup storm" (50 sessions all login simultaneously) |
| 021 | Dual-mode streaming (VNC + CDP) | Per-app choice: headed VNC (2 containers) or headless CDP (1 container, 9% less CPU, 6% less RAM) |

---

## Test Coverage

- **640 unit tests** across API (460), Controller (50), Worker (52), Shared (78)
- **E2E smoke test suite** (Python orchestrator, 25 checks across 3 categories passing)
  - **Category A:** Full happy path — login → OTP → HEALTHY → credential request → verified against test harness
  - **Category C:** Freshness — CACHED, ON_DEMAND, volatile filtering
  - **Category E:** Security — wrong profile 404, invalid JWT 401
  - **Category F:** CDP mode — pod shape (1 container, no sidecar), CDP service, stream URL, mode label
- **CDP proof-of-life test** (16/16 checks passing): simultaneous VNC + CDP worker pods, both authenticate through test harness, screenshots captured at login and authenticated stages for both modes
- **CI/CD:** GitHub Actions with lint → SCA → test → build → SBOM → e2e → publish pipeline

---

## Production Readiness Assessment

### What's Production-Ready

| Area | Status | Evidence |
|------|--------|----------|
| Core credential flow | Ready | E2E proven: login → extract → encrypt → store → decrypt → deliver → verify |
| Multi-tenant isolation | Ready | RLS on 6 tables, per-tenant encryption keys, RBAC on all endpoints |
| Authentication/Authorization | Ready | JWT + revocation + lockout + agent OAuth 2.0, 4-role RBAC |
| Login safety | Ready | 3-barrier serialization, request coalescing, global queue |
| Artifact encryption | Ready | AES-256-GCM, per-tenant keys, key versioning for rotation |
| Audit trail | Ready | SHA-256 hash chain, daily anchors, immutable append-only |
| Kubernetes manifests | Ready | Helm chart with 26 templates, 3 value tiers (local/staging/prod) |
| CI/CD pipeline | Ready | Full GitHub Actions with SBOM + cosign + e2e |
| HITL operator flow | Ready | Slack/Teams bots, VNC + CDP dual-mode streaming, baton state machine with timeouts |
| Browser streaming | Ready | Dual-mode: VNC (headed, noVNC client) and CDP (headless, canvas viewer), per-app config, E2E verified both modes |
| Docker images | Ready | 7 images, frozen lockfile, pinned Playwright version |

### What Needs Work Before Production

| Area | Gap | Effort | Risk |
|------|-----|--------|------|
| **TLS** | Disabled in default values; cert-manager annotations present but not configured | 1-2 hours | **HIGH** — no TLS = credentials in plaintext on wire |
| **NetworkPolicies** | Optional toggle, disabled by default in local | 30 min | **HIGH** — without them, any pod can talk to any pod |
| **NATS auth** | Token-based auth present but not enforced in local values | 30 min | MEDIUM — unauthenticated NATS allows event injection |
| **Secrets management** | `values-production.yaml` has empty strings; no ESO auto-deploy | 2-4 hours | **HIGH** — manual secret rotation is error-prone |
| **Monitoring/Alerting** | Prometheus metrics exposed, PrometheusRules templated, but no stack deployed | 4-8 hours | MEDIUM — flying blind without dashboards/alerts |
| **Load testing** | No documented load test; E2E covers 1 session | 1-2 days | MEDIUM — unknown behavior at 50+ concurrent sessions |
| **Penetration testing** | Red team was internal; no third-party pentest | 1-2 weeks | MEDIUM — 40+ remediations done but external validation recommended |
| **Backup validation** | CronJob template exists but restore procedure untested | 4 hours | MEDIUM — backup without tested restore is theater |
| **Multi-region/DR** | Single-region only; no documented RTO/RPO | Design phase | LOW for MVP, HIGH for enterprise |
| **HPA (auto-scaling)** | No HorizontalPodAutoscaler for worker pods | 2-4 hours | LOW — controller reconcile handles scaling, but no CPU-based auto-scale |

---

## Verdict

The system is architecturally sound and functionally complete for an MVP deployment. The 20 ADRs demonstrate careful thinking about the hard problems (account lockout prevention, credential freshness, startup storms). The security hardening (40+ remediations) is well above average for a system at this stage.

**For a controlled staging/pilot deployment:** Ready today. Enable TLS + NetworkPolicies, set real secrets, deploy monitoring.

**For general production with external tenants:** Needs 1-2 weeks of hardening — load testing, third-party pentest, backup validation, and operational runbook documentation.

**Architecture quality: 8.5/10** — The design is well-reasoned with defense-in-depth throughout. The main technical debt is the `--no-frozen-lockfile` pattern (now fixed) and some partial ADR implementations (14, 15) that are functional but could be more robust.
