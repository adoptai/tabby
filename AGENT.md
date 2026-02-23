# Browser HITL Implementation Guide

Reference document for AI agents and developers working on this codebase.

## Source of Truth Hierarchy

1. `specification_docs/MVP_BROWSER_SPEC_CODEX.md` (v6) — canonical specification
2. `implementation_tracker/` — task plan and sprint tracking
3. `docs/SPECIFICATION_DIVERGENCE.md` — where implementation differs from spec
4. `docs/internal/CLAUDE_RED_TEAM_REMEDIATIONS.md` — security hardening audit trail
5. `docs/ARCHITECTURE_DECISIONS.md` — **21 ADRs with reasoning** (read before proposing architectural changes)
6. `docs/HEADLESS_AUTH_PROVIDER_SPEC.md` — Headless Auth Provider workflow specification (the primary production use case)
7. `docs/SPEC_GAP_ANALYSIS.md` — Red team gap analysis (14 gaps, all resolved by ADRs)
8. `implementation_tracker/phase_5/` — Phase 5 (Auth Provider Hardening) task plan and execution log

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | NestJS | 10.x |
| ORM | TypeORM | 0.3.x |
| Database | PostgreSQL | 16 |
| Cache | Redis (ioredis) | 7 |
| Messaging | NATS JetStream | 2.10 |
| Object Storage | MinIO | S3-compatible |
| Browser | Playwright + Chromium | Headed (Xvfb) + Headless (CDP) |
| Streaming | noVNC (VNC mode) + CDP screencast (CDP mode) | Dual-mode, per-app config |
| Auth | Passport.js + JWT | bcrypt cost 12 |
| Validation | class-validator | DTO-based |
| Metrics | prom-client | Prometheus-compatible |
| Docs | @nestjs/swagger | OpenAPI 3.0 |
| Monorepo | pnpm + NX | Workspace protocol |
| Deployment | Helm 3 | K8s native |
| CI/CD | GitHub Actions | lint+test+build+sbom+e2e |

## Monorepo Structure

```
apps/
  api/           NestJS API (20 modules, 15 entities, 24 test suites)
  controller/    Session reconciler (pod lifecycle, state machine)
  worker/        Browser automation (Playwright, DSL runner, OTP relay)
  slack-bot/     Slack HITL bridge (soft polling, OTP forwarding)
  teams-bot/     Teams HITL bridge (Bot Framework adapter)
  admin-ui/      Admin dashboard (server.js)
packages/
  shared/        Types, constants, state machines, validators, env helpers
charts/
  browser-hitl/  Helm chart (26 templates, values + local + production tiers)
infra/
  docker/        Dockerfiles for 7 services
scripts/         E2E batches (Python), local setup scripts (bash)
docs/            Architecture, functional overview, divergence, security audit
```

## Critical Implementation Rules

1. **NATS sync_interval MUST be `always`** — Jepsen-validated durability guarantee. Never change.
2. **Password rules are in shared constants** — `PASSWORD_RULES.PATTERN` used in both DTO and service layer.
3. **All endpoints require JWT auth** except `/auth/login`, `/auth/bootstrap`, `/health/*`.
4. **DTOs enforce validation** — `whitelist: true`, `forbidNonWhitelisted: true` globally.
5. **Baton operations use pessimistic locks** — `lock: { mode: 'pessimistic_write' }` with CAS versioning.
6. **Metric names use underscores** — `hitl_latency_ms`, not `hitl.latency_ms` (Prometheus convention).
7. **Bot auth uses service tokens** — `/auth/service-token` with client_id/secret. No admin credential fallback.
8. **Secrets never have defaults in production** — `values-production.yaml` has empty strings for all secrets.
9. **Tests must fail if the fix is reverted** — S-tier requirement from red team grading rubric.
10. **CDP streaming whitelists are security-critical** — Only 6 CDP commands and 2 events are allowed through the relay. Adding commands requires security review. `Target.*` domain is always rejected.
11. **Streaming mode is per-application** — `browser_policy.streaming_mode` controls VNC vs CDP. Never assume one mode globally.
12. **Agent auth uses OAuth 2.0 Client Credentials** — `/auth/agent-token` with `client_id`/`client_secret` (HMAC-SHA256). Separate from human JWT flow.

## Database Schema (15 Tables)

| Table | Purpose |
|-------|---------|
| `tenants` | Multi-tenant organizations |
| `users` | User accounts (with `failed_login_count`, `locked_until`) |
| `user_identities` | OAuth/identity linking (Slack, Teams) |
| `applications` | App configurations (login DSL, keepalive, export policy, browser_policy) |
| `sessions` | Browser sessions (7-state machine) |
| `session_batons` | HITL baton state (4-state machine, CAS version) |
| `artifact_bundles` | Encrypted auth artifacts (AES-256-GCM) |
| `artifact_consumptions` | Artifact usage tracking |
| `interventions` | HITL intervention records (type, outcome, timing) |
| `audit_events` | Immutable audit log (SHA-256 hash chain) |
| `audit_anchors` | Daily integrity anchors |
| `agent_clients` | OAuth 2.0 client credentials for agent authentication (HMAC-SHA256) |
| `auth_requests` | Request coalescing for concurrent credential requests (ADR-002) |
| `login_queue` | Global login serialization to prevent startup storms (ADR-015) |
| `service_profiles` | Versioned credential configs with STAGING→CANARY→ACTIVE lifecycle (ADR-014) |

> **Note:** `pg_advisory_lock(42)` is used for audit hash chain serialization. It is a PostgreSQL advisory lock, not a table.

## Session State Machine

```
STARTING ──→ HEALTHY ──→ UNHEALTHY ──→ LOGIN_NEEDED ──→ LOGIN_IN_PROGRESS
    │            │            │               │                  │
    │            ↓            ↓               ↓                  ↓
    ├──→ FAILED ←────────────┘          TERMINATED          HEALTHY
    │      │                                                   │
    │      ↓                                                   ↓
    └──→ TERMINATED (terminal)                              FAILED
```

**Retry matrix**: STARTING (3), UNHEALTHY_TRANSIENT (3), UNHEALTHY_AUTH (1), LOGIN_IN_PROGRESS (3), FAILED (0 — requires operator acknowledgement).

## HITL Baton State Machine

```
AUTOMATION_CONTROL ──→ HUMAN_REQUESTED ──→ HUMAN_CONTROL ──→ HUMAN_RELEASED
       ↑                      │                                     │
       └──────────────────────┘ (timeout: 10min)                    │
       ↑                                                            │
       └────────────────────────────────────────────────────────────┘
```

Timeouts: HUMAN_REQUESTED=10min, HUMAN_CONTROL_INACTIVITY=5min.

## API Modules (20)

| Module | Controller Routes | Key Services |
|--------|------------------|--------------|
| Auth | `/auth/login`, `/auth/logout`, `/auth/service-token` | AuthService, TokenBlacklistService |
| Bootstrap | (startup) | BootstrapService |
| Users | `/users` CRUD | UsersService |
| Tenants | `/tenants` CRUD | TenantsService |
| Apps | `/apps` CRUD | AppsService |
| Sessions | `/sessions/scale`, `/sessions` | SessionsService |
| HITL | `/sessions/:id/{stream,takeover,release,otp,acknowledge}` | HitlService |
| Streaming | `/stream` WebSocket | VncWsProxyService, CdpWsProxyService, StreamTokenService |
| Artifacts | `/artifacts` | ArtifactsService |
| Agent | `/agent/run-url` | AgentService |
| Credentials | `/credentials` | CredentialsService |
| Profiles | `/profiles` | ProfilesService |
| Login | (internal) | LoginQueueService, LoginSerializationService |
| Audit | (internal) | AuditService |
| Events | WebSocket `/events` | EventsGateway |
| Nats | (internal) | NatsService |
| Redis | (internal) | RedisService (3-tier resilience) |
| Lifecycle | (scheduled) | LifecycleRetentionService |
| Observability | `/metrics` | ObservabilityService (prom-client) |
| Health | `/health/live`, `/health/ready` | HealthController |

## Ports

| Service | Port | Protocol |
|---------|------|----------|
| API | 8080 | HTTP + WS (`/events`) |
| Controller | 8090 | HTTP (health) |
| Worker | 8091 | HTTP (health) |
| CDP Relay | 9223 | WebSocket (CDP mode streaming) |
| noVNC | 6080 | HTTP + WS (VNC mode) |
| VNC | 5900 | VNC (localhost only, VNC mode) |
| PostgreSQL | 5432 | TCP |
| Redis | 6379 | TCP |
| NATS | 4222 | TCP |
| NATS Monitor | 8222 | HTTP |
| MinIO | 9000/9001 | HTTP |

## Test Coverage

640 tests across 34 suites in 4 packages (shared: 78, api: 460, worker: 52, controller: 50). Includes adversarial security tests that catch regressions if remediations are reverted. E2E smoke suite (Python orchestrator, 25 checks) covers full credential delivery chain and CDP mode verification.

Run: `pnpm nx run-many --target=test --all --parallel=3`

## What Requires Human Action

- Kubernetes cluster provisioning and DNS configuration
- Slack/Teams app creation and token generation
- cert-manager installation for TLS
- kube-prometheus-stack for alerting
- External Secrets Operator for production secret management
- Security sign-off and penetration testing
- E2E UAT execution with real browser sessions
