# Specification Divergence Analysis

Comparison of the current implementation against the MVP specification (`specification_docs/MVP_BROWSER_SPEC_CODEX.md` v6).

## Summary

| Category | Count |
|----------|-------|
| Fully Implemented (spec-conformant) | 31 |
| Extended (beyond spec) | 8 |
| Deferred to V2 | 4 |
| Partial | 1 |

## Fully Implemented (31 items)

All core spec requirements are implemented:

- Session state machine (7 states, 11 transitions) — spec section 3
- HITL baton state machine (4 states, 6 transitions) — spec section 4
- Login DSL engine (15 actions, variable interpolation) — spec section 5
- Health predicate evaluation (URL, DOM, network checks with policy) — spec section 6
- Artifact extraction and encryption (AES-256-GCM) — spec section 7
- NATS JetStream durable events (`sync_interval: always`) — spec section 8
- Multi-tenant isolation (PostgreSQL RLS) — spec section 9
- RBAC (Admin/Operator/Viewer) — spec section 10
- Audit hash chain (SHA-256, daily anchors) — spec section 11
- Rate limiting (per-IP and per-user) — spec section 13.1
- Session recycling (max age + memory watermark) — FR-34
- Worker pod architecture (Xvfb + Playwright + noVNC) — spec section 15.5
- Kubernetes reconcile loop (desired vs actual) — spec section 15.6
- Egress proxy FQDN allowlist — spec section 15.8
- Helm chart with values — spec section 15.10
- CI/CD pipeline (lint → test → build → SBOM → E2E → publish) — spec section 15.9
- Docker images for all services — spec section 15.3
- WebSocket event streaming — spec section 12
- Presigned URL artifact access — spec section 7.3
- Backoff and retry matrix — spec section 3.2
- Intervention tracking (type, outcome, timing) — spec section 4
- Application CRUD with soft delete — spec section 9.2
- Session scaling (desired_sessions) — spec section 9.3
- Stream token generation — spec section 12.2
- Circuit breaker (app + tenant thresholds) — spec section 15.4
- Lifecycle retention (artifacts, sessions, interventions) — spec section 11.3
- Bootstrap module (first tenant + admin) — spec section 15.1
- OTP relay via Redis (60s TTL) — spec section 4.3
- Screenshot fallback (FR-36) — spec section 5.4
- Credential mounting from K8s Secrets — spec section 15.5.2
- Test harness and E2E scripts — spec section 22

## Extensions (8 items)

Functionality added beyond the original specification:

| # | Extension | Rationale |
|---|-----------|-----------|
| E1 | **NATS JetStream** durable delivery (vs Core NATS) | Jepsen-validated durability guarantee for audit trail |
| E2 | **Soft HITL bridge** (polling-based, not Socket Mode) | Simpler deployment, no persistent WebSocket to Slack |
| E3 | **Application soft delete** | Data preservation for audit compliance |
| E4 | **Login throttle override** (env-configurable) | Allows tuning for different environments |
| E5 | **OTP dual-field compatibility** (otp_value or code) | Supports diverse identity provider formats |
| E6 | **Token revocation** (Redis blacklist with jti) | Not in spec but critical for security (C1 remediation) |
| E7 | **Account lockout** (5 failures, 15 min) | Not in spec but critical for brute-force prevention (C2 remediation) |
| E8 | **Structured JSON logging** with configurable format | Production observability requirement (H10 remediation) |

## Deferred to V2 (4 items)

| # | Item | Reason |
|---|------|--------|
| D1 | **CDP streaming** (BrowserStreamProvider V2) | noVNC sufficient for MVP; CDP adds complexity |
| D2 | **Single-use stream token enforcement** (Redis Lua CAS) | Current TTL-based expiry acceptable for MVP |
| D3 | **NATS ACL per-tenant verification** | NATS token auth implemented; per-tenant ACL requires accounts mode |
| D4 | **Admin UI** (full React dashboard) | server.js placeholder exists; full UI deferred |

## Partial Implementation (1 item)

| Item | Status | Gap |
|------|--------|-----|
| **Artifact consumption single-use** | TTL-based expiry works | Redis Lua CAS for strict single-use not implemented |

## Configuration Differences

| Setting | Spec Default | Implementation | Reason |
|---------|-------------|----------------|--------|
| Bcrypt cost | 12 | 12 | Conformant |
| JWT TTL | 24h | 24h | Conformant |
| OTP TTL | 60s | 60s | Conformant |
| Stream TTL | 600s | 600s | Conformant |
| Reconcile interval | 15s | 15s | Conformant |
| Max session age | 24h | 24h | Conformant |
| Password min length | 8 | 12 | **Stricter** (security hardening) |
| Account lockout | Not specified | 5 failures / 15 min | **Added** (C2 remediation) |
| OTP format | `^\d{4,10}$` | `^[A-Za-z0-9]{4,10}$` | **Extended** for alphanumeric OTPs |

## Test Coverage vs Spec Requirements

| Spec Section | Requirement | Tests |
|-------------|-------------|-------|
| 3 | Session state machine | `state-machine.spec.ts` (50 tests) |
| 5 | Login DSL | `login-dsl-runner.spec.ts`, `dsl.validator.spec.ts` |
| 6 | Health predicates | `health.types.spec.ts` |
| 7 | Artifact pipeline | `artifact-pipeline.integration.spec.ts` |
| 10 | RBAC | `critical-services.spec.ts` (RolesGuard tests) |
| 11 | Audit chain | `audit-chain.integration.spec.ts` |
| 13.1 | Rate limiting | `critical-services.spec.ts` (ThrottlerGuard tests) |
| 15.5 | Worker lifecycle | `otp-relay.spec.ts` |
| 15.6 | Reconcile loop | `reconcile.service.spec.ts` |
| Security | Red team items | 7 dedicated adversarial test suites (155+ tests) |
