# Infosec Review Response — Tabby Security Controls

## 1. Credential Handling


| Control                | Status        | Details                                                                                                                                                                                                                                       |
| ---------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Encryption at rest** | ✅ Implemented | AES-256-GCM with per-tenant key (`TENANT_ENCRYPTION_KEY`). Worker encrypts artifacts on upload (randomBytes nonce + GCM auth tag), API decrypts on `/credentials/request`. Stored in MinIO.                                                   |
| **Access restriction** | ✅ Implemented | Credentials scoped per tenant + per user (`owner_user_id`). Admin sees all; Operator/Agent sees only their own sessions. Enforced at API layer before any credential decryption occurs.                                                       |
| **Retention policy**   | ✅ Implemented | Configurable via env vars (see note below). Artifacts: 7 days (default). Sessions: 14 days (terminated only). Interventions: 30 days. Audit events: 90 days. Cleanup runs as daily cron jobs (2:00 AM for audit, 3:15 AM for lifecycle data). |
| **Caching**            | ✅ Controlled  | Redis-cached tokens use explicit TTLs: human input 300s, stream tokens 600s, federated Tabby tokens 3500s. All enforced server-side by Redis expiry.                                                                                          |
| **Token lifecycle**    | ✅ Implemented | JWTs expire after 24h. Immediate revocation via token blacklist (Redis, TTL matches remaining token lifetime). VNC cookies 1h. Stream tokens 10 min, single-use.                                                                              |


**Mitigation timeline:** Already in production. No additional work required.

> **Retention env vars:**
>
> - `LIFECYCLE_ARTIFACT_RETENTION_DAYS` (default: 7)
> - `LIFECYCLE_SESSION_RETENTION_DAYS` (default: 14, terminated sessions only)
> - `LIFECYCLE_INTERVENTION_RETENTION_DAYS` (default: 30)
> - `LIFECYCLE_APP_RETENTION_DAYS` (default: 30, apps with zero desired sessions)
> - Audit events: 90 days (hardcoded, per-tenant override planned)

---

## 2. VNC Session Access


| Control                 | Status        | Details                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authentication gate** | ✅ Implemented | **VNC access requires OAuth authentication (redirect to IdP) or email verification (fallback). A** `tabby_vnc` **HttpOnly/Secure/SameSite cookie is set after verification (1h TTL).**                                                                                                                                                                                                            |
| **Owner enforcement**   | ✅ Implemented | **Cookie contains** `owner_user_id`**. If the authenticated user doesn't match the session owner → HTTP 403 (explicit denial, no redirect loop).**                                                                                                                                                                                                                                                |
| **Link expiry**         | ✅ Implemented | Stream tokens: 10 min TTL, single-use. Short links: 10 min TTL (Redis).                                                                                                                                                                                                                                                                                                                           |
| **Session termination** | ✅ Implemented | API endpoint `POST /apps/:id/sessions/scale` terminates sessions immediately (set desired count to 0). Controller destroys worker pods within ~15s. VNC access can also be revoked instantly via `DELETE /vnc/:sessionId/stream-access`. Admin UI exposes session management via Swagger (`/api/docs`); a dedicated terminate button can be added if needed (UI-only, backend fully supports it). |
| **Revocation API**      | ✅ Implemented | `DELETE /vnc/:sessionId/stream-access` writes a Redis revocation marker. All subsequent stream/VNC endpoints check this marker and reject access.                                                                                                                                                                                                                                                 |


**Mitigation timeline:** Already in production. No additional work required.

---

## 3. Agent Actions on Behalf of Users

> **Note:** This area covers the platform-side workflow engine (ProjectA3, nl-wdl, deployment rules), not the Tabby browser session layer. Tabby's scope is limited to browser credential extraction and session management — it does not control workflow governance, prompt security, or output validation. The platform/workflow team should provide the response for this section.

---

## 4. Monitoring and SIEM Integration


| Control                    | Status            | Details                                                                                                                                                                                                                     |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Application monitoring** | ✅ Implemented     | Sentry integration across all services (API, Controller, Worker, Slack Bot). Gated behind `SENTRY_ENABLED` + `SENTRY_DSN` env vars. Configurable sample rate.                                                               |
| **Audit logging**          | ✅ Implemented     | Append-only audit log with SHA-256 hash chains. Covers: auth events, VNC stream generation, browser takeover/release, HITL input submissions, credential access. Integrity verifier service available for chain validation. |
| **Audit retention**        | ✅ Implemented     | 90-day default retention. Daily cron cleanup (2 AM) in batches of 1000. Per-tenant override planned.                                                                                                                        |
| **Sumo Logic integration** | ❌ Not implemented | Tabby outputs structured logs to stdout (JSON in production). These can be collected by any log aggregator (Sumo Logic, Datadog, ELK, CloudWatch). No native Sumo Logic SDK integration.                                    |


**Sumo Logic approach:**
Tabby runs on Kubernetes — the standard approach is a Sumo Logic collector DaemonSet or sidecar that scrapes container stdout/stderr. No application-level code change needed. This is an infrastructure/ops configuration, not an application feature.

**Mitigation timeline:**

- Sumo Logic collector: 3-4 days for K8s setup (ops task, no Tabby code changes).
- Alternative: Any log aggregator that reads container stdout works out of the box.

**Trade-offs if deeper integration is required:**

If requirements go beyond stdout collection (e.g., native Sumo Logic SDK, custom structured fields, or direct API integration):

- **SDK dependency**: Adds a new runtime dependency to all 4 services (API, Controller, Worker, Slack Bot), increasing maintenance surface and coupling to a specific vendor.
- **Ingestion cost**: More verbose or structured logs increase Sumo Logic ingestion volume, which is billed by data volume.
- **Sensitive data redaction**: Structured logs with user-facing fields (user IDs, tenant IDs, session data, email addresses) would require a redaction policy to avoid exposing PII in the SIEM. This needs to be defined and validated before implementation.
- **Performance overhead**: SDK-based logging adds latency per log call (network I/O to Sumo Logic API). For the worker (which runs real-time browser automation), this could impact execution timing.

Our recommendation is to start with the K8s collector approach (zero code changes, proven pattern) and evaluate whether deeper integration is needed based on the monitoring gaps observed in practice.

---

## Summary & Mitigation Timelines


| Severity     | Area                    | Items                                                                  | Status           | Timeline                             |
| ------------ | ----------------------- | ---------------------------------------------------------------------- | ---------------- | ------------------------------------ |
| **CRITICAL** | Credential handling     | Encryption at rest (AES-256-GCM), access restriction, token revocation | ✅ Implemented    | In production                        |
| **CRITICAL** | VNC access              | OAuth/email auth gate, owner enforcement, session termination          | ✅ Implemented    | In production                        |
| **HIGH**     | Audit & integrity       | SHA-256 hash-chained audit logs, retention policies                    | ✅ Implemented    | In production                        |
| **MEDIUM**   | Monitoring              | Sentry integration across all services                                 | ✅ Implemented    | In production                        |
| **MEDIUM**   | SIEM (Sumo Logic)       | Structured JSON logs to stdout, K8s collector needed                   | ⚠️ Infra config  | 3-4 days (ops task, no code changes) |


**Items not feasible or requiring trade-offs:**

- None. All identified controls are either already implemented or achievable within days via infrastructure configuration.

**Exception requests:**

- None required at this time.

**Compensating controls already in place:**

- All tokens have enforced TTLs (JWT 24h, VNC cookie 1h, stream tokens 10 min single-use)
- Immediate revocation via Redis-backed token blacklist
- Per-tenant encryption keys for data isolation
- Append-only hash-chained audit log with integrity verification

