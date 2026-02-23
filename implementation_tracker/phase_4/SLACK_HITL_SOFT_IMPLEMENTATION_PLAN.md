# Slack HITL Soft-First Implementation Plan

**Date:** 2026-02-19  
**Goal:** Demonstrate a real human-in-the-loop Slack workflow end-to-end with the minimum viable changes, then iterate UX later.

## 1. Workflow Sanity Check (Target Behavior)

This is the correct process to demonstrate:

1. Automation runs headless in worker Playwright session.
2. Session reaches a manual-intervention boundary (login recovery/OTP needed).
3. Slack receives actionable HITL message for that session.
4. Human operator provides OTP via Slack.
5. OTP is relayed to API and delivered to worker (Redis OTP key).
6. Worker applies OTP on page; login flow recovers.
7. System posts confirmation to Slack that automation resumed successfully.

This aligns with the architecture already in place. The main gap is completion/status messaging and tightening the operator flow.

## 2. Soft-First Approach (Pragmatic Scope)

Use existing primitives first:

- Keep current Slack modal OTP submit path.
- Keep existing noVNC stream link path for optional operator visibility.
- Do **not** build a new external OTP web app/proxy UX in this pass.
- Add only minimal event and message glue required for observable end-to-end behavior.

## 3. Current State vs Required Delta

Already working:

- Headless worker execution and OTP injection path.
- HITL started event -> Slack interactive message.
- Slack OTP modal -> `/sessions/:id/otp`.
- Worker polls OTP value and fills field.
- Session can return to `HEALTHY`.

Missing for full demo:

- Reliable Slack “success/resume” message after OTP-driven recovery.
- Reliable Slack “failed/timed out” message for same intervention path.
- Channel routing clarity for real test channel (currently mostly default/fallback).
- Deterministic manual UAT script for a real human run.

## 4. Implementation Work Packages

## WP-A: Slack Completion Notifications (P0)

Objective: make outcome visible in Slack without manual log inspection.

Changes:

1. Extend Slack NATS listener subscriptions:
   - consume `session.state.changed.>`
2. Add transition handlers:
   - `LOGIN_IN_PROGRESS -> HEALTHY` => post: OTP accepted, automation resumed
   - `LOGIN_IN_PROGRESS -> FAILED` => post: intervention failed/timed out
3. Correlate messages by `session_id` and include:
   - session id
   - app id/name if available
   - timestamp
   - quick-action link hints (stream request endpoint)
4. For PoC, post to resolved default test channel (`tabby-experiments`) unless tenant override exists.

Acceptance:

- During manual OTP flow, Slack gets explicit “resumed” message within one reconcile cycle after health recovery.

## WP-B: OTP Request Prompt Reliability (P0 soft)

Objective: ensure operator always has a clear OTP submission entry point.

Changes:

1. Keep `hitl.started` as trigger message (already present).
2. In Slack message copy, explicitly mark OTP path:
   - “Use Submit OTP when OTP field is visible.”
3. Keep buttons:
   - `Open Stream`
   - `Submit OTP`
   - `Release Control`
4. Treat `hitl.otp-requested` runtime publish wiring as P1 follow-up (not required for first live demo).

Acceptance:

- On intervention, Slack message appears with Submit OTP path every time.

## WP-C: Operator Access Path (P0 soft)

Objective: operator can view current page when needed.

Changes:

1. Validate stream URL accessibility from human environment.
2. If URL host is not reachable (localhost mapping issue), apply minimal stream public base override.
3. Keep stream as optional; OTP modal remains primary path.

Acceptance:

- Operator can click “Open Stream” and view session page when needed.

## WP-D: Real-Human Manual UAT Runbook (P0)

Objective: repeatable live test with evidence.

Changes:

1. Add a concise runbook script/doc for live Slack HITL:
   - start app/session with test-harness login+OTP
   - trigger logout/auth fail to escalate
   - operator submits OTP from Slack
   - verify state returns `HEALTHY`
   - verify Slack resumed message posted
2. Save evidence bundle under phase 4:
   - API responses
   - session state timeline
   - Slack message timestamps/links

Acceptance:

- Single operator can execute runbook end-to-end and produce evidence without code edits.

## WP-E: Post-Demo Hardening Backlog (P1/P2)

Deferred until after first human demo:

1. Runtime `hitl.otp-requested` publish from actual OTP wait boundary.
2. Full channel resolution from app `notification_config` (not default-only).
3. Optional dedicated OTP web entry page/proxy UX.
4. Threaded Slack conversation model and richer intervention lifecycle cards.

## 5. Execution Order

1. WP-A (completion notifications)
2. WP-B (prompt clarity)
3. WP-C (stream reachability check)
4. WP-D (manual live UAT run + evidence)
5. WP-E backlog capture

## 6. Demo Acceptance Criteria (Go/No-Go)

Go if all pass in one real run:

1. Intervention Slack message appears for session.
2. Human submits OTP via Slack modal.
3. Session transitions back to `HEALTHY`.
4. Slack posts “automation resumed / OTP successful” message.
5. Evidence captured in `implementation_tracker/phase_4/evidence/...`.

No-Go if any fail:

1. No intervention message in Slack.
2. OTP submission not delivered or not consumed.
3. Session stays `LOGIN_IN_PROGRESS`/`FAILED`.
4. No completion status posted to Slack.

## 7. Definition of “Soft-First Complete”

Soft-first is complete when a real human in Slack can unblock one OTP intervention and see explicit success confirmation, without direct database or pod-level intervention.
