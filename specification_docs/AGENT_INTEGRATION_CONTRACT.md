# Agent Integration Contract (Minimal)

**Document ID:** AGENT_INTEGRATION_CONTRACT
**Version:** v1
**Date:** 2026-02-18
**Scope:** Contract between an automated agent platform and the Browser HITL MVP service.

---

## 1. Purpose

Define the minimum integration contract so an automated agent platform can:
1. Initiate browser-session-backed interaction.
2. Detect and handle HITL-required checkpoints.
3. Resume execution after human completion.

This contract is implementation-facing and intentionally minimal.

---

## 2. Integration Model

The agent platform integrates through:
- REST APIs for provisioning, control, and status.
- NATS subjects for async lifecycle signals.
- Session state polling or subscription for deterministic resume.

The agent platform is an external orchestrator. The Browser HITL service owns browser lifecycle, HITL handoff, and artifact export.

---

## 3. Actors and Responsibilities

- `Agent Platform`
  - Starts or scales sessions.
  - Subscribes to HITL and export events.
  - Pauses and resumes its own workflow logic.
- `Browser HITL Service`
  - Manages session state machine and browser workers.
  - Requests human action when needed.
  - Exports artifacts and state updates.
- `Human Operator`
  - Performs OTP/CAPTCHA/manual actions via chat + stream.

---

## 4. Required REST Endpoints

The agent platform should use:
- `POST /apps/{id}/sessions/scale`
  - Ensure at least one active session for target app.
- `GET /sessions`
  - Fetch session status for current tenant.
- `GET /sessions/{id}`
  - Resolve precise state before next action.
- `GET /artifacts/{id}`
  - Fetch presigned URL for exported artifact bundle.

Optional, if platform is delegated human-control tooling:
- `POST /sessions/{id}/stream`
- `POST /sessions/{id}/takeover`
- `POST /sessions/{id}/release`
- `POST /sessions/{id}/otp`
- `POST /sessions/{id}/acknowledge`

---

## 5. Required Event Subscriptions (NATS)

Subscribe to:
- `session.state.changed.{tenant_id}.{session_id}`
- `hitl.started.{tenant_id}.{session_id}`
- `hitl.otp-requested.{tenant_id}.{session_id}`
- `hitl.completed.{tenant_id}.{session_id}`
- `auth.bundle.exported.{tenant_id}.{app_id}`

Agent behavior by event:
- `hitl.started` -> transition workflow to `WAITING_FOR_HUMAN`.
- `hitl.otp-requested` -> escalate/notify human channel and mark `OTP_PENDING`.
- `hitl.completed` -> wait for `HEALTHY` + export event before resuming.
- `auth.bundle.exported` -> retrieve artifact and continue downstream task.

---

## 6. Session State Contract

Expected `sessions.state` values:
- `STARTING`
- `HEALTHY`
- `UNHEALTHY`
- `LOGIN_NEEDED`
- `LOGIN_IN_PROGRESS`
- `FAILED`
- `TERMINATED`

Agent mapping (recommended):
- `STARTING` -> `PENDING_SESSION`
- `HEALTHY` -> `READY`
- `UNHEALTHY` -> `DEGRADED` (retry-safe)
- `LOGIN_NEEDED` / `LOGIN_IN_PROGRESS` -> `WAITING_FOR_HUMAN`
- `FAILED` -> `BLOCKED_ESCALATE`
- `TERMINATED` -> `STOPPED`

Resume condition (strict):
- Do not resume main automation until:
  1. Session state is `HEALTHY`, and
  2. Latest required artifact export is available (or existing artifact is still valid).

---

## 7. Control and Retry Semantics

Agent-side retry rules:
- For `UNHEALTHY`: retry status check with backoff.
- For `LOGIN_NEEDED`: do not retry automation actions; wait for HITL completion.
- For `FAILED`: escalate; only retry after explicit acknowledgment and state transition back to `STARTING`.

Agent-side timeout defaults (recommended):
- Session readiness timeout: 10 minutes.
- HITL wait timeout: 15 minutes before escalation.
- Post-HITL resume check: poll every 5-10 seconds up to 3 minutes.

---

## 8. Artifact Consumption Contract

Artifact export event payload must include enough metadata to fetch/decrypt bundle (direct or via API proxy).

Minimal expected fields:
- `app_id`
- `session_id`
- `tenant_id`
- `exported_at`
- `expires_at`
- `artifact_bundle_ref`
- `key_version`

Agent consumption steps:
1. Receive `auth.bundle.exported`.
2. Resolve or request presigned URL (`GET /artifacts/{id}` if needed).
3. Download artifact once (single-use semantics).
4. Continue downstream automation with validity checks against `expires_at`.

---

## 9. Idempotency and Correlation

Minimum identifiers to carry through all workflows:
- `tenant_id`
- `app_id`
- `session_id`
- `workflow_run_id` (agent platform generated)
- `event_id` (message UUID if available)

Agent platform should persist event-processing checkpoints to avoid duplicate resume/execution when events are re-delivered.

---

## 10. Security Requirements for Agent Integration

- Use least-privilege API credentials scoped to tenant.
- Treat stream/artifact URLs as sensitive and short-lived.
- Never log OTP values or raw artifact contents.
- Enforce fail-closed behavior if token validation dependencies are unavailable.

---

## 11. Failure Modes the Agent Must Handle

- HITL timeout leading to `FAILED`.
- Acknowledge rejected due to active `hitl_pause_until` (409 + retry_after).
- Artifact URL replay rejection.
- Session churn (new session ID after recycle/terminate).
- Temporary export/storage unavailability with later success.

---

## 12. Reference Workflow (End-to-End)

1. Agent initiates by ensuring session capacity via `POST /apps/{id}/sessions/scale`.
2. Controller creates/maintains worker pod(s); session enters `STARTING`.
3. Worker runs login DSL and health checks.
4. If auth requires human input, service emits `hitl.started` and session enters `LOGIN_NEEDED` / `LOGIN_IN_PROGRESS`.
5. Agent marks workflow `WAITING_FOR_HUMAN` and halts non-idempotent actions.
6. Human receives Slack/Teams notification, opens stream, takes control.
7. Human completes OTP/CAPTCHA/manual step; releases control.
8. Service emits `hitl.completed`; worker continues login flow.
9. Session returns to `HEALTHY` after successful health predicate.
10. Worker extracts/encrypts artifacts and emits `auth.bundle.exported`.
11. Agent consumes artifact (single-use), validates expiry, resumes automation.
12. If HITL fails repeatedly, session may enter `FAILED`; agent escalates and waits for acknowledgement pathway.

---

## 13. Minimal UAT for Agent Integration

- UAT-A1: Agent receives `hitl.started` and pauses correctly.
- UAT-A2: Agent does not resume until `HEALTHY` and export available.
- UAT-A3: Agent handles `FAILED` and acknowledgement gating (`hitl_pause_until`).
- UAT-A4: Agent handles replay rejection for stream/artifact URLs safely.

---

## 14. Out of Scope for This Contract

- Internal implementation details of browser worker.
- Policy engine and long-term knowledge plane behavior.
- CDP migration details (post-first-release checkpoint decision).
