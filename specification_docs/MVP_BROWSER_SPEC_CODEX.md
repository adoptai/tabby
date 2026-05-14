# MVP Browser HITL Spec (Codex)

**Document ID:** MVP_BROWSER_SPEC_CODEX
**Date:** 2026-02-18
**Owner:** Codex (system architect)
**Status:** Draft v6 (Final verification pass — all deficiencies resolved)
**Scope:** V1 MVP for browser human-in-the-loop (HITL) + headless browser session orchestration
**Remediation:** Incorporates all Priority 1 + Priority 2 items from `SPEC_REVIEW_ASSESSMENT.md`, plus all NEW-DEF items from second verification pass

---

## 1. Purpose

This document specifies a full V1 MVP for **headless browser sessions with human-in-the-loop (HITL) takeover**, intended to run **on-premise**, be **Kubernetes-native**, **CPU-only**, **auditable**, and **license-clean**. It is designed to allow a future Codex instance to implement the system from scratch with minimal ambiguity.

The MVP is the minimum shippable slice that proves:
1. A browser session can be created and kept alive on K8s.
2. A human can take over safely for MFA/CAPTCHA and hand control back.
3. Authenticated artifacts can be extracted and exported.
4. All actions are auditable, and the system is secure by default.

---

## 2. Product Summary (1 Paragraph)

Build a service that maintains **always-on authenticated browser sessions** for registered web apps. When a session loses authentication or requires human action (OTP/CAPTCHA), it summons a human via Slack/Teams, streams a live browser view through a secure link, pauses automation, and resumes after the human releases control. The system then extracts configured auth artifacts (cookies, headers, tokens, storage) and publishes them to a queue. The system must be deployable on-prem in Kubernetes with strict security boundaries and an explicit upgrade path from VNC streaming to CDP streaming.

---

## 3. Goals and Non-Goals

### 3.1 Goals (MVP)
- **G1:** Maintain one or more always-on browser sessions per registered application.
- **G2:** Detect logout or auth invalidation quickly and trigger login recovery.
- **G3:** Provide HITL flow via Slack/Teams with secure, short-lived streaming links.
- **G4:** Allow human takeover and controlled handback to automation.
- **G5:** Export authenticated session artifacts via NATS JetStream (encrypted).
- **G6:** Provide auditability, minimal RBAC, and compliance-ready packaging (SBOM baseline).
- **G7:** Provide a streaming abstraction (BrowserStreamProvider interface) that allows VNC now and CDP later.
- **G8:** Graceful degradation under bandwidth constraints (screenshot fallback mode).

### 3.2 Non-Goals (V1 Explicitly Out of Scope)
- Full workflow orchestration beyond login and keepalive.
- AI-heavy page narration or UI understanding.
- CAPTCHA bypass or automation of protected challenges. CAPTCHAs are handled exclusively by HITL.
- Per-user credential management at scale.
- Multi-region replication or federated control planes.
- Full knowledge plane (only minimal "what happened?" notes).
- End-user facing product dashboards beyond a minimal admin UI.

---

## 4. Assumptions and Decisions

### 4.1 Assumptions
1. On-prem customers can run Kubernetes with ingress, NATS, Postgres, Redis, and MinIO.
2. Slack or Teams is available for HITL interaction.
3. Credentials can be stored in K8s Secrets for V1. Application credentials are created as K8s Secrets manually by the admin using `kubectl`. The API resolves credential references by reading the named Secret via the K8s API.
4. Browser workers are isolated enough for tenant boundaries in V1.
5. Kubernetes version is 1.29+ with standard CRDs and native sidecar support (KEP-753).
6. Ingress controller is NGINX.
7. Storage class default is `local-path` for local/VPS clusters.
8. Kubernetes cluster has **encryption at rest enabled** for Secrets (`aescbc`, `aesgcm`, or KMS provider in `EncryptionConfiguration`). Verify during cluster bootstrap.
9. Container environments require `--no-sandbox` for Chromium. The container itself serves as the security boundary. See Decision D10.

### 4.2 Decisions (Explicit)
- **D1:** V1 streaming uses VNC/noVNC behind a `BrowserStreamProvider` abstraction interface (defined in section 11.5).
- **D2:** V2 will swap to CDP streaming by implementing `CdpStreamProvider` without changing external API.
- **D3:** V1 admin authentication is basic username/password with JWT sessions; OIDC deferred to V1.5+.
- **D4:** Artifact storage is MinIO (S3-compatible) in-cluster, referenced via NATS metadata.
- **D5:** Slack/Teams identities map to tenants via explicit mapping table (not implicit by default).
- **D6:** MVP must demonstrate enterprise posture: RBAC, audit retention, SBOM, encryption, network policies, NATS ACLs.
- **D7:** VNC is the MVP choice; CDP becomes mandatory once streaming is continuous or multi-tenant at scale.
- **D8:** Legal posture is explicitly OK for noVNC/websockify use in MVP/PoC.
- **D9:** Artifact consumption uses MinIO object storage + presigned URL delivery with application-level single-use enforcement.
- **D10:** Chromium runs with `--no-sandbox` in container environments. Compensating controls: non-root user, network policies, deny-all egress, read-only filesystem where possible. This is the standard practice for containerised Chromium (Selenium Grid, Playwright Docker images).
- **D11:** NATS JetStream must run with `sync_interval: always` (fsync before ack) to prevent data loss. Jepsen analysis (December 2025) found 49.7% acknowledged message loss with default `sync_interval`. Throughput trade-off accepted.
- **D12:** Database migrations use **TypeORM** with timestamped migration files. Migrations run on API service startup with advisory lock to prevent concurrent execution.
- **D13:** Monorepo uses **pnpm workspaces** with **NX** for build orchestration. Shared types in `packages/shared`.
- **D14:** CI/CD uses **GitHub Actions**. Pipeline: lint → test → build images → generate SBOM → sign SBOM → push images → push charts.
- **D15:** Slack bot uses `@slack/bolt` (MIT). Teams bot uses `botbuilder` (Bot Framework SDK, MIT). Each bot runs as a separate NestJS microservice in its own pod.
- **D16:** CDP migration trigger is set at a post-first-release human/team review checkpoint based on production telemetry and operational findings.
- **D17:** NATS account provisioning uses JWT-based resolver (not static config).

### 4.3 Streaming Decision Rationale (VNC vs CDP)

**Why VNC first for MVP**
- Lower implementation risk and faster delivery.
- HITL usage is infrequent (only during login/MFA), so VNC overhead is acceptable.
- Reduces early complexity in input mapping, screencast backpressure, and WebSocket tuning.

**Known downsides of VNC (accepted for MVP)**
- Extra components (Xvfb/VNC/noVNC) and license review required (MPL/LGPL).
- Less policy-native than CDP (desktop-level, not protocol-level).
- Larger container footprint.

**Exit criteria to move to CDP**
- HITL becomes frequent or continuous beyond login.
- Enterprise customers require reduced licensing risk or tighter policy control.
- Performance issues emerge in enterprise networks.

**Conclusion:** VNC for V1 MVP with an enforced `BrowserStreamProvider` abstraction and a committed V2 CDP migration path.

### 4.4 Decision Log
1. Decision: VNC/noVNC for V1 streaming | Rationale: fastest MVP, lowest engineering risk | Owner: Eng Lead | Date: 2026-02-18
2. Decision: CDP migration post-V1 | Rationale: policy-native control and licensing risk reduction | Owner: Architect | Date: 2026-02-18
3. Decision: Admin auth basic + JWT | Rationale: MVP speed with upgrade path to OIDC | Owner: Product/Eng | Date: 2026-02-18
4. Decision: MinIO for artifact storage | Rationale: on-prem S3-compatible object store | Owner: Eng Lead | Date: 2026-02-18
5. Decision: 90-day audit retention default | Rationale: enterprise-grade MVP posture | Owner: Security | Date: 2026-02-18
6. Decision: NGINX ingress + local-path storage class defaults | Rationale: works for local/VPS clusters | Owner: Eng | Date: 2026-02-18
7. Decision: noVNC/websockify license approved for MVP | Rationale: internal PoC use | Owner: Legal | Date: 2026-02-18
8. Decision: artifact consumption via MinIO presigned URLs | Rationale: simple and secure for MVP | Owner: Eng | Date: 2026-02-18
9. Decision: --no-sandbox with container-as-boundary | Rationale: required in K8s containers; compensating controls documented | Owner: Eng/Security | Date: 2026-02-18
10. Decision: NATS sync_interval:always | Rationale: Jepsen-validated durability requirement | Owner: Eng | Date: 2026-02-18
11. Decision: TypeORM for migrations | Rationale: first-class NestJS integration | Owner: Eng | Date: 2026-02-18
12. Decision: pnpm + NX monorepo | Rationale: NX has first-class NestJS support | Owner: Eng | Date: 2026-02-18
13. Decision: GitHub Actions CI/CD | Rationale: widely supported, good K8s/Helm integration | Owner: Eng | Date: 2026-02-18
14. Decision: CDP trigger decided at post-first-release checkpoint | Rationale: use real telemetry and operator feedback | Owner: Product/Eng | Date: 2026-02-18
15. Decision: NATS JWT resolver for tenant account provisioning | Rationale: dynamic account management without server restarts | Owner: Eng | Date: 2026-02-18

### 4.5 Assumption Log
1. Assumption: Customers can deploy MinIO alongside the app | Risk: medium | Validation: pilot install checklist
2. Assumption: HITL events are infrequent in MVP | Risk: medium | Validation: measure intervention rate
3. Assumption: Basic auth acceptable for MVP pilots | Risk: medium | Validation: pilot security review
4. Assumption: Slack/Teams integration is permitted by customers | Risk: low | Validation: pilot admin consent
5. Assumption: local-path storage class is available on target VPS clusters | Risk: low | Validation: cluster bootstrap checklist
6. Assumption: K8s encryption at rest is enabled | Risk: medium | Validation: cluster bootstrap checklist must verify EncryptionConfiguration
7. Assumption: Chromium --no-sandbox is acceptable in container environments | Risk: low | Validation: standard industry practice, security review

---

## 5. Personas and Primary Use Cases

### 5.1 Personas
- **Ops Admin:** Registers apps, monitors health, configures keepalive and export policies.
- **On-Call Human:** Receives HITL requests via Slack/Teams and completes MFA/CAPTCHA.
- **Downstream System:** Consumes exported session artifacts via NATS.
- **Security/Compliance:** Reviews SBOM, audit logs, and access controls.

### 5.2 Core Use Cases
- **UC1:** Register an application and desired session count.
- **UC2:** Session runs continuously and stays logged in via keepalive actions.
- **UC3:** Session logs out; system notifies human and requests intervention.
- **UC4:** Human opens secure stream, completes login, releases control.
- **UC5:** System extracts artifacts and publishes them to NATS with audit trail.

---

## 6. System Overview and Trust Boundaries

### 6.1 Components
- Admin UI (Next.js)
- API service (NestJS)
- Session Controller (reconcile loop, NestJS standalone)
- Browser Worker Pods (Chromium + Playwright + Xvfb, with VNC sidecar)
- Slack Bot (NestJS microservice, `@slack/bolt`)
- Teams Bot (NestJS microservice, `botbuilder`)
- Postgres (config + audit)
- Redis (ephemeral locks, OTP relay, single-use token tracking)
- NATS JetStream (artifact export, session events)
- Artifact store (MinIO, S3-compatible API)
- Egress policy proxy (FQDN allowlist enforcement for browser egress)

### 6.2 Trust Boundaries
- CDP/VNC ports never exposed outside cluster.
- Stream viewer only via signed URL + authenticated ingress.
- Artifact bundles encrypted in the browser worker before leaving the worker process memory.
- Secrets scoped per tenant.
- Unencrypted artifact payloads never traverse the network or persist to disk.

---

## 7. Functional Requirements

### 7.1 Application Registration
- **FR-01:** Admin can register an application with name, target URLs, login config, keepalive config, and export policy.
- **FR-02:** Admin can specify desired number of always-on sessions per app.
- **FR-03:** Admin can configure notification recipients (Slack/Teams channel or user).
- **FR-04:** Credentials are stored in K8s Secrets for V1, referenced by name (format: `k8s:secret/{secret-name}`). Secrets are created manually via `kubectl`. The API service's ServiceAccount requires RBAC permission to read Secrets in the application namespace.

### 7.2 Session Management
- **FR-05:** System maintains desired session count per app via reconcile loop.
- **FR-06:** Session state machine exists with explicit states and transitions (see section 9.1).
- **FR-07:** Session lifecycle supports start, pause, resume, terminate, recycle.
- **FR-08:** Session restarts automatically on failure with backoff policy.
- **FR-09:** Keepalive actions are configurable and executed on schedule.
- **FR-10:** Controller enforces per-tenant session quotas (from `tenants.max_sessions`).

### 7.3 Auth Detection and Recovery
- **FR-11:** Auth health uses explicit predicates per app (see section 10.4).
- **FR-12:** Failed predicate triggers `LOGIN_NEEDED` state and HITL event (only after auth-specific failure, not transient errors).
- **FR-13:** Login workflow is page-by-page and supports OTP prompts via chat.
- **FR-14:** OTP values are ephemeral, never stored beyond 60-second Redis TTL, and never logged.

### 7.4 HITL Streaming and Control
- **FR-15:** System generates signed, short-lived streaming URLs (JWT with `jti`, 10-minute TTL, session binding).
- **FR-16:** Streaming enabled only on demand, revoked on release.
- **FR-17:** Baton model enforces exclusive control (see section 9.2).
- **FR-18:** HITL events are logged with user identity and timestamps.

### 7.5 Artifact Extraction and Export
- **FR-19:** After successful login (health predicate passes), browser worker extracts configured artifacts immediately.
- **FR-20:** Artifacts are encrypted in the browser worker process using AES-256-GCM with per-tenant key, then stored in MinIO.
- **FR-21:** Export metadata is published to NATS JetStream.
- **FR-22:** Export events are audited and include expiration metadata.

### 7.6 Observability and Audit
- **FR-23:** Audit trail includes session lifecycle, HITL events, login failures, exports.
- **FR-24:** Metrics include TTFF, HITL latency, session uptime, intervention rate.
- **FR-25:** OpenTelemetry traces span API -> controller -> worker. Use `@opentelemetry/auto-instrumentations-node` for HTTP/database/NATS auto-instrumentation. Add manual spans for state transitions and HITL events. Export via OTLP to a cluster-local OpenTelemetry Collector (Jaeger all-in-one for development).

### 7.7 RBAC and Tenant Isolation
- **FR-26:** Roles: `Admin`, `Operator`, `Viewer` scoped per tenant.
- **FR-27:** Slack/Teams users are mapped to tenants in a mapping table.
- **FR-28:** Session access restricted to owning tenant. `tenant_id` is denormalized on `sessions` and `interventions` tables for query safety.

### 7.8 Failure Modes and Recovery
- **FR-29:** Timeouts and retries are explicit per state (see section 9.4).
- **FR-30:** Controller is idempotent across restarts.
- **FR-31:** Failed sessions emit alerts and require human acknowledgement via `POST /sessions/{id}/acknowledge` before reactivation.

### 7.9 Knowledge Bootstrap (V1.5 Minimal)
- **FR-32:** After HITL, system prompts for "what happened?"
- **FR-33:** Notes are tagged with app, session, timestamp, intervention type.

### 7.10 Session Recycling
- **FR-34:** Browser worker pods are recycled after `max_session_age_hours` (default: 24) or when memory exceeds a configurable watermark (default: 2.5 GB). Recycling procedure: export artifacts, terminate pod, controller recreates pod and triggers re-login.

### 7.11 Credential Health
- **FR-35:** Each application tracks `credential_last_validated_at` (updated on every successful login) and `credential_rotation_reminder_days` (default: 90). When credentials approach rotation date, emit an alert.

### 7.12 Streaming Degradation
- **FR-36:** When VNC frame rate drops below 1 FPS for >30 seconds, fall back to periodic screenshot mode (capture via `page.screenshot()` every 2 seconds, delivered as images in the viewer). Resume VNC streaming when bandwidth recovers.

### 7.13 Tenant Provisioning
- **FR-37:** On tenant creation (`POST /tenants`), the API provisions: (1) MinIO bucket `artifact-bundles-{tenant_id}` with lifecycle rules, (2) per-tenant AES-256-GCM key stored as K8s Secret `tenant-key-{tenant_id}`. Operation is idempotent.

### 7.14 OTP Relay
- **FR-38:** OTP values are relayed from chat bot to browser worker via Redis. Bot writes OTP to `otp:{session_id}` with 60-second TTL. Worker polls this key at 1-second interval when in OTP-waiting state. Worker reads value, fills the configured `field_selector`, and deletes the key immediately.

### 7.15 HITL Acknowledgement
- **FR-39:** Operators can acknowledge a FAILED session via `POST /sessions/{id}/acknowledge`, which transitions it to STARTING for re-creation only when `now >= hitl_pause_until` (or `hitl_pause_until` is null). If pause is active, API returns `409` with `retry_after_seconds`.

### 7.16 Browser Controls
- **FR-40:** Browser sessions disable downloads, clipboard access, and file chooser by default. Configurable per-app via `browser_policy` in application config.

### 7.17 Network Policy Generation
- **FR-41:** The session controller generates Kubernetes NetworkPolicies per browser worker pod with deny-all egress except DNS, internal services, and the egress proxy service. Domain allowlisting from `applications.target_urls` is enforced in the egress proxy (not native NetworkPolicy). The controller's ServiceAccount requires RBAC permissions to create/update NetworkPolicies in the browser worker namespace. NetworkPolicies are deleted when the pod is terminated.

---

## 8. Non-Functional Requirements

### 8.1 Performance
- **NFR-01:** TTFF ≤ 8 seconds (PoC), stretch goal ≤ 5 seconds.
- **NFR-02:** Input latency ≤ 800ms (PoC), stretch goal ≤ 500ms.
- **NFR-03:** Session start success rate ≥ 80% (PoC), stretch goal ≥ 90%.

### 8.2 Reliability
- **NFR-04:** Sessions auto-recover from pod failure within 2 minutes.
- **NFR-05:** Orchestrator restarts do not lose state.

### 8.3 Scalability
- **NFR-06:** Support at least 20 concurrent sessions.
- **NFR-07:** Horizontal scaling of browser pods via HPA.

### 8.4 Security
- **NFR-08:** All artifacts encrypted at rest and in transit.
- **NFR-09:** Network policies deny all egress by default, allowlist per app (dynamically generated).

### 8.5 Degradation
- **NFR-10:** Under bandwidth constraints, streaming gracefully degrades from VNC to periodic screenshots. System remains functional in degraded mode.

---

## 9. State Machines and Algorithms

### 9.1 Session Lifecycle State Machine

States:
- `STARTING`
- `HEALTHY`
- `UNHEALTHY`
- `LOGIN_NEEDED`
- `LOGIN_IN_PROGRESS`
- `FAILED`
- `TERMINATED`

Transitions:

| From | To | Trigger |
|------|-----|---------|
| `STARTING` | `HEALTHY` | Successful login + health predicate passes |
| `STARTING` | `LOGIN_NEEDED` | Login DSL reaches OTP/CAPTCHA step requiring HITL |
| `STARTING` | `FAILED` | Retry exhaustion (3 attempts) |
| `HEALTHY` | `UNHEALTHY` | 2 consecutive failed health evaluations |
| `UNHEALTHY` | `HEALTHY` | Health evaluation passes (transient recovery) |
| `UNHEALTHY` | `LOGIN_NEEDED` | Auth-specific predicate failure detected (not transient) after 2-minute window |
| `LOGIN_NEEDED` | `LOGIN_IN_PROGRESS` | HITL initiated (bot notification sent) |
| `LOGIN_IN_PROGRESS` | `HEALTHY` | Successful login + health predicate passes |
| `LOGIN_IN_PROGRESS` | `FAILED` | Timeout (10 min) or retry exhaustion (3 attempts) |
| `FAILED` | `STARTING` | Operator acknowledgement via `POST /sessions/{id}/acknowledge` |
| Any | `TERMINATED` | Admin request or reconciliation downscale |

**Terminal state:** `TERMINATED` is a terminal state. No transitions out of `TERMINATED` are permitted. The session row is retained for audit purposes but the pod and associated resources (NetworkPolicy, stream tokens) are destroyed. To restart, the controller creates a new session row and pod.

**Distinguishing transient vs auth failure:** Health predicates return a result type: `PASS`, `TRANSIENT_FAIL` (e.g., HTTP 503, timeout), or `AUTH_FAIL` (e.g., HTTP 401/403, login redirect detected, auth DOM selector missing). `TRANSIENT_FAIL` leads to `UNHEALTHY` with automatic recovery path. `AUTH_FAIL` leads to `UNHEALTHY → LOGIN_NEEDED`.

Timeouts:
- `LOGIN_IN_PROGRESS`: 10 minutes default.
- `UNHEALTHY`: 2 minutes before escalation to `LOGIN_NEEDED` (only on `AUTH_FAIL`).
- `FAILED`: requires operator acknowledgement before retry.

### 9.2 HITL Baton State Machine

States:
- `AUTOMATION_CONTROL`
- `HUMAN_REQUESTED`
- `HUMAN_CONTROL`
- `HUMAN_RELEASED`

Transitions:

| From | To | Trigger | Timeout |
|------|-----|---------|---------|
| `AUTOMATION_CONTROL` | `HUMAN_REQUESTED` | System detects LOGIN_NEEDED, sends bot notification | -- |
| `HUMAN_REQUESTED` | `HUMAN_CONTROL` | Human clicks "Take Control" in stream viewer | -- |
| `HUMAN_REQUESTED` | `AUTOMATION_CONTROL` | No human response within 10 minutes. Session transitions to `FAILED` and escalation is sent. | 10 min |
| `HUMAN_CONTROL` | `HUMAN_RELEASED` | Human clicks "Release Control" | -- |
| `HUMAN_CONTROL` | `HUMAN_RELEASED` | Inactivity timeout (no input for 5 minutes) | 5 min |
| `HUMAN_RELEASED` | `AUTOMATION_CONTROL` | System resumes automation | Immediate |

Rules:
- Only one controller at a time (mutually exclusive).
- When `HUMAN_CONTROL`, automation is paused and input from automation is ignored.
- On `HUMAN_REQUESTED` timeout, baton resets to `AUTOMATION_CONTROL`, session transitions to `FAILED`, and escalation is sent.
- On inactivity timeout in `HUMAN_CONTROL`, control is released and automation resumes.

**Baton persistence model:**
- Baton state is persisted in `session_batons` (section 10.1).
- `POST /sessions/{id}/takeover` performs compare-and-swap on `session_batons.version` to prevent concurrent takeovers.
- Baton owner is tracked as `owner_user_id`; only owner or Admin can release.

### 9.3 Controller Reconcile Loop (Pseudo)

1. Load desired sessions per app from `applications.desired_session_count`.
2. List current sessions and their states from `sessions` table.
3. Create browser worker pods for missing sessions.
4. Terminate excess sessions (oldest first).
5. Read health status written by workers to `sessions` table, including `health_result_type` (PASS/TRANSIENT_FAIL/AUTH_FAIL).
6. Advance state transitions based on `health_result_type` and timeouts (see section 9.1 transition table). Controller is the single writer for `sessions.state`.
7. Generate NetworkPolicies for new pods (deny-all + allow proxy/internal), and update egress proxy allowlists from `applications.target_urls`.
8. Trigger HITL if any session enters `LOGIN_NEEDED`.
9. Persist state transitions and emit audit events.

Reconcile interval: 15 seconds (configurable via `RECONCILE_INTERVAL_SECONDS`).

### 9.4 Retry Matrix (Defaults)

| State | Max Attempts | Backoff Applied | Result on Exhaustion |
|---|---|---|---|
| STARTING | 3 | Yes | FAILED |
| UNHEALTHY (transient) | 3 | Yes | Remains UNHEALTHY, emits alert |
| UNHEALTHY (auth) | 1 | No | LOGIN_NEEDED |
| LOGIN_IN_PROGRESS | 3 | Yes | FAILED |
| FAILED | 0 | N/A | Requires operator acknowledgement |

### 9.5 Backoff Defaults

- Base delay: 30 seconds
- Multiplier: 2x
- Max delay: 30 minutes
- Max login attempts per hour per app: 5

### 9.6 Controller-Worker Communication Protocol

The controller and browser workers communicate through a combination of database state and a worker-local HTTP API.

**Worker → Controller (status reporting):**
- The browser worker writes health status and metric timestamps directly to the `sessions` table in Postgres via a direct database connection.
- Fields updated by worker: `last_health_check`, `last_login_at`, `intervention_count`, `artifacts_last_exported_at`, `health_result_type` (PASS/TRANSIENT_FAIL/AUTH_FAIL).
- The worker MUST NOT write `sessions.state`; controller is the only state writer.
- The controller reads the `sessions` table during each reconcile cycle.

**Controller → Worker (commands):**
- The controller does NOT send commands to the worker directly. Instead:
  - **Start login:** Controller creates the pod. The worker starts the login DSL automatically on startup.
  - **Extract artifacts:** Worker extracts automatically after successful login and on each keepalive cycle (if health passes).
  - **Terminate:** Controller deletes the pod via K8s API.
  - **Recycle:** Controller deletes pod and creates a new one. The new pod starts the login DSL.
- This stateless command model means the controller never needs to reach the worker over the network. All coordination is via the database and pod lifecycle.

**State transition concurrency control:**
- `sessions` includes `state_version` (BIGINT).
- Controller updates state with optimistic locking:
  `UPDATE sessions SET state = $new_state, state_version = state_version + 1 WHERE id = $id AND state_version = $expected`.
- If zero rows are updated, controller reloads session row and retries transition logic.

**Worker HTTP API (cluster-internal only, port 8091):**
- `GET /health` — Kubernetes liveness/readiness probe. Returns 200 if Chromium process is alive and Playwright is connected.
- `GET /status` — Returns current session state, last health check time, last login time. Used by the controller as a secondary verification channel.
- These endpoints are for Kubernetes probes and observability only, not for command dispatch.

**Worker Postgres role permissions:**
The browser worker connects to Postgres with a dedicated `worker` database role (not the same role as the API service). This role has scoped permissions:
- `SELECT, UPDATE` on `sessions` — worker reads its own session config and writes health/status updates (not state).
- `INSERT, SELECT` on `artifact_bundles` — worker creates artifact records after export.
- `INSERT` on `audit_events` — worker writes audit events for login, extraction, and health status updates.
- No access to `tenants`, `users`, `applications`, `user_identities`, or `audit_anchors` tables.
- Row-level scoping is enforced in PostgreSQL via RLS policies. Worker connection sets `SET app.session_id = '<SESSION_ID>'`. Policies restrict `SELECT/UPDATE sessions` and `INSERT artifact_bundles` to the worker's own `session_id` and `tenant_id`.

### 9.7 OTP Relay Protocol

1. Browser worker reaches an OTP step in the login DSL (identified by `otp_prompt` config).
2. Worker publishes `hitl.otp-requested.{tenant_id}.{session_id}` to NATS.
3. Bot receives the NATS event and prompts the human for OTP via chat.
4. Human replies with OTP value in chat.
5. Bot writes OTP to Redis: `SET otp:{session_id} "{value}" EX 60 NX`.
6. Worker polls `GET otp:{session_id}` every 1 second.
7. Worker reads the OTP, fills the configured `field_selector`, and immediately deletes the Redis key: `DEL otp:{session_id}`.
8. Worker continues the login DSL from the next step.

**Timeout:** If no OTP is received within the `otp_prompt.timeout_ms` (default: 120000ms / 2 minutes), the login step fails and follows the retry matrix.

**Security:** OTP Redis keys have 60-second TTL. Redis `slowlog-log-slower-than` must be set to avoid logging SET commands with OTP values, or use a dedicated Redis instance for OTP relay. Worker deletes the key immediately after reading.

### 9.8 Artifact Extraction Trigger

1. Worker completes the login DSL successfully (all steps pass without error).
2. Worker runs the health predicate to confirm the session is truly authenticated.
3. If health predicate returns `PASS`:
   a. Worker extracts artifacts per `export_policy.artifact_types`.
   b. Worker encrypts the artifact bundle with the per-tenant AES-256-GCM key.
   c. Worker writes the encrypted blob to MinIO at `{app_id}/{session_id}/{timestamp}.enc`.
   d. Worker creates the `artifact_bundles` database row (id, session_id, app_id, tenant_id, encrypted_payload_ref, nonce, key_version, exported_at, expires_at computed from `export_policy.ttl_seconds`).
   e. Worker publishes export metadata to NATS `auth.bundle.exported.{tenant_id}.{app_id}`.
   f. Worker updates `sessions.artifacts_last_exported_at`.
4. If health predicate returns `TRANSIENT_FAIL` or `AUTH_FAIL`:
   - Extraction is skipped. Session transitions per the state machine.
5. Extraction also runs on each keepalive cycle if the health predicate passes and `artifacts_last_exported_at` is older than `export_policy.refresh_interval_seconds` (default: 3600).
6. If extraction fails (MinIO unreachable, encryption error), the session remains HEALTHY but an alert is emitted. Extraction is retried on the next keepalive cycle.

### 9.9 Health Check Execution Model

**Executor:** The browser worker executes health predicates. The controller does NOT run health checks.

**Isolation from keepalive actions:** Health checks and keepalive actions are time-sliced on the same page. They are NEVER executed concurrently.

Execution order per keepalive cycle:
1. Execute keepalive actions (reload, click, etc.) sequentially.
2. Wait 2 seconds for page to stabilize after keepalive actions.
3. Execute health predicates sequentially.
4. Write results to `sessions` table.

**For `url_check` type:** Use a direct HTTP client (`fetch` with session cookies from `context.cookies()`) instead of the browser page. This avoids navigating away from the current page. The HTTP client runs in the worker's Node.js process.

**For `dom_check` type:** Use `page.waitForSelector(selector, { timeout: 5000 })` on the current page. This checks the current page state without navigation.

**For `network_check` type:** Use the same direct HTTP client as `url_check`, with cookie injection.

### 9.10 HITL Escalation Algorithm

Session counters:
- `hitl_attempt_count` increments each time a session enters `LOGIN_NEEDED`.
- `hitl_pause_until` is set when escalation threshold is reached.

Algorithm:
1. On transition to `LOGIN_NEEDED`, if `now < hitl_pause_until`, transition immediately to `FAILED` and emit escalation alert.
2. Otherwise increment `hitl_attempt_count`.
3. If `hitl_attempt_count >= 3` without an intervening successful login:
   - Set `hitl_pause_until = now + 30 minutes`
   - Transition to `FAILED`
   - Emit escalation to `notification_config.escalation.notify`
   - Block `POST /sessions/{id}/acknowledge` until pause expires.
4. On successful transition to `HEALTHY`, reset `hitl_attempt_count = 0` and clear `hitl_pause_until`.

---

## 10. Data Model and Schemas

### 10.1 Tables

**tenants**
- id (UUID, PK)
- name (VARCHAR, unique)
- max_sessions (INTEGER, default 10) — per-tenant session quota
- created_at (TIMESTAMPTZ)
- updated_at (TIMESTAMPTZ)

**users**
- id (UUID, PK)
- tenant_id (UUID, FK → tenants.id)
- email (VARCHAR, unique per tenant)
- password_hash (VARCHAR, bcrypt)
- role (ENUM: Admin/Operator/Viewer)
- status (ENUM: ACTIVE/DISABLED)
- created_at (TIMESTAMPTZ)
- updated_at (TIMESTAMPTZ)

**user_identities**
- id (UUID, PK)
- user_id (UUID, FK → users.id)
- tenant_id (UUID, FK → tenants.id)
- provider (ENUM: slack/teams)
- external_id (VARCHAR, slack_user_id / teams_user_id)
- workspace_id (VARCHAR)
- created_at (TIMESTAMPTZ)

**applications**
- id (UUID, PK)
- tenant_id (UUID, FK → tenants.id)
- name (VARCHAR)
- target_urls (JSONB, array of URLs)
- login_config (JSONB)
- keepalive_config (JSONB)
- export_policy (JSONB)
- notification_config (JSONB)
- browser_policy (JSONB, default: `{"downloads": false, "clipboard": false, "file_chooser": false}`)
- desired_session_count (INTEGER, default 1)
- credential_last_validated_at (TIMESTAMPTZ, nullable)
- credential_rotation_reminder_days (INTEGER, default 90)
- created_at (TIMESTAMPTZ)
- updated_at (TIMESTAMPTZ)

**sessions**
- id (UUID, PK)
- app_id (UUID, FK → applications.id)
- tenant_id (UUID, FK → tenants.id) — denormalized for query safety
- state (ENUM: STARTING/HEALTHY/UNHEALTHY/LOGIN_NEEDED/LOGIN_IN_PROGRESS/FAILED/TERMINATED)
- state_version (BIGINT, default 0) — optimistic locking for controller state transitions
- health_result_type (ENUM: PASS/TRANSIENT_FAIL/AUTH_FAIL, nullable)
- pod_name (VARCHAR)
- last_health_check (TIMESTAMPTZ)
- last_login_at (TIMESTAMPTZ)
- intervention_count (INTEGER, default 0)
- hitl_attempt_count (INTEGER, default 0)
- hitl_pause_until (TIMESTAMPTZ, nullable)
- artifacts_last_exported_at (TIMESTAMPTZ, nullable)
- started_at (TIMESTAMPTZ)
- retry_count (INTEGER, default 0)

**session_batons**
- session_id (UUID, PK, FK → sessions.id)
- baton_state (ENUM: AUTOMATION_CONTROL/HUMAN_REQUESTED/HUMAN_CONTROL/HUMAN_RELEASED)
- owner_user_id (UUID, FK → users.id, nullable)
- requested_at (TIMESTAMPTZ, nullable)
- acquired_at (TIMESTAMPTZ, nullable)
- expires_at (TIMESTAMPTZ, nullable)
- version (BIGINT, default 0) — compare-and-swap version for takeover/release
- updated_at (TIMESTAMPTZ)

**interventions**
- id (UUID, PK)
- session_id (UUID, FK → sessions.id)
- tenant_id (UUID, FK → tenants.id) — denormalized for query safety
- app_id (UUID, FK → applications.id) — denormalized for query safety
- started_at (TIMESTAMPTZ)
- completed_at (TIMESTAMPTZ, nullable)
- type (ENUM: OTP/CAPTCHA/MANUAL/OTHER)
- outcome (ENUM: SUCCESS/FAIL/TIMEOUT, nullable)
- human_note (TEXT, nullable)
- screenshots_ref (JSONB, array of MinIO object keys)

**artifact_bundles**
- id (UUID, PK)
- session_id (UUID, FK → sessions.id)
- app_id (UUID, FK → applications.id)
- tenant_id (UUID, FK → tenants.id)
- encrypted_payload_ref (VARCHAR, MinIO object key)
- storage_backend (ENUM: minio)
- nonce (BYTEA, 12 bytes) — AES-GCM nonce used for encryption
- key_version (VARCHAR) — identifies which key version encrypted this bundle
- exported_at (TIMESTAMPTZ)
- expires_at (TIMESTAMPTZ)

**artifact_consumptions**
- id (UUID, PK)
- artifact_id (UUID, FK → artifact_bundles.id)
- consumer_id (VARCHAR) — identifier of the consuming system
- token_id (VARCHAR) — one-time token identifier used for access
- consumed_at (TIMESTAMPTZ)
- access_method (ENUM: presigned_url/nats)

**audit_events**
- id (UUID, PK)
- sequence_num (BIGINT, auto-increment, unique) — for hash chain ordering
- tenant_id (UUID, FK → tenants.id, nullable for system events)
- timestamp (TIMESTAMPTZ)
- actor_type (ENUM: system/human)
- actor_id (VARCHAR)
- event_type (VARCHAR)
- payload (JSONB) — canonical JSON (sorted keys, no whitespace)
- prev_hash (VARCHAR(64), nullable — null for first event of each day)
- hash (VARCHAR(64)) — SHA256(prev_hash + canonical_payload)

**audit_anchors**
- id (UUID, PK)
- anchor_date (DATE, unique)
- root_hash (VARCHAR(64))
- event_count (INTEGER)
- created_at (TIMESTAMPTZ)

### 10.2 Validation Rules
- `login_config.steps` must include at least one `goto` action.
- `keepalive_config.interval_seconds` must be ≥ 60.
- `export_policy.ttl_seconds` must be ≥ 300.
- `notification_config.channels` cannot be empty.
- `notification_config.channels[]` must match format `{provider}:{reference}` where provider is `slack` or `teams`.
- `desired_session_count` must be ≥ 0 and ≤ tenant's `max_sessions`.
- `target_urls` must contain at least one valid HTTPS URL.
- `login_config.screenshot_policy.capture_on_error` defaults to `true`, but sensitive steps never capture.
- `login_config.steps[].sensitive` defaults to `false` if omitted.

### 10.3 Login DSL Semantics

Supported actions:

| Action | Parameters | Playwright API | Description |
|--------|-----------|---------------|-------------|
| `goto` | `url` | `page.goto(url)` | Navigate to URL |
| `fill` | `selector`, `value` | `page.fill(selector, value)` | Clear field and set value instantly |
| `type` | `selector`, `value` | `page.locator(selector).pressSequentially(value, {delay: 50})` | Type character-by-character (triggers JS validation events) |
| `click` | `selector` | `page.click(selector)` | Click element |
| `select` | `selector`, `value` | `page.selectOption(selector, value)` | Select dropdown option |
| `wait_for` | `selector`, `timeout_ms` | `page.waitForSelector(selector, {timeout})` | Wait for selector to appear |
| `wait_for_url` | `pattern`, `timeout_ms` | `page.waitForURL(pattern, {timeout})` | Wait for URL match (regex or glob) |
| `frame` | `selector` | `page.frameLocator(selector)` | Switch context into an iframe. Subsequent actions execute within this frame until next `frame` or `main_frame` action |
| `main_frame` | (none) | (reset to page) | Return to top-level frame context |
| `popup` | `timeout_ms` | `page.waitForEvent('popup', {timeout})` | Wait for popup window. Subsequent actions execute in the popup until `main_frame` |
| `keyboard` | `key` | `page.keyboard.press(key)` | Press a keyboard key (Enter, Tab, Escape, etc.) |
| `evaluate` | `expression` | `page.evaluate(expression)` | Execute arbitrary JS in page context. Use for edge cases (shadow DOM, cookie banners). Return value is discarded. |
| `sleep` | `ms` | `page.waitForTimeout(ms)` | Fixed wait |
| `screenshot` | (none) | `page.screenshot()` | Capture screenshot for debugging (stored in MinIO if enabled) |
| `reload` | (none) | `page.reload()` | Reload the current page. Commonly used in keepalive actions. |

Execution semantics:
- Steps execute sequentially and are blocking.
- Each step supports `timeout_ms` (default 30000).
- Step errors trigger retry up to `retry_count` (default 1).
- On repeated failure, session transitions to `LOGIN_NEEDED`.
- On step failure, a screenshot is captured only when `screenshot_policy.capture_on_error = true` and the step is non-sensitive.
- Sensitive steps (`password`, `otp`, or step with `sensitive: true`) never persist screenshots.
- Frame context (`frame`/`main_frame`) persists across steps until explicitly changed.

### 10.4 Health Predicate Evaluation

Evaluation logic:
- Default policy: **all checks must pass**.
- Optional `policy`: `all`, `any`, or `quorum` with `quorum_n`.
- A session is `UNHEALTHY` after 2 consecutive failed evaluations.
- Evaluation interval: from `keepalive_config.interval_seconds`.

**Executor:** The browser worker runs health predicates (see section 9.9 for isolation model).

**Result types:**

| Check Type | PASS | TRANSIENT_FAIL | AUTH_FAIL |
|-----------|------|----------------|-----------|
| `url_check` | HTTP status matches `expect_status` | HTTP timeout, 5xx, connection error | HTTP 401, 403, or redirect to login URL |
| `dom_check` | Selector found on page | Page loading/timeout | Selector not found after page is stable |
| `network_check` | HTTP status matches and body matches `body_contains` | HTTP timeout, 5xx | HTTP 401, 403, body mismatch |

### 10.5 Schemas (Examples)

**login_config**
```json
{
  "login_url": "https://app.example.com/login",
  "credential_ref": "k8s:secret/app-cred-1",
  "screenshot_policy": {"capture_on_error": true, "redact_sensitive": true},
  "steps": [
    {"action": "goto", "url": "https://app.example.com/login"},
    {"action": "fill", "selector": "#username", "value": "${USERNAME}"},
    {"action": "fill", "selector": "#password", "value": "${PASSWORD}", "sensitive": true},
    {"action": "click", "selector": "button[type=submit]"},
    {"action": "wait_for", "selector": "#otp", "timeout_ms": 120000, "sensitive": true}
  ],
  "otp_prompt": {"method": "chat", "field_selector": "#otp", "timeout_ms": 120000}
}
```

**login_config (SSO with iframe example)**
```json
{
  "login_url": "https://app.example.com/sso",
  "credential_ref": "k8s:secret/app-cred-sso",
  "steps": [
    {"action": "goto", "url": "https://app.example.com/sso"},
    {"action": "frame", "selector": "iframe#auth0-login"},
    {"action": "fill", "selector": "#email", "value": "${USERNAME}"},
    {"action": "click", "selector": "button[type=submit]"},
    {"action": "wait_for", "selector": "#password"},
    {"action": "type", "selector": "#password", "value": "${PASSWORD}"},
    {"action": "keyboard", "key": "Enter"},
    {"action": "main_frame"},
    {"action": "wait_for_url", "pattern": "**/dashboard**", "timeout_ms": 30000}
  ]
}
```

**keepalive_config**
```json
{
  "interval_seconds": 300,
  "actions": [
    {"action": "reload"},
    {"action": "click", "selector": "#refresh"}
  ],
  "health_checks": [
    {"type": "url_check", "url": "https://app.example.com/dashboard", "expect_status": 200},
    {"type": "dom_check", "selector": "#user-menu", "exists": true},
    {"type": "network_check", "url": "https://api.example.com/me", "expect_status": 200, "body_contains": "user_id"}
  ],
  "policy": "all"
}
```

**export_policy**
```json
{
  "artifact_types": ["cookies", "headers", "csrf_token", "local_storage", "session_storage"],
  "encryption": {"algo": "AES-256-GCM", "key_ref": "k8s:secret/tenant-key"},
  "ttl_seconds": 3600,
  "refresh_interval_seconds": 3600,
  "header_allowlist": ["Authorization", "X-CSRF-Token", "X-Session-ID"]
}
```

**notification_config**
```json
{
  "channels": ["slack:#ops-login", "teams:channel-id"],
  "escalation": {"after_minutes": 10, "notify": ["slack:#oncall"]}
}
```

Channel format: `{provider}:{reference}`. Provider is `slack` or `teams`. Reference is a channel name (with `#` prefix for Slack) or channel ID (for Teams).

### 10.6 Artifact Bundle Format

```json
{
  "version": "v1",
  "app_id": "...",
  "session_id": "...",
  "tenant_id": "...",
  "exported_at": "2026-02-18T12:00:00Z",
  "expires_at": "2026-02-18T13:00:00Z",
  "artifact_bundle_ref": "s3://artifact-bundles-{tenant_id}/{app_id}/{session_id}/{timestamp}.enc",
  "encryption": {
    "algo": "AES-256-GCM",
    "key_ref": "k8s:secret/tenant-key-{tenant_id}",
    "key_version": "v1",
    "nonce_bytes": 12
  }
}
```

**Encrypted blob structure:** `[nonce (12 bytes)] [ciphertext] [GCM auth tag (16 bytes)]`. The nonce is prepended to the ciphertext so it is available for decryption.

### 10.7 Artifact Storage Layout
- MinIO bucket per tenant: `artifact-bundles-{tenant_id}`.
- Object key format: `{app_id}/{session_id}/{exported_at_iso}.enc`.
- Object lifecycle: MinIO lifecycle rules set to `--expire-days` based on `ceil(export_policy.ttl_seconds / 86400)`. For sub-day TTL precision, a CronJob runs every 15 minutes and deletes objects where `expires_at` metadata has passed.
- Presigned URLs: MinIO generates presigned GET URLs with TTL of 10 minutes. Single-use is enforced at the application level via Redis (see section 13.6).

### 10.8 Artifact Extraction Pipeline
- **Cookies:** `context.cookies(target_urls)` filtered to target domains. Uses the URL filter parameter to scope cookies.
- **Headers (response):** Capture via `page.on('response')` event listener (passive, not `page.route()`). Use `response.allHeaders()` (not `response.headers()`, which filters security-related headers). Filter captured headers against `export_policy.header_allowlist`. Register listener before triggering login actions.
- **Headers (outbound request):** Capture via `page.on('request')` event listener. Use `request.allHeaders()` and filter against `export_policy.request_header_allowlist`. This surfaces JS-minted auth material (bearer JWTs, tenant keys) attached by fetch/axios interceptors that never appears in a response. Register listener before triggering login actions. The allowlist rejects `Cookie` (cookies have a dedicated extraction path) and wildcards. Both capture directions are scoped to `target_urls` globs when configured, and unioned into the bundle's `headers` field (shape `{ url: { headerName: value } }`); request-header values win on per-URL conflict.
- **CSRF token:** Extract from DOM selector (`page.locator(selector).inputValue()`) or meta tag (`page.evaluate(() => document.querySelector('meta[name="csrf-token"]')?.getAttribute('content'))`).
- **Local storage:** `page.evaluate(() => JSON.stringify(window.localStorage))`.
- **Session storage:** `page.evaluate(() => JSON.stringify(window.sessionStorage))`. Note: `context.storageState()` does NOT capture sessionStorage; explicit `page.evaluate()` is required.
- All extracted fields are validated against `export_policy.artifact_types` before encryption.
- **Memory management:** Release references to captured response objects promptly. Playwright route/response interception can leak memory in long-running processes. The session recycling policy (FR-34) provides the backstop.

---

## 11. Interfaces

### 11.1 Admin API (REST)

All list endpoints support pagination: `?limit={int}&offset={int}` (defaults: limit=50, offset=0). Responses include `{ data: [...], total: int, limit: int, offset: int }`.

All endpoints return errors in standard format:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "details": {}
  }
}
```

HTTP error codes: 400 (validation), 401 (unauthenticated), 403 (forbidden), 404 (not found), 409 (conflict), 429 (rate limited), 500 (internal).

**POST /login**
- Request: `{ email, password }`
- Response: `{ token, expires_at }`
- Rate limit: 5 requests per minute per IP

**POST /tenants**
- Create tenant (Admin only). Provisions MinIO bucket and encryption key (FR-37).
- Request: `{ name }`
- Response: `{ tenant_id }`

**GET /tenants**
- Response: paginated list of tenants

**POST /users**
- Create user (Admin only)
- Request: `{ email, password, role, tenant_id }`
- Response: `{ user_id }`

**GET /users**
- Response: paginated list of users for tenant

**GET /artifacts/{id}**
- Returns a presigned URL for the artifact bundle. Authorized for Admin and Operator roles.
- Records consumption in `artifact_consumptions` table.
- Response: `{ presigned_url, token_id, expires_at }`

**POST /apps**
- Request: `{ name, target_urls, login_config, keepalive_config, export_policy, notification_config, desired_session_count?, browser_policy? }`
- Validates against rules in 10.2.
- Response: `{ app_id }`

**GET /apps/{id}**
- Response: full app config

**GET /apps**
- Response: paginated list of apps for tenant

**PUT /apps/{id}**
- Update app configuration. Validates against 10.2.

**POST /apps/{id}/sessions/scale**
- Request: `{ desired_sessions: int }`
- Validates: `desired_sessions` ≤ tenant `max_sessions`.
- Persists to `applications.desired_session_count`.

**GET /sessions/{id}**
- Response: `{ id, app_id, tenant_id, state, health_result_type, pod_name, last_health_check, last_login_at, intervention_count, artifacts_last_exported_at }`

**GET /sessions**
- Response: paginated list of sessions for tenant

**GET /sessions/{id}/interventions**
- Response: paginated list of interventions for session

### 11.2 HITL API

**POST /sessions/{id}/stream**
- Generates signed stream URL (JWT with `jti`, session binding, 10-minute TTL, single-use via Redis).
- Response: `{ url, expires_at }`
- Rate limit: 3 requests per minute per user

**POST /sessions/{id}/takeover**
- Locks baton to the requesting user. Requires `session_batons.baton_state = HUMAN_REQUESTED` and session state `LOGIN_IN_PROGRESS`.
- Response: `{ baton_state: "HUMAN_CONTROL", expires_at }`

**POST /sessions/{id}/release**
- Releases baton. Allowed for baton owner or Admin. Triggers "what happened?" prompt in chat.
- Response: `{ baton_state: "HUMAN_RELEASED" }`

**POST /sessions/{id}/otp**
- Submits OTP value for relay to browser worker via Redis.
- Request: `{ otp_value }`
- Response: `{ status: "delivered" }`
- The OTP value is written to Redis and deleted after the worker reads it. Never logged.

**POST /sessions/{id}/acknowledge**
- Acknowledges a FAILED session, transitioning it to STARTING for re-creation.
- Requires Operator or Admin role.
- If `hitl_pause_until` is in the future, returns `409` with `{ retry_after_seconds }`.
- Response: `{ state: "STARTING" }`

### 11.3 Auth Model
- Admin UI uses JWT issued by API after basic username/password login.
- Passwords are hashed with bcrypt (cost factor 12); minimum length 12 characters.
- **Bootstrap flow:** On first startup, if no tenants exist in the database, the API creates: (1) a tenant with name `BOOTSTRAP_TENANT_NAME`, (2) an admin user with `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD`, (3) provisions MinIO bucket and encryption key for the bootstrap tenant. This operation is idempotent -- subsequent restarts skip if a tenant already exists.
- JWT includes `tenant_id`, `user_id`, and `role`. Signed with `JWT_SIGNING_KEY`. TTL: 24 hours.
- JWT supports key rotation via `JWT_SIGNING_KEY_ID`. On rotation, add new key; keep old key for validation until existing tokens expire.
- Slack/Teams bot uses bot token and tenant mapping table.

### 11.4 NATS Subjects
- `auth.bundle.exported.{tenant_id}.{app_id}` — artifact export metadata
- `session.state.changed.{tenant_id}.{session_id}` — session state transitions
- `hitl.started.{tenant_id}.{session_id}` — HITL request initiated
- `hitl.completed.{tenant_id}.{session_id}` — HITL completed
- `hitl.otp-requested.{tenant_id}.{session_id}` — OTP needed from human

**Subject naming convention:** All action tokens are single NATS tokens (no dots within the action name). Use hyphens for compound actions (e.g., `otp-requested` not `otp.requested`) so that NATS `*` wildcard matches correctly.

All subjects include `tenant_id` for consistent ACL scoping.

### 11.5 Streaming Provider Interface (BrowserStreamProvider)

This interface abstracts the streaming implementation so that VNC can be swapped for CDP without changing external APIs.

```typescript
interface BrowserStreamProvider {
  /**
   * Start streaming for a session. Activates the VNC/CDP streaming pipeline.
   * Returns a handle that can be used to stop streaming.
   */
  startStream(sessionId: string): Promise<StreamHandle>;

  /**
   * Stop streaming for a session. Deactivates the streaming pipeline.
   */
  stopStream(sessionId: string): Promise<void>;

  /**
   * Generate a signed, short-lived URL for the stream viewer.
   * The URL includes a JWT with session binding and single-use enforcement.
   */
  getStreamUrl(sessionId: string, userId: string): Promise<{ url: string; expires_at: string }>;

  /**
   * Send a user input event to the browser session.
   * Used when input is relayed from the viewer to the browser.
   */
  sendInput(sessionId: string, event: InputEvent): Promise<void>;

  /**
   * Check if streaming is currently active for a session.
   */
  isStreaming(sessionId: string): Promise<boolean>;

  /**
   * Get the current frame rate and connection quality metrics.
   */
  getStreamMetrics(sessionId: string): Promise<StreamMetrics>;
}

interface StreamHandle {
  sessionId: string;
  startedAt: string;
}

interface InputEvent {
  type: 'mouse' | 'keyboard';
  // Mouse: x, y, button, action (click/move/scroll)
  // Keyboard: key, action (keydown/keyup/keypress)
  data: Record<string, unknown>;
}

interface StreamMetrics {
  fps: number;
  latencyMs: number;
  connected: boolean;
}
```

**V1 implementation:** `VncStreamProvider` — manages the noVNC/websockify stack. `startStream` enables noVNC access. `stopStream` disables it. `getStreamUrl` generates a JWT-signed noVNC URL. `sendInput` is handled natively by VNC.

**V2 implementation:** `CdpStreamProvider` — uses CDP `Page.startScreencast` + `Input.dispatch*`. Same interface. Swap is transparent.

### 11.6 WebSocket Events (Admin UI Real-Time)

**WS /events**
- Requires JWT authentication (token in query parameter or first message).
- Server subscribes to NATS subjects for the authenticated tenant and relays events to the WebSocket client.
- Events relayed: session state changes, HITL requests, artifact exports.
- Event format:
```json
{
  "type": "session.state.changed",
  "timestamp": "2026-02-18T12:00:00Z",
  "payload": { "session_id": "...", "old_state": "HEALTHY", "new_state": "UNHEALTHY" }
}
```

### 11.7 Endpoint Authorization Matrix

| Endpoint | Admin | Operator | Viewer |
|---|---|---|---|
| `POST /tenants` | Yes | No | No |
| `GET /tenants` | Yes | No | No |
| `POST /users` | Yes | No | No |
| `GET /users` | Yes | Yes | No |
| `POST /apps` | Yes | Yes | No |
| `PUT /apps/{id}` | Yes | Yes | No |
| `GET /apps` / `GET /apps/{id}` | Yes | Yes | Yes |
| `POST /apps/{id}/sessions/scale` | Yes | Yes | No |
| `GET /sessions` / `GET /sessions/{id}` | Yes | Yes | Yes |
| `GET /sessions/{id}/interventions` | Yes | Yes | Yes |
| `POST /sessions/{id}/stream` | Yes | Yes | Yes |
| `POST /sessions/{id}/takeover` | Yes | Yes | Yes |
| `POST /sessions/{id}/release` | Yes | Yes | Yes |
| `POST /sessions/{id}/otp` | Yes | Yes | Yes |
| `POST /sessions/{id}/acknowledge` | Yes | Yes | No |
| `GET /artifacts/{id}` | Yes | Yes | No |

---

## 12. HITL Interaction Flows

### 12.1 Slack/Teams Flow
1. System detects login needed.
2. Bot posts message with context (app name, session ID, reason) and buttons: `Open Stream`, `Submit OTP`.
3. User clicks `Open Stream` and acknowledges consent.
4. System generates signed stream URL and opens viewer.
5. User completes MFA/CAPTCHA in stream.
6. User clicks `Release Control`.
7. Bot prompts: "Anything unusual?" and stores note in `interventions.human_note`.

### 12.2 OTP Flow
1. Worker detects OTP field needed and publishes `hitl.otp-requested.{tenant_id}.{session_id}` to NATS.
2. Bot prompts user: "Please enter the OTP code for {app_name}."
3. User replies with OTP.
4. Bot calls `POST /sessions/{id}/otp` with the value.
5. API writes OTP to Redis `otp:{session_id}` with 60-second TTL.
6. Worker reads OTP from Redis, fills the field, deletes the key.
7. OTP value is never logged or persisted beyond the 60-second Redis TTL.

### 12.3 Timeout Handling
- If no human response in 10 minutes, session marked FAILED and escalated to `notification_config.escalation.notify`.
- Consecutive HITL failure handling follows section 9.10: after 3 failed attempts, set `hitl_pause_until = now + 30 minutes` and block new HITL until pause expires.

### 12.4 Viewer UX Requirements (MVP)
- Display live frame at 1-5 FPS minimum.
- Capture mouse and keyboard input with focus indicator.
- Disable clipboard by default (configurable via `browser_policy.clipboard`).
- Provide explicit "Release Control" button.
- Show session timer and idle timeout countdown (5-minute inactivity limit).
- Degrade to periodic screenshots if frame rate drops below 1 FPS for >30 seconds.

---

## 13. Security Model

### 13.1 Enterprise-Grade MVP Controls
- No credential logging. Credential values (`${USERNAME}`, `${PASSWORD}`) are resolved in the worker process memory only. They are never serialized to logs, audit events, or screenshots.
- Error screenshots are disabled for sensitive login steps (password/OTP) and any step marked `sensitive: true`.
- Signed stream URLs with JWT, 10-minute TTL, single-use enforcement via Redis.
- Stream tokens bound to `session_id` and `user_id` as JWT claims.
- Network policies deny-all egress by default and only allow DNS/internal/egress-proxy traffic. Domain allowlisting from `target_urls` is enforced by the egress proxy.
- Secrets stored per tenant namespace.
- Artifact encryption AES-256-GCM with per-tenant key. Encryption happens in the worker process.
- Audit logs append-only with **tamper-evident hash chain** (daily hash anchor table).
- CDP/VNC ports bound to localhost inside pod.
- NATS ACLs enforce per-tenant subject permissions.
- MinIO buckets partitioned per tenant with SSE enabled.
- SBOM generated per build, signed with `cosign`, and stored with release artifacts.
- API rate limits: `/login` 5/min/IP, `/sessions/{id}/stream` 3/min/user, all other endpoints 60/min/user.

### 13.2 Browser Hardening Flags (MVP)
- Run Chromium as non-root user (`pwuser`) with `--user-data-dir=/tmp/profile`.
- Required flags:
  - `--no-sandbox` (required in container environments; container is the security boundary)
  - `--no-first-run`
  - `--disable-extensions`
  - `--disable-background-networking`
  - `--disable-sync`
  - `--metrics-recording-only`
  - `--disable-default-apps`
  - `--mute-audio`
  - `--remote-debugging-address=127.0.0.1`
  - `--enable-automation` (disables password-save UI and infobar animations)
  - `--password-store=basic` (avoids Gnome Keyring/KDE wallet issues)
  - `--disable-component-extensions-with-background-pages`
  - `--disable-client-side-phishing-detection`

**Canonical launch command (MVP)**
```
chromium \
  --no-sandbox \
  --user-data-dir=/tmp/profile \
  --no-first-run \
  --disable-extensions \
  --disable-background-networking \
  --disable-sync \
  --metrics-recording-only \
  --disable-default-apps \
  --mute-audio \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --disable-dev-shm-usage \
  --disable-gpu \
  --enable-automation \
  --password-store=basic \
  --disable-component-extensions-with-background-pages \
  --disable-client-side-phishing-detection
```

**Compensating controls for `--no-sandbox`:**
- Chromium runs as non-root user `pwuser` (UID 1000).
- Network egress is restricted by Kubernetes NetworkPolicies.
- The container filesystem is read-only except for `/tmp`.
- Pod security context: `runAsNonRoot: true`, `readOnlyRootFilesystem: true`.
- No `SYS_ADMIN` or other elevated capabilities.

### 13.3 Key Management (MVP)
- Per-tenant AES-256-GCM Data Encryption Keys (DEKs) stored in K8s Secrets as `tenant-key-{tenant_id}`.
- Each encryption operation generates a 12-byte (96-bit) random nonce from a CSPRNG (`crypto.randomBytes(12)` in Node.js).
- Nonce is prepended to the ciphertext: `[nonce (12 bytes)] [ciphertext] [GCM auth tag (16 bytes)]`.
- `key_version` is included in artifact metadata to support future rotation.
- At MVP scale (~20 tenants, thousands of artifacts), random nonce collision probability is negligible (birthday bound: ~2^32 operations per key before concern).
- Rotation: manual, quarterly default. New bundles use new key version. Re-encryption of old bundles not required for MVP.

### 13.4 NATS ACL Model (MVP)
- One NATS account per tenant.
- Publisher subjects: `auth.bundle.exported.{tenant_id}.*` (only for that tenant's apps).
- Subscriber subjects: `auth.bundle.exported.{tenant_id}.*` (consumer accounts scoped by tenant).
- No wildcard subscriptions across tenants.
- Use NATS JWT-based resolver (not MEMORY resolver) for dynamic account provisioning without server restarts.

**Minimal NATS config snippet (illustrative)**
```
accounts: {
  tenant_abc123: {
    users: [{user: "tenant_abc123_pub", password: "..."}, {user: "tenant_abc123_sub", password: "..."}],
    permissions: {
      publish: ["auth.bundle.exported.tenant_abc123.*", "session.state.changed.tenant_abc123.*", "hitl.*.tenant_abc123.*"],
      subscribe: ["auth.bundle.exported.tenant_abc123.*", "session.state.changed.tenant_abc123.*", "hitl.*.tenant_abc123.*"]
    }
  }
}
```

### 13.5 Audit Hash Chain Details
- Each audit event includes `prev_hash` and `hash = SHA256(prev_hash + canonical_payload)`.
- **Canonical payload:** JSON with sorted keys, no whitespace, UTF-8 normalized. Computed deterministically before hashing.
- **Concurrency control:** All audit event inserts are serialized via `pg_advisory_lock(42)` (fixed lock ID). This ensures strict sequential ordering. Throughput: ~1,000-5,000 writes/sec (adequate for MVP).
- Daily anchor stored in `audit_anchors` table: `{anchor_date, root_hash, event_count}`.
- Anchor is computed at midnight UTC by a scheduled job that reads the last event's hash for the day.

**Verification procedure (MVP)**
1. Load all audit events for date D ordered by `sequence_num`.
2. Recompute hash chain: for each event, verify `hash == SHA256(prev_hash + canonical_payload)`.
3. Compare final hash to `audit_anchors.root_hash` for D.
4. Emit verification report with pass/fail status and any broken links.
5. Verification can run concurrently with writes (reads are isolated by date boundary).

### 13.6 Single-Use Token Enforcement (Stream URLs and Artifact URLs)

**Stream URLs:**
1. API generates JWT with unique `jti` (UUID), `session_id`, `user_id`, `exp` (now + 10 minutes).
2. API stores issuance marker: `SET stream_token:{jti} issued EX 600 NX`.
3. On stream connection attempt:
   a. Validate JWT signature and expiration.
   b. Execute Redis Lua CAS script:
      - if key value == `issued`, set value to `consumed` (keep TTL), return allow
      - else return deny
4. First valid access succeeds; replay attempts fail.
5. **Failure mode:** If Redis is unavailable, fail-closed (reject all stream connections).

**Artifact presigned URLs:**
1. API generates MinIO presigned GET URL with 10-minute TTL and a `token_id` query parameter.
2. API stores issuance marker: `SET artifact_token:{token_id} issued EX 600 NX`.
3. A lightweight proxy (NGINX `auth_request` or API middleware) runs Redis Lua CAS:
   - `issued` -> `consumed` (allow)
   - otherwise deny
4. API records successful first access in `artifact_consumptions`.
5. Replay attempts with same URL/token are rejected.

### 13.7 OTP Ephemeral Controls
- OTP Redis keys (`otp:{session_id}`) have 60-second TTL.
- Worker deletes the key immediately after reading (`DEL otp:{session_id}`).
- Redis must have `slowlog-log-slower-than` configured to avoid capturing OTP SET commands in slow log, OR use a dedicated Redis instance for OTP relay.
- If Redis AOF is enabled, expired keys are not persisted after AOF rewrite.
- OTP values are never logged, never written to Postgres, never included in audit events.

### 13.8 Network Policy Generation
- The session controller dynamically generates Kubernetes NetworkPolicies for each browser worker pod.
- Policy: deny-all egress by default. Allow egress to:
  - DNS (UDP 53, TCP 53) to cluster DNS service.
  - Egress policy proxy service (HTTP/HTTPS).
  - Internal cluster services: Postgres, Redis, NATS, MinIO (by service CIDR or name).
- Domain allowlist from `applications.target_urls` is enforced at the egress proxy layer (FQDN-aware), not by native NetworkPolicy.
- Policy: deny-all ingress by default. Allow ingress from:
  - Session controller service (optional `/status` secondary verification).
  - noVNC sidecar to x11vnc (localhost within pod, implicit).
  - NGINX ingress to noVNC port 6080 (for stream viewer).
- Kubernetes probes originate from kubelet/node. If CNI enforces host-to-pod traffic, add node CIDR allowlist for probe ports.
- NetworkPolicies are created when the pod starts and deleted when the pod is terminated.
- Controller's ServiceAccount requires RBAC: `create`, `update`, `delete` on `networkpolicies` in the worker namespace.

---

## 14. Observability

### Metrics
- Session uptime percentage per app.
- Time to first frame.
- HITL latency (time from notification to human response).
- Human intervention rate per app (key business metric).
- Export success rate.
- Browser worker memory usage per pod.

### Logs
- Structured JSON logs with request IDs and session IDs.
- NestJS: use `@nestjs/terminus` for health endpoints. Set `--max-old-space-size=1024` to prevent OOM in Kubernetes.
- All services call `enableShutdownHooks()` for graceful SIGTERM handling.

### Tracing
- `@opentelemetry/auto-instrumentations-node` for HTTP, database, NATS auto-instrumentation.
- Manual spans for: state machine transitions, HITL events, artifact extraction, login DSL steps.
- Export via OTLP to cluster-local OpenTelemetry Collector.
- Development: Jaeger all-in-one for trace visualization.

### Retention
- Audit events retained for 90 days default, configurable per tenant.

---

## 15. Deployment (Kubernetes)

### 15.1 Monorepo Structure

```
/
├── apps/
│   ├── api/                  # NestJS API service
│   ├── controller/           # NestJS standalone session controller
│   ├── worker/               # Node.js browser worker
│   ├── slack-bot/            # NestJS microservice (@slack/bolt)
│   ├── teams-bot/            # NestJS microservice (botbuilder)
│   └── admin-ui/             # Next.js admin UI
├── packages/
│   └── shared/               # Shared TypeScript types, schemas, validation
├── charts/
│   └── browser-hitl/         # Helm chart (umbrella)
├── infra/
│   ├── docker/               # Dockerfiles
│   └── ci/                   # GitHub Actions workflows
├── test-harness/             # Python/FastAPI mock web app for CI/UAT
├── nx.json
├── pnpm-workspace.yaml
└── package.json
```

Tooling: pnpm workspaces + NX for build orchestration.

### 15.2 Helm Chart Components
- `admin-ui`
- `api`
- `session-controller`
- `browser-worker` (template for dynamic pod creation by controller)
- `slack-bot`
- `teams-bot`
- `postgres`
- `redis`
- `nats`
- `artifact-store` (MinIO required for MVP)
- `egress-proxy` (required for strict domain allowlisting)
- `ingress`
- `test-harness` (optional, for CI/UAT)

### 15.3 Ports and Endpoints
- API service: `:8080`
- API WebSocket: `:8080/events` (same server, upgraded connection)
- Session controller health: `:8090`
- Browser worker health: `:8091`
- noVNC web: `:6080` (accessible via ingress with stream token)
- VNC server: `:5900` (localhost within pod only)
- x11vnc: `:5900` bound to `127.0.0.1` (pod-internal only)

### 15.4 Runtime Configuration (Env Vars)
- `DATABASE_URL`
- `REDIS_URL`
- `NATS_URL`
- `MINIO_ENDPOINT`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `JWT_SIGNING_KEY`
- `JWT_SIGNING_KEY_ID` (for key rotation support)
- `ADMIN_BOOTSTRAP_EMAIL`
- `ADMIN_BOOTSTRAP_PASSWORD`
- `BOOTSTRAP_TENANT_NAME`
- `STREAM_TTL_SECONDS` (default: 600)
- `DEFAULT_BACKOFF_SECONDS` (default: 30)
- `DEFAULT_KEEPALIVE_SECONDS` (default: 300)
- `RECONCILE_INTERVAL_SECONDS` (default: 15)
- `MAX_SESSION_AGE_HOURS` (default: 24)
- `NATS_SYNC_INTERVAL` (must be set to `always`)
- `EGRESS_PROXY_URL` (e.g., `http://egress-proxy:3128`)

**Worker-specific env vars (set per pod by the controller):**
- `SESSION_ID` — UUID of the session this worker manages. Used for DB row-level scoping and Redis key namespacing.
- `APP_ID` — UUID of the application this session belongs to.
- `TENANT_ID` — UUID of the tenant. Used for MinIO bucket resolution and NATS subject scoping.
- `CREDENTIAL_SECRET_NAME` — Name of the K8s Secret containing application credentials.

### 15.5 Browser Worker Pod Architecture

**Container 1: Worker (main)**
- Base image: `mcr.microsoft.com/playwright:v1.50.0-noble` (official Playwright Docker image, Ubuntu-based, includes Chromium)
- Additional packages: `xvfb`, `x11vnc` (installed via apt)
- Runtime: Node.js with Playwright
- Process management: Worker entrypoint script manages Xvfb and x11vnc
- Startup sequence:
  1. Clean stale lock files: `rm -f /tmp/.X99-lock /tmp/.X11-unix/X99`
  2. Start Xvfb: `Xvfb :99 -screen 0 1920x1080x24 &`
  3. Wait for X11 socket: poll for `/tmp/.X11-unix/X99`
  4. Set `DISPLAY=:99`
  5. Start x11vnc: `x11vnc -display :99 -forever -nopw -rfbport 5900 -listen 127.0.0.1 &`
  6. Start Playwright with Chromium in headed mode (uses Xvfb display)
  7. Start worker HTTP health server on `:8091`
  8. Begin login DSL execution
- `DISPLAY=:99` is set for the entire container
- Playwright launches Chromium with `headless: false` to render in Xvfb

**Container 2: noVNC sidecar**
- Base image: lightweight Python image with noVNC + websockify
- Runs: `websockify --web /usr/share/novnc 6080 localhost:5900`
- websockify connects to x11vnc via `localhost:5900` (shared network namespace in pod)
- noVNC served on `0.0.0.0:6080`, protected by stream token validation at ingress layer
- Uses websockify `JWTTokenApi` plugin or NGINX `auth_request` for token validation

**Shared volume:** `emptyDir` mounted at `/tmp` for Xvfb socket, user-data-dir, and temporary files.

**Why this architecture:** Xvfb and Chromium must share IPC namespace for MIT-SHM (shared memory). Running them in the same container avoids the IPC sharing issue. x11vnc connects to Xvfb via localhost. noVNC/websockify runs in a sidecar for separation of concerns.

### 15.6 Container Image Definitions

**Worker image (`Dockerfile.worker`):**
```dockerfile
FROM mcr.microsoft.com/playwright:v1.50.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker
RUN cd apps/worker && pnpm install --frozen-lockfile && pnpm build
USER pwuser
CMD ["node", "apps/worker/dist/main.js"]
```

**API image (`Dockerfile.api`):**
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN cd apps/api && pnpm install --frozen-lockfile && pnpm build
USER node
CMD ["node", "--max-old-space-size=1024", "apps/api/dist/main.js"]
```

Pin Playwright version in `package.json`. Chromium version is locked to the Playwright-bundled browser (do not install separately).

### 15.7 Resource Baselines
- Browser worker request: 1 vCPU, 2 GB RAM
- Browser worker limit: 2 vCPU, 3 GB RAM
- Controller request: 0.5 vCPU, 512 MB RAM
- API request: 0.5 vCPU, 512 MB RAM
- Slack/Teams bot request: 0.25 vCPU, 256 MB RAM each

### 15.8 Network Policies
- Dynamically generated per browser worker pod (see section 13.8): deny-all + allow DNS/internal/egress-proxy.
- Static policies for API, controller, and bots: allow only intra-namespace traffic + ingress.

### 15.9 SBOM Pipeline
- Generate SBOM via `syft` on each container image build.
- Output: CycloneDX JSON format.
- Sign SBOM with `cosign sign-blob` and store signature alongside the SBOM.
- Verify signatures before SBOM review.
- SBOM and signatures stored in the container registry alongside image manifests.

### 15.10 Stateful Service Defaults
- Postgres: single replica, 20Gi PVC, storage class configurable.
- Redis: single replica, 5Gi PVC (or emptyDir for dev). Disable AOF for the OTP Redis instance if using a shared instance.
- MinIO: single replica, 50Gi PVC, bucket lifecycle enabled.
- NATS JetStream: single replica, 10Gi PVC, `sync_interval: always` (MANDATORY), retention aligned to audit policy.

### 15.11 Cluster Defaults (Local/VPS)
- Kubernetes: v1.29+ recommended (native sidecar support).
- Ingress: NGINX ingress controller.
- Storage class: `local-path` default (k3s) or `standard` if available.
- K8s encryption at rest must be enabled for Secrets.

### 15.12 Cluster Sizing Guide

| Concurrent Sessions | Worker vCPU (limit) | Worker RAM (limit) | Total Cluster vCPU | Total Cluster RAM | Notes |
|---------------------|--------------------|--------------------|-------------------|-------------------|-------|
| 5 | 10 | 15 GB | ~16 | ~24 GB | Minimum viable. Tight. |
| 10 | 20 | 30 GB | ~28 | ~44 GB | Comfortable for pilot. |
| 20 | 40 | 60 GB | ~52 | ~80 GB | Full MVP target. |

Includes overhead for API, controller, Postgres, Redis, NATS, MinIO, ingress (~8-12 vCPU, ~16-20 GB RAM).

### 15.13 Database Migration Strategy
- **Tool:** TypeORM with migration files.
- **Location:** `apps/api/src/migrations/`
- **Naming:** `{timestamp}-{description}.ts` (e.g., `1708300000000-InitialSchema.ts`)
- **Execution:** Migrations run automatically on API service startup. Uses `pg_advisory_lock(1)` to prevent concurrent migrations from multiple API replicas.
- **Initial migration:** Creates all tables from section 10.1.
- **Security migration:** Enables PostgreSQL RLS on worker-accessed tables and creates policies bound to `current_setting('app.session_id')`.
- **Rollback:** Each migration includes `up()` and `down()` methods.

### 15.14 CI/CD Pipeline (GitHub Actions)

```yaml
# .github/workflows/ci.yml (structure)
name: CI
on: [push, pull_request]
jobs:
  lint:
    - pnpm lint (NX affected)
  test:
    - pnpm test (NX affected, includes unit + integration)
  build:
    - Build Docker images for api, controller, worker, slack-bot, teams-bot, admin-ui
    - Generate SBOM via syft for each image
    - Sign SBOM with cosign
  e2e:
    - Deploy test-harness + services to ephemeral K8s (k3d or kind)
    - Run E2E HITL tests with mock OTP
  publish:
    - Push images to registry (on main branch)
    - Push Helm chart to chart registry
```

---

## 16. Testing and Validation

### 16.1 Automated Tests
- Unit tests for session state machine transitions (all transitions in 9.1).
- Unit tests for baton state machine transitions (all transitions in 9.2).
- Unit tests for login DSL validation rules.
- Unit tests for health predicate evaluation (all result types).
- Integration tests for artifact export pipeline (extraction → encryption → MinIO write → NATS publish).
- Integration tests for NATS ACL enforcement by tenant.
- Integration tests for audit hash chain integrity.
- Integration tests for NetworkPolicy + egress proxy config generation from `target_urls`.
- E2E test that exercises full HITL flow with mock OTP.
- Negative tests for OTP wrong and timeout.
- Negative tests for stream URL replay (single-use enforcement).

### 16.2 Manual Verification
- Human takeover works at least 5 times consecutively.
- Session teardown removes cookies and storage.

### 16.3 Security Tests
- Stream URL replay test fails (single-use enforcement).
- CDP/VNC ports not reachable outside cluster.
- NATS ACL denies cross-tenant access.
- Artifact presigned URL replay test fails.
- Network policy and egress proxy deny browser egress to non-allowlisted domains.

### 16.4 Test Harness App
Build a mock web app (Python/FastAPI) for CI/UAT with:
- Username/password login page
- OTP prompt page with fixed test code (`123456`)
- Logout endpoint to force auth loss
- Protected page with user-menu DOM element for health check validation
- `/api/me` endpoint returning JSON with `user_id` for network_check validation
- Containerized for local/VPS deployment
- Port easily to Node if required
- **This must be built FIRST (Phase 0) as the development fixture for all other phases.**

---

## 17. Red-Team Checks

### R1: Abuse / Account Lockout
- Mitigation: exponential backoff and retry ceiling (max 5 login attempts per hour per app).

### R2: Leakage of Credentials
- Mitigation: credentials resolved only in worker process memory. Redact logs, avoid screenshot persistence of login pages, encrypt artifacts.

### R3: Streaming Token Replay
- Mitigation: single-use tokens enforced via Redis Lua CAS (`issued` -> `consumed`) + TTL + session binding.

### R4: VNC Licensing Risk
- Mitigation: VNC only in V1; CDP provider planned. BrowserStreamProvider abstraction enforced from day 1.

### R5: Human Error in HITL
- Mitigation: explicit checkpoints + audit trail + inactivity timeout.

### R6: Artifact Exfiltration
- Mitigation: encrypt bundles in worker, restrict NATS ACLs, audit consumption via `artifact_consumptions` table.

### R7: OTP Interception
- Mitigation: OTP in Redis for ≤60 seconds, deleted immediately after use, never logged, never persisted to Postgres.

### R8: Audit Log Tampering
- Mitigation: hash chain with daily anchors. Serialized writes via advisory lock. Anchors should be exported to external immutable store post-MVP.

---

## 18. Logical Dependency Chain (sympy-validated)

MVP_READY =
```
ArtifactExport & Audit & AuthDetect & Backoff & CPUOnly & DetermTeardown & HITL &
HealthPred & K8s & MultiTenant & Observability & OnPrem & SecretsMgmt &
SecureStream & SessionOrch & Stream & VncCdpSwap & StreamAbstraction &
OtpRelay & SessionRecycling & NetworkPolicyGen
```
Constraints:
- HITL -> Stream
- Stream -> SecureStream
- Stream -> StreamAbstraction
- SessionOrch -> K8s
- AuthDetect -> SessionOrch
- ArtifactExport -> SecretsMgmt
- Audit -> Observability
- HealthPred -> AuthDetect
- Backoff -> SessionOrch
- OtpRelay -> HITL
- NetworkPolicyGen -> SessionOrch
- SessionRecycling -> SessionOrch

Satisfiable: **True**

---

## 19. Sanity Check

- Scope is limited to always-on login sessions with HITL.
- Platform sprawl is avoided by deferring workflow automation and knowledge plane.
- MVP is deliverable in 6-8 weeks if scope is held (extended from original 4-6 due to added specification detail).
- All integration seams (controller-worker, bot-worker OTP relay, UI WebSocket) are explicitly defined.
- All state machine transitions are enumerated with triggers and timeouts.
- All data model fields are specified with types.
- All API endpoints have request/response formats.

---

## 20. Agentic Implementation Blueprint

### 20.1 Build Order
0. Build test harness app (development fixture).
1. Scaffold monorepo (pnpm + NX) + shared types package.
2. Scaffold API + DB schema (TypeORM migrations) + auth + bootstrap flow.
3. Implement session/baton persistence (`sessions`, `session_batons`) and state transition CAS.
4. Implement BrowserStreamProvider interface + VncStreamProvider.
5. Implement session controller state machine + reconcile loop.
6. Implement browser worker with Playwright + Xvfb + login DSL + keepalive + health predicates.
7. Implement VNC streaming sidecar and signed URL generation.
8. Implement Slack bot integration + OTP relay.
9. Implement Teams bot integration.
10. Implement artifact extraction + encryption + MinIO export pipeline.
11. Implement NATS export + ACLs.
12. Add audit logging with hash chain + daily anchors.
13. Add observability (metrics, traces, structured logs).
14. Add session recycling.
15. Add network policy generation and egress proxy allowlist sync.
16. Add Helm charts + SBOM pipeline + CI/CD.

### 20.2 Critical Milestones for Deep Human Review
1. Security review of streaming token model, NATS ACLs, and encryption pipeline.
2. Compliance review of licensing and SBOM output.
3. Operational review of session state machine, recovery, and recycling.
4. Network policy and egress proxy review (verify deny-all + allowlist works for target apps).

### 20.3 Task Plan Reference
See `MVP_TASK_PLAN.md` for the full task-level plan.

### 20.4 Agent Integration Contract
See `AGENT_INTEGRATION_CONTRACT.md` for the minimal external orchestration contract (agent initiation, HITL pause/resume, artifact consumption).

---

## 21. Open Questions

- No blocking open questions for MVP implementation.
- CDP migration trigger is explicitly decided at post-first-release human/team review checkpoint (Decision D16).
- NATS account provisioning is explicitly decided as JWT-based resolver (Decision D17).

---

## 22. Implementation Readiness Appendix

### 22.1 End State and Success Outcomes
- Always-on sessions running per app with stable health checks.
- HITL takeover and release flows succeed with audit evidence.
- Artifacts exported, encrypted, and consumable by downstream systems.
- On-prem deployment passes SBOM and audit checks.
- All state machine transitions tested and documented.
- All integration seams (controller-worker, OTP relay, WebSocket) functional.

### 22.2 Component Implementation Checklists

**Test Harness App**
1. Implement login page (username + password).
2. Implement OTP page (fixed code 123456).
3. Implement logout endpoint.
4. Implement protected page with `#user-menu` selector.
5. Implement `/api/me` endpoint returning JSON.
6. Containerize with Dockerfile.

**API Service**
1. Implement TypeORM migrations for all tables in 10.1.
2. Implement bootstrap flow (tenant + admin creation on first startup).
3. Implement JWT auth with bcrypt password hashing (cost 12).
4. Implement tenant, user, app, session CRUD endpoints with pagination.
5. Implement RBAC guards on all endpoints.
6. Implement tenant provisioning pipeline (MinIO bucket + encryption key).
7. Implement error response format (section 11.1).
8. Implement WebSocket events endpoint (section 11.6).
9. Implement rate limiting middleware.
10. Implement endpoint authorization matrix (section 11.7).
11. Emit audit events for all state changes.

**Session Controller**
1. Implement reconcile loop with configurable interval.
2. Implement session state machine (all transitions in 9.1 table).
3. Implement health status reading from sessions table.
4. Implement optimistic locking for state transitions (`state_version` CAS).
5. Implement backoff and retry logic (matrix in 9.4).
6. Implement HITL triggers (publish to NATS).
7. Implement `session_batons` takeover/release CAS semantics.
8. Implement NetworkPolicy generation + egress-proxy allowlist updates (section 13.8).
9. Implement session recycling checks (FR-34).
10. Implement `POST /sessions/{id}/acknowledge` flow.

**Browser Worker**
1. Implement container with Xvfb + x11vnc + Playwright (section 15.5).
2. Implement startup sequence with lock file cleanup.
3. Launch Chromium with full hardened flag set (section 13.2).
4. Implement login DSL runner with all 15 actions (section 10.3).
5. Implement OTP relay polling from Redis (section 9.7).
6. Implement keepalive runner on schedule.
7. Implement health predicate evaluation with result types (section 9.9).
8. Implement artifact extraction pipeline (section 10.8) using `page.on('response')`.
9. Implement AES-256-GCM encryption with nonce management (section 13.3).
10. Implement MinIO upload for encrypted artifacts.
11. Implement NATS publish for export metadata.
12. Write health/status fields to Postgres (controller owns `sessions.state` transitions).
13. Implement health HTTP endpoint on :8091.
14. Implement session recycling trigger (memory watermark, max age).
15. Implement screenshot fallback mode (FR-36).

**Streaming (VNC)**
1. Implement VncStreamProvider (section 11.5).
2. Build noVNC sidecar container.
3. Implement stream token generation (JWT with jti, session binding, TTL).
4. Implement single-use enforcement via Redis Lua CAS (`issued` -> `consumed`) (section 13.6).
5. Configure NGINX auth_request or websockify JWTTokenApi for token validation.
6. Implement viewer UX controls (release button, timer, focus indicator).

**Slack/Teams Bots**
1. Implement Slack bot with @slack/bolt: HITL request, OTP capture, release control, human notes.
2. Implement Teams bot with botbuilder: same flow.
3. Implement OTP relay: write to Redis (section 9.7).
4. Implement tenant identity mapping lookup.

**NATS Export**
1. Configure NATS JetStream with `sync_interval: always`.
2. Publish export metadata to tenant-scoped subjects.
3. Configure per-tenant ACLs (section 13.4).

**MinIO Artifact Store**
1. Implement tenant bucket creation on tenant provisioning.
2. Configure bucket lifecycle rules (day-level expiry).
3. Implement artifact expiration CronJob for sub-day TTL precision.
4. Implement presigned URL generation.
5. Implement single-use presigned URL enforcement via Redis (section 13.6).

**Observability**
1. Install `@opentelemetry/auto-instrumentations-node` in all NestJS services.
2. Add manual spans for state transitions, HITL, extraction.
3. Emit Prometheus metrics for TTFF, HITL latency, uptime, intervention rate.
4. Implement audit log with hash chain (section 13.5).
5. Implement daily anchor computation job.
6. Implement hash chain verification job.

**Helm Deployment**
1. Provide charts for all services with PVC defaults.
2. Include SBOM generation + cosign signing in CI pipeline.
3. Include test-harness as optional chart component.

### 22.3 TDD Guidance
1. Unit test ALL session state machine transitions (11 transitions in 9.1 table). Verify TERMINATED is terminal (no outbound transitions).
2. Unit test ALL baton state machine transitions (6 transitions in 9.2 table).
3. Unit test login DSL validation rules.
4. Unit test health predicate evaluation for all result types.
5. Unit test AES-256-GCM encryption/decryption with nonce management.
6. Integration test artifact export: extraction → encryption → MinIO write → NATS publish.
7. Integration test NATS ACL enforcement by tenant.
8. Integration test audit hash chain integrity (insert 100 events, verify chain).
9. Integration test OTP relay: write to Redis → worker reads → key deleted.
10. Integration test single-use stream token via Redis Lua CAS (`issued` -> `consumed`).
11. Integration test controller state transition CAS (`state_version` optimistic locking).
12. Integration test baton takeover/release CAS (`session_batons.version`).
13. E2E test full HITL flow with mock OTP against test harness.
14. Negative tests for OTP timeout, invalid login, stream URL replay.

### 22.4 Expected UAT Flows
1. Register app, scale sessions to 1, verify session becomes HEALTHY.
2. Force logout (via test harness), verify HITL notification and stream access.
3. Human completes OTP, releases control, session returns to HEALTHY.
4. Verify artifact bundle exported and available in MinIO.
5. Verify audit log includes HITL and export events with valid hash chain.
6. Verify session recycles after max_session_age_hours.
7. Verify network policy plus egress proxy blocks egress to non-allowlisted domains.
8. Verify stream URL cannot be reused (single-use enforcement).

### 22.5 Exit Gates
1. All automated tests passing (unit, integration, E2E).
2. HITL flow passes manual UAT with 5 consecutive successes.
3. SBOM generated, signed, and reviewed.
4. Security checklist signed off (stream token, ACLs, audit retention, encryption, network policies).
5. Audit hash chain verification passes for 7 consecutive days.
6. Post-MVP UAT acceptance review by human/team checkpoint.
