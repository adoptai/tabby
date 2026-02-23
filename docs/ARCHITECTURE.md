# Architecture

## System Overview

Browser HITL is a Kubernetes-native microservice system for maintaining persistent authenticated browser sessions. When human intervention is needed (MFA, CAPTCHA, security challenges), the system pauses automation, notifies operators via Slack or Teams, provides a live browser stream (VNC or CDP), and resumes after the challenge is resolved.

## Component Diagram

```
                              Internet
                                 │
                          ┌──────┴──────┐
                          │   Ingress   │  (NGINX + TLS via cert-manager)
                          └──────┬──────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                   │
     ┌────────┴────────┐ ┌──────┴──────┐  ┌────────┴────────┐
     │    Admin UI     │ │   API :8080 │  │  Egress Proxy   │
     │    :3000        │ │             │  │  :3128          │
     └─────────────────┘ │  NestJS     │  │  FQDN allowlist │
                         │  20 modules │  └────────┬────────┘
                         │  15 entities│           │
                         └──────┬──────┘           │
                                │                  │
                 ┌──────────────┼──────────────┐   │
                 │              │              │   │
          ┌──────┴──────┐ ┌────┴────┐  ┌──────┴───┴──┐
          │ Slack Bot   │ │  NATS   │  │ Worker Pods  │
          │ Teams Bot   │ │  :4222  │  │ Playwright   │
          │ (service    │ │ JetStr. │  │ VNC or CDP    │
          │  token auth)│ └────┬────┘  └──────┬───────┘
          └─────────────┘      │              │
                        ┌──────┴──────┐       │
                        │ Controller  │───────┘
                        │ :8090       │  (reconciles pods)
                        │ reconciler  │
                        └──────┬──────┘
                               │
                 ┌─────────────┼─────────────┐
                 │             │             │
          ┌──────┴──────┐ ┌───┴────┐ ┌──────┴──────┐
          │ PostgreSQL  │ │ Redis  │ │   MinIO     │
          │ :5432       │ │ :6379  │ │   :9000     │
          │ 11 tables   │ │ OTP+   │ │ artifacts   │
          │ RLS+audit   │ │ tokens │ │ encrypted   │
          └─────────────┘ └────────┘ └─────────────┘
```

## Data Flow: HITL Lifecycle

```
1. Controller detects session needs login
   → session state: STARTING → LOGIN_IN_PROGRESS
   → NATS: session.state.changed

2. Worker runs login DSL, encounters MFA challenge
   → session state: LOGIN_IN_PROGRESS (awaiting OTP)
   → NATS: hitl.otp-requested
   → Intervention record created

3. Bot receives NATS event, sends Slack/Teams message
   → Operator clicks "Take Over"
   → POST /sessions/:id/takeover → baton: HUMAN_CONTROL

4. Operator views VNC stream, enters OTP
   → POST /sessions/:id/otp → OTP stored in Redis (60s TTL)
   → Worker reads OTP from Redis, types into browser

5. Login succeeds
   → session state: LOGIN_IN_PROGRESS → HEALTHY
   → Baton: HUMAN_CONTROL → HUMAN_RELEASED → AUTOMATION_CONTROL
   → NATS: hitl.completed (outcome: SUCCESS)
   → Intervention record completed

6. Worker extracts artifacts (cookies, headers, tokens)
   → AES-256-GCM encryption with tenant key
   → Upload to MinIO
   → NATS: auth.bundle.exported

7. Keepalive loop maintains session health
   → Periodic health checks (URL, DOM, network)
   → Policy evaluation (all/any/quorum)
   → Artifact refresh on schedule
```

## Session State Machine

```
              ┌──────────┐
     ┌───────→│ STARTING │──────────┐
     │        └────┬─────┘          │
     │             │                │
     │     ┌───────┴───────┐       │
     │     ↓               ↓       ↓
  ┌──┴────────┐     ┌────────────┐ │
  │ HEALTHY   │←──→│ UNHEALTHY  │ │
  └───┬───────┘     └─────┬──────┘ │
      │                   │        │
      │            ┌──────┴──────┐ │
      │            │LOGIN_NEEDED │ │
      │            └──────┬──────┘ │
      │                   │        │
      │         ┌─────────┴────────┘
      │         ↓
      │  ┌──────────────────┐
      │  │LOGIN_IN_PROGRESS │────→ HEALTHY
      │  └────────┬─────────┘
      │           │
      │     ┌─────┴─────┐
      └────→│  FAILED   │
            └─────┬─────┘
                  │ (acknowledge)
                  ↓
            ┌───────────┐
            │TERMINATED │  (terminal)
            └───────────┘
```

**Retry matrix**: STARTING (3 retries, backoff), UNHEALTHY_TRANSIENT (3), UNHEALTHY_AUTH (1, no backoff), LOGIN_IN_PROGRESS (3), FAILED (0 — requires operator acknowledgement).

**Backoff**: base 30s, multiplier 2x, max 30 min, max 5 login attempts per hour.

## Database Schema

```
tenants ─────────────── users ───── user_identities
    │                     │
    └──── applications    │
              │           │
              └── sessions ──── session_batons
                    │                │
                    ├── interventions │
                    │                │
                    └── artifact_bundles ── artifact_consumptions

audit_events ── audit_anchors (daily integrity)
```

**15 tables** with TypeORM entities. PostgreSQL RLS for tenant isolation. 9 migrations with down() rollback methods.

Additional tables added in Phase 5: `agent_clients` (OAuth 2.0), `auth_requests` (request coalescing), `login_queue` (startup storm prevention), `service_profiles` (versioned credential configs).

Key columns added during security hardening:
- `users.failed_login_count` (int, default 0)
- `users.locked_until` (timestamptz, nullable)

## NATS JetStream Topology

**Streams:**
- `HITL_EVENTS` — HITL lifecycle: otp-requested, started, completed
- `SESSION_EVENTS` — Session state changes, auth bundle exports

**Subject patterns** (tenant-scoped):
```
hitl.otp-requested.{tenantId}.{sessionId}
hitl.started.{tenantId}.{sessionId}
hitl.completed.{tenantId}.{sessionId}
session.state.changed.{tenantId}.{sessionId}
auth.bundle.exported.{tenantId}.{appId}
```

**Durability**: `sync_interval: always` (Jepsen-validated). No exceptions.

**Authentication**: Token-based in production (`nats.auth.enabled: true`).

## Worker Pod Architecture

Workers support two streaming modes, configured per-application via `browser_policy.streaming_mode`.

### VNC Mode (headed, 2 containers)

```
┌─────────────────────────────────────────┐
│ Worker Pod                              │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │ Main Container                   │  │
│  │  Xvfb (virtual framebuffer)     │  │
│  │  x11vnc :5900 (localhost only)  │  │
│  │  Playwright (Chromium headed)   │  │
│  │  Login DSL Runner               │  │
│  │  Keepalive Runner               │  │
│  │  Health Predicate Evaluator     │  │
│  │  Artifact Extractor             │  │
│  │  OTP Relay (Redis poll)         │  │
│  │  Recycling Monitor              │  │
│  │  Health Server :8091            │  │
│  └──────────────────────────────────┘  │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │ noVNC Sidecar :6080             │  │
│  │ (WebSocket → VNC proxy)         │  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### CDP Mode (headless, 1 container)

```
┌─────────────────────────────────────────┐
│ Worker Pod                              │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │ Single Container                 │  │
│  │  Playwright (Chromium headless)  │  │
│  │  CDP Relay Server :9223          │  │
│  │  Login DSL Runner               │  │
│  │  Keepalive Runner               │  │
│  │  Health Predicate Evaluator     │  │
│  │  Artifact Extractor             │  │
│  │  OTP Relay (Redis poll)         │  │
│  │  Recycling Monitor              │  │
│  │  Health Server :8091            │  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

No X11 stack, no sidecar. CDP relay filters commands/events through strict whitelists (6 commands, 2 events). `Target.*` domain rejected. 64KB frame limit.

**Browser hardening**: 15 Chromium flags (no sandbox, disable extensions, mute audio, etc.). Egress proxy support via `EGRESS_PROXY_URL`.

**Credential resolution**: K8s Secret mount at `/var/run/secrets/browser-hitl/{secretName}/`. Env var fallback opt-in via `WORKER_ALLOW_ENV_CREDENTIAL_FALLBACK`.

## Security Architecture

### Authentication
- JWT with `jti` claim (UUID) on every token
- Redis-backed blacklist for revocation (TTL matches token remaining lifetime)
- bcrypt cost 12, password complexity (12+ chars, mixed case, digit, special)
- Account lockout: 5 failures → 15 min lock
- Service token auth for bots (client_id + client_secret, no admin credential fallback)
- OAuth 2.0 Client Credentials for agent authentication (HMAC-SHA256)

### Authorization
- RBAC: Admin, Operator, Viewer, Agent
- `@Roles` decorator + `RolesGuard` on all controller endpoints
- Viewers: stream only. Operators: stream + HITL actions. Admins: all.

### Data Protection
- AES-256-GCM encryption for artifacts (per-tenant key)
- Redis TTL for OTP (60s), stream tokens (600s), artifact tokens (600s)
- Presigned URLs for artifact download (time-limited)

### Network Security
- Kubernetes NetworkPolicies for all services (gated by `networkPolicies.enabled`)
- NATS token auth (gated by `nats.auth.enabled`)
- TLS via cert-manager (production only)
- Egress proxy with FQDN allowlist
- No sensitive data in NATS subjects

### Audit Trail
- Append-only event log with SHA-256 hash chain
- `pg_advisory_lock(42)` for chain serialization
- Daily anchor records for integrity verification

### Observability
- Structured JSON logging (`JsonLoggerService`, auto JSON in production)
- Prometheus metrics via prom-client (counters, histograms, gauges + Node.js defaults)
- PrometheusRule alerting templates (session failures, HITL SLA, pod health)
- Bearer token auth on `/metrics` endpoint with timing-safe comparison

## Deployment Architecture

### Kubernetes Resources (26 templates)

| Type | Resources |
|------|-----------|
| Deployments | API, Controller, Admin UI, Slack Bot, Teams Bot, Egress Proxy, Redis |
| StatefulSets | PostgreSQL, NATS, MinIO |
| Services | API, Controller, Admin UI, PostgreSQL, Redis, NATS, MinIO, Egress Proxy |
| Dynamic Pods | Worker (created by Controller per session) |
| CronJobs | pg_dump backup (production only) |
| NetworkPolicies | API, Controller, PostgreSQL, Redis, NATS |
| PrometheusRules | Session health, HITL SLA, infrastructure alerts |
| Ingress | NGINX with optional TLS |

### Helm Values Tiers

| Setting | Local | Production |
|---------|-------|------------|
| Replicas | 1 | 2+ (API), 3 (NATS) |
| TLS | Disabled | cert-manager |
| NATS auth | Disabled | Required |
| Network policies | Disabled | Enabled |
| Backups | Disabled | Daily at 2am UTC |
| Alerting | Disabled | Enabled |
| Secrets | Dev placeholders | Empty (must set) |
| Log format | Text | JSON |

## CI/CD Pipeline

```
lint → sca → test → build → sbom → e2e → publish
  │      │      │      │       │      │       │
  │      │      │      │       │      │       └─ Tag + cosign sign (main only)
  │      │      │      │       │      └─ k3d cluster + Helm + smoke tests
  │      │      │      │       └─ CycloneDX + cosign attach
  │      │      │      └─ Docker build-push (7 images, GHA cache)
  │      │      └─ Jest (PostgreSQL + Redis services)
  │      └─ pnpm audit (non-blocking)
  └─ tsc --noEmit (all packages)
```
