# Browser HITL

Kubernetes-native service stack for persistent authenticated browser sessions with human-in-the-loop intervention for MFA, CAPTCHA, and credential challenges.

**Core value proposition:** An agent requests credentials for a web service (e.g. Salesforce) → the system either returns cached credentials from a live browser session or orchestrates a fresh login (including OTP relay from a human operator) and returns decrypted, structured credentials.

## Architecture

```
                                ┌──────────────┐
                                │   Admin UI   │ :3000
                                │  (static JS) │
                                └──────┬───────┘
                                       │
                  ┌────────────────────┼─────────────────────┐
                  │                    │                     │
           ┌──────▼───────┐     ┌──────▼──────┐       ┌──────▼───────┐
           │  Slack Bot   │     │    API      │       │ Teams Bot    │
           │  (NATS sub)  │     │  (NestJS)   │       │ (Bot Frmwk)  │
           │  :no port    │     │  :8080      │       │ :3978        │
           └──────┬───────┘     └──┬───┬───┬──┘       └───────┬──────┘
                  │                │   │   │                  │
                  └────────┬───────┘   │   └───────┬──────────┘
                           │           │           │
                   ┌───────▼───────┐ ┌─▼───────┐ ┌─▼───────────┐
                   │     NATS      │ │  Redis  │ │ PostgreSQL  │
                   │  (JetStream)  │ │  (7)    │ │   (15)      │
                   │  :4222        │ │  :6379  │ │   :5432     │
                   └───────┬───────┘ └─────────┘ └──────┬──────┘
                           │                            │
                   ┌───────▼────────────────────────────▼──────┐
                   │              Controller                   │
                   │           (NestJS, :8090)                 │
                   │     Reconcile loop · Pod lifecycle        │
                   └──────────┬────────────────┬───────────────┘
                              │ creates/deletes│
               VNC mode       │                │       CDP mode
         ┌────────────────────▼──┐   ┌────────▼───────────────────┐
         │  Worker Pod (2 cont.) │   │  Worker Pod (1 container)  │
         │ ┌────────┐ ┌───────┐  │   │ ┌────────────────────────┐ │
         │ │Chromium│ │ noVNC │  │   │ │ Chromium (headless)    │ │
         │ │+Xvfb   │ │sidecar│  │   │ │ + CDP Relay :9223      │ │
         │ │:8091   │ │:6080  │  │   │ │ :8091                  │ │
         │ └───┬────┘ └───────┘  │   │ └───────┬────────────────┘ │
         │     │                 │   │         │                  │
         │     ▼                 │   │         ▼                  │
         │  MinIO (blobs)        │   │  MinIO (blobs)             │
         │  :9000                │   │  :9000                     │
         └───────────────────────┘   └────────────────────────────┘
```

> **Streaming mode** is configured per-application via `browser_policy.streaming_mode` (`"vnc"` default, or `"cdp"`). VNC mode uses headed Chromium + Xvfb + noVNC sidecar. CDP mode uses headless Chromium + `Page.startScreencast` with a WebSocket relay — no X11 stack or sidecar needed.

**7 services** | **20 API modules** | **640 tests** | **15 database entities** | **15 DSL actions** | **21 ADRs**

## Quick Start

```bash
# Prerequisites: Node 20+, pnpm 10+, Docker

# 1. Install dependencies
pnpm install

# 2. Start local infrastructure
docker compose up -d    # PostgreSQL, Redis, NATS (JetStream), MinIO

# 3. Build
pnpm nx run-many --target=build --all --parallel=3

# 4. Run API in dev mode
pnpm --filter @browser-hitl/api start:dev

# 5. Run tests
pnpm nx run-many --target=test --all --parallel=3
```

## Project Structure

```
apps/
  api/              NestJS API (20 modules, 13 controllers, 15 entities)
  controller/       Kubernetes session reconciler (pod lifecycle, state machine)
  worker/           Browser automation (Playwright + dual-mode streaming)
  slack-bot/        Slack HITL bridge (OTP relay, takeover)
  teams-bot/        Teams HITL bridge (Bot Framework)
  admin-ui/         Admin dashboard
packages/
  shared/           Constants, types, state machines, validators, env helpers
charts/
  browser-hitl/     Helm chart (26 templates, 3 values tiers)
infra/
  docker/           Dockerfiles (7 services)
scripts/            E2E batches, utilities, deployment helpers
docs/               Architecture, ADRs, functional overview, security audit
```

## Key Features

| Feature | Description |
|---------|-------------|
| **Dual-Mode Streaming** | VNC (headed, noVNC client) or CDP (headless, canvas viewer) — per-app config |
| **Session State Machine** | 7 states, 11 transitions with retry matrix and backoff |
| **Login DSL** | 15 browser actions with variable interpolation |
| **HITL Baton System** | 4-state baton with CAS versioning and pessimistic locks |
| **Agent OAuth 2.0** | Client Credentials grant for headless agent access (HMAC-SHA256) |
| **Request Coalescing** | 10 concurrent agent requests → 1 login (prevents account lockout) |
| **Login Serialization** | 3-barrier defense (Redis lock → DB transaction → per-worker rate limit) |
| **Credential Envelope** | Freshness tracking (CACHED/EXTRACTED), volatility model per field |
| **Profile Versioning** | STAGING→CANARY→ACTIVE lifecycle for safe login DSL rollout |
| **Durable Events** | NATS JetStream with `sync_interval: always` |
| **Artifact Encryption** | AES-256-GCM encrypted cookies/headers/tokens in MinIO (per-tenant keys) |
| **Audit Hash Chain** | Append-only SHA-256 chain with daily integrity anchors |
| **Egress Control** | FQDN allowlist via configurable egress proxy |
| **Multi-Tenant** | PostgreSQL RLS isolation, tenant-scoped NATS subjects, per-tenant encryption |
| **Prometheus Metrics** | prom-client with runtime + application metrics, PrometheusRule alerting |

## Security Posture

40+ red team remediations completed and graded (S/A tier):

- **Authentication**: JWT with `jti`-based revocation, bcrypt cost 12, account lockout (5 failures / 15 min), OAuth 2.0 Client Credentials for agents
- **Authorization**: 4-role RBAC (Admin/Operator/Viewer/Agent) enforced on all 13 controllers
- **Input Validation**: class-validator DTOs on all controllers, whitelist + forbidNonWhitelisted
- **Rate Limiting**: Global 60/min + per-endpoint overrides (login: 5/min, stream: 3/min)
- **Headers**: Helmet (HSTS, X-Frame-Options, etc.), CORS with configurable origin
- **Data at Rest**: AES-256-GCM with per-tenant keys, key version tracking for rotation
- **Network**: Kubernetes NetworkPolicies, NATS token auth, TLS via cert-manager
- **Login Safety**: 3-barrier serialization preventing concurrent login account lockout
- **Browser Hardening**: 15 Chromium flags, disabled downloads/clipboard/file chooser
- **CDP Streaming Security**: Strict command/event whitelists (6 commands, 2 events), message-level inspection, 64KB frame limit, `Target.*` domain rejection
- **Observability**: Structured JSON logging, prom-client, PrometheusRule alerting
- **Secrets**: No hardcoded defaults in production, service-token auth for bots

Full audit trail in [docs/internal/CLAUDE_RED_TEAM_REMEDIATIONS.md](docs/internal/CLAUDE_RED_TEAM_REMEDIATIONS.md).

## Architecture Decision Records (21 ADRs)

Key decisions that shape the system:

| ADR | Decision | Why It Matters |
|-----|----------|----------------|
| 002 | Request coalescing via `auth_requests` table + Redis lock | 10 concurrent agent requests → 1 login |
| 010 | OAuth 2.0 Client Credentials for agents | Headless access without human JWT |
| 011 | Redis 3-tier resilience (HEALTHY/DEGRADED/DOWN) | Graceful degradation, never hard-fails on Redis outage |
| 012 | 3-barrier login serialization | Defense-in-depth against concurrent logins to same account |
| 013 | Credential envelope with freshness + volatility | Agents know if credentials are CACHED vs EXTRACTED |
| 014 | Profile versioning (STAGING→CANARY→ACTIVE) | Safe rollout of login DSL changes |
| 015 | PG-backed global login queue | Prevents startup storm (50 sessions all login simultaneously) |
| 021 | Dual-mode streaming (VNC + CDP) | Per-app choice: headed VNC or headless CDP (fewer resources) |

Full ADR documentation in [docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md).

## Test Coverage

| Package | Suites | Tests |
|---------|--------|-------|
| `@browser-hitl/shared` | 4 | 78 |
| `@browser-hitl/api` | 24 | 460 |
| `@browser-hitl/controller` | 3 | 50 |
| `@browser-hitl/worker` | 3 | 52 |
| **Total** | **34** | **640** |

Plus E2E smoke test suite (Python orchestrator, 25 checks) covering the full credential delivery chain and CDP mode verification.

## API Documentation

Swagger UI at `/api/docs` in development. 13 controllers: Authentication, Users, Applications, Sessions, HITL, Streaming, Artifacts, Agent, Credentials, Profiles, Tenants, Health, Metrics.

## Deployment

```bash
# Local (Kind/minikube)
helm upgrade --install browser-hitl charts/browser-hitl \
  -f charts/browser-hitl/values-local.yaml \
  --namespace browser-hitl --create-namespace

# Production
helm upgrade --install browser-hitl charts/browser-hitl \
  -f charts/browser-hitl/values-production.yaml \
  --namespace browser-hitl --create-namespace \
  --set secrets.postgresPassword=$PG_PASSWORD \
  --set secrets.jwtSigningKey=$JWT_KEY
```

## Documentation

| Document | Description |
|----------|-------------|
| [QUICKSTART.md](QUICKSTART.md) | Get running locally in under 5 minutes |
| [RUNBOOK.md](RUNBOOK.md) | Operator guide: setup, deploy, troubleshoot |
| [RUNBOOK_SLACK_DEMO.md](RUNBOOK_SLACK_DEMO.md) | Slack HITL demo walkthrough |
| [TEST_EXECUTION.md](TEST_EXECUTION.md) | E2E test playbook (5 levels, 4 batches) |
| [AGENT.md](AGENT.md) | Implementation guide for AI agents |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Developer setup and PR conventions |
| [SECURITY.md](SECURITY.md) | Security policy and vulnerability reporting |
| [CHANGELOG.md](CHANGELOG.md) | Release history (Keep a Changelog format) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data flow, state machines |
| [docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md) | 21 ADRs with reasoning |
| [docs/FUNCTIONAL_OVERVIEW.md](docs/FUNCTIONAL_OVERVIEW.md) | Use cases, API surface, security model |
| [docs/SPECIFICATION_DIVERGENCE.md](docs/SPECIFICATION_DIVERGENCE.md) | Spec vs implementation delta |
| [docs/CLAUDE_RED_TEAM.md](docs/CLAUDE_RED_TEAM.md) | Security audit (revised post-remediation) |
| [docs/internal/](docs/internal/) | Development history and audit trail files |

## SBOM

A Software Bill of Materials is included at the repository root:

- `sbom.spdx.json` — SPDX format
- `sbom.cdx.json` — CycloneDX format

Generated with [syft](https://github.com/anchore/syft). Container image SBOMs are generated in CI and attached via cosign.

## Configuration

Key environment variables (full spec in `packages/shared/src/env.ts`):

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection | Required |
| `REDIS_URL` | Redis connection | Required |
| `NATS_URL` | NATS connection | Required |
| `JWT_SIGNING_KEY` | JWT signing key (32+ chars) | Required |
| `TENANT_ENCRYPTION_KEY` | Per-tenant AES-256 key (base64) | Required |
| `CORS_ORIGIN` | Allowed CORS origin | `*` |
| `TRUST_PROXY` | Express trust proxy | `loopback` |
| `METRICS_AUTH_TOKEN` | Bearer token for /metrics | (open if unset) |
| `LOG_FORMAT` | `json` or `text` | `text` (prod: `json`) |
| `LOG_LEVEL` | Minimum log level | `log` |
| `SHUTDOWN_TIMEOUT_MS` | Graceful shutdown timeout | `10000` |
