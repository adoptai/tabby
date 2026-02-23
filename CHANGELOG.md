# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-02-23

### Added

- **CDP streaming mode** — headless Chromium with `Page.startScreencast` and WebSocket relay (:9223), no X11/sidecar needed (ADR-021)
- **Dual-mode streaming** — per-application `browser_policy.streaming_mode` (`"vnc"` or `"cdp"`)
- **OAuth 2.0 Client Credentials** for agent authentication (HMAC-SHA256, `agent_clients` entity)
- **Request coalescing** — concurrent agent requests → single login via `auth_requests` table + Redis lock (ADR-002)
- **Global login queue** — PG-backed startup storm prevention (ADR-015)
- **Service profile versioning** — STAGING→CANARY→ACTIVE lifecycle for safe login DSL rollout (ADR-014)
- **Credential envelope** — freshness tracking (CACHED/EXTRACTED), per-field volatility model (ADR-013)
- **Redis 3-tier resilience** — HEALTHY/DEGRADED/DOWN with DB fallback (ADR-011)
- **3-barrier login serialization** — Redis lock → DB transaction → per-worker rate limit (ADR-012)
- **E2E smoke test suite** — Python orchestrator, 25 checks across full credential delivery chain
- **CDP proof-of-life test** — 16/16 checks, simultaneous VNC + CDP workers verified
- **Slack HITL demo runbook** — end-to-end walkthrough for Slack-based OTP relay
- 4 new database entities: `agent_clients`, `auth_requests`, `login_queue`, `service_profiles`
- 4 new migrations: AgentClients, AuthRequests, LoginQueue, ServiceProfiles, AccountLockout, ProfileAppLink
- 4 new API modules: credentials, login, profiles, websocket
- 21 Architecture Decision Records (up from initial set)

### Changed

- API expanded from 16 to 20 modules, 11 to 15 entities, 13 controllers
- Test suite grown from 385 to 640 tests across 34 suites
- Worker pod supports both headed (VNC) and headless (CDP) modes
- 4-role RBAC (Admin/Operator/Viewer/Agent) — Agent role added for OAuth clients

### Security

- 40+ red team remediations completed and graded (S/A tier)
- CDP command/event whitelists (6 commands, 2 events), message-level inspection, 64KB frame limit
- `Target.*` CDP domain rejection to prevent tab escape
- Screencast parameter clamping (max resolution, quality bounds)

## [0.1.0] - 2026-01-01

### Added

- NestJS API with 16 modules and 11 database entities
- Session state machine (7 states, 11 transitions) with retry matrix and backoff
- Login DSL with 15 browser actions and variable interpolation
- HITL baton system (4-state CAS-versioned with pessimistic locks)
- NATS JetStream durable event streaming (`sync_interval: always`)
- AES-256-GCM encrypted artifact bundles in MinIO
- Append-only SHA-256 audit hash chain with daily anchors
- noVNC live streaming with WebSocket proxy and stream tokens
- Slack and Teams bot bridges for HITL notifications
- Kubernetes session controller (pod lifecycle reconciler)
- Helm chart with 26 templates and 3 values tiers (default, local, production)
- Multi-tenant PostgreSQL RLS isolation
- Prometheus metrics with prom-client and PrometheusRule alerting
- CI/CD pipeline: lint, SCA, test, build, SBOM, E2E, publish

### Security

- 38-item red team audit (35 remediated, 3 deferred)
- JWT `jti`-based revocation with Redis blacklist
- bcrypt cost 12, account lockout, password complexity enforcement
- RBAC (Admin/Operator/Viewer) with `@Roles` guard on all endpoints
- class-validator DTOs with whitelist and forbidNonWhitelisted
- Rate limiting: global 60/min + per-endpoint overrides
- Helmet security headers, CORS, timing-safe metric auth
- Kubernetes NetworkPolicies, NATS token auth, TLS scaffolding
- No hardcoded secrets in production configuration
