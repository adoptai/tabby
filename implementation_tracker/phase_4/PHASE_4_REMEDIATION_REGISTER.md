# Phase 4 Remediation Register (Full Scope)

**Date:** 2026-02-19  
**Objective:** Achieve full end-to-end PoC workflow with specification compliance (or better), including agent-friendly invocation and Slack HITL flow readiness.

## 1. Scope Baseline

Phase 4 is focused on the remaining critical path from "core runtime works" to "external agent can invoke via simple POST, drive Playwright-backed workflow, and complete HITL interrupt in Slack".

## 2. P0 Remediation List (Critical for Full E2E PoC Claim)

| ID | Item | Status | Evidence / Code Ref | Remaining Action |
|---|---|---|---|---|
| P4-P0-01 | Replace manual bot JWT copy/paste with proper service-to-service auth | **Closed (runtime validated)** | `apps/api/src/modules/auth/auth.controller.ts`, `apps/api/src/modules/auth/auth.service.ts`, `apps/slack-bot/src/api-client.ts`, `apps/teams-bot/src/api-client.ts`; evidence: `implementation_tracker/phase_4/evidence/checkpoint_20260219T164057Z/endpoint_validation_summary.json` | Validate in real Slack workspace provider run (deferred per directive) |
| P4-P0-02 | Wire bot deployments for API auth without manual env patching | **Closed (code-level, deployment wired)** | `charts/browser-hitl/templates/slack-bot-deployment.yaml`, `charts/browser-hitl/templates/teams-bot-deployment.yaml`, `charts/browser-hitl/templates/secrets.yaml`, `charts/browser-hitl/templates/api-deployment.yaml` | Runtime proof when Slack/Teams bot deployments are enabled for provider E2E |
| P4-P0-03 | Fix controller state-machine test regression | **Closed** | `apps/controller/src/state-machine.service.spec.ts` | None |
| P4-P0-04 | Add simple single-call agent endpoint (`POST URL and run`) | **Closed (runtime validated)** | `apps/api/src/modules/agent/agent.controller.ts`, `apps/api/src/modules/agent/agent.service.ts`, `apps/api/src/modules/agent/agent.module.ts`, `apps/api/src/app.module.ts`; evidence: `implementation_tracker/phase_4/evidence/checkpoint_20260219T164057Z/endpoint_validation_summary.json` | None |
| P4-P0-05 | Real Slack workspace HITL E2E proof | **In Progress (human loop validated; auto-trigger pending)** | Real channel validated with human OTP command path and success card; latest PASS evidence: `implementation_tracker/phase_4/evidence/manual_slack_hitl_20260219T193805Z/summary.json` + `implementation_tracker/phase_4/evidence/manual_slack_hitl_20260219T193805Z/slack_timeline.json` | Eliminate manual NATS `hitl.started` stimulation by wiring native OTP-request event emission path (see P4-P1-01) |
| P4-P0-06 | Full in-cluster regression pass after Phase 4 changes (22.4 + wrapper + bot auth path) | **Closed (non-Slack runtime)** | `implementation_tracker/phase_4/evidence/uat_22_4_20260219T163153Z/summary.json` + endpoint proof in `implementation_tracker/phase_4/evidence/checkpoint_20260219T164057Z/` | Slack live-provider E2E still required for full closure |

## 3. P1 Remediation List (High-Value Reliability/Spec Closure)

| ID | Item | Status | Rationale / Notes |
|---|---|---|---|
| P4-P1-01 | Emit explicit `hitl.otp-requested` event on OTP wait detection path | Open (high-impact) | Current live runs still require manual `hitl.started` stimulation for deterministic Slack prompting; publisher path is not yet wired in worker/controller flow |
| P4-P1-02 | Notification channel resolution by app/tenant config (not default-only fallback) | Open | Slack/Teams listeners currently rely on default channel and optional env override |
| P4-P1-03 | Stream URL public base hardening for non-local clients | **Closed (implemented)** | Stream URL generation now uses validated `PUBLIC_BASE_URL`/`EXTERNAL_BASE_URL`, and tokens default to fragment + websocket subprotocol transport |
| P4-P1-04 | noVNC first-connect warm-up stabilization | Closed (test harness resilience) | UAT flow now includes bounded retry against warm-up 5xx and passed in-cluster (`flow8` pass) |
| P4-P1-05 | Expand bot automated tests beyond placeholder echo commands | Open | Slack/Teams packages still use placeholder test scripts |
| P4-P1-06 | Agent wrapper operational controls (cleanup/reuse/TTL policy) | Open | Current wrapper is functional but can create app sprawl without lifecycle policy |
| P4-P1-07 | UAT repeatability under constrained local cluster resources | **Closed** | Added preflight cleanup to scale prior `uat-22-4-*` apps to zero and wait for drain before run start (`scripts/e2e_uat_22_4.py`) |
| P4-P1-08 | Slack intervention completion visibility (`LOGIN_IN_PROGRESS -> HEALTHY/FAILED`) | **Closed (implemented)** | Added `session.state.changed.>` subscription and completion notifications in `apps/slack-bot/src/nats-listener.ts` |
| P4-P1-09 | Soft direct Slack OTP command path for immediate human testability | **Closed (implemented)** | Added `apps/slack-bot/src/soft-hitl-bridge.ts` + runbook `implementation_tracker/phase_4/SLACK_HITL_SOFT_TEST_RUNBOOK.md` |
| P4-P1-10 | Stream viewer blank-screen regression (`rfb.js` CDN import/runtime mismatch) | **Closed (runtime validated)** | Viewer now imports locally served `/vnc/assets/rfb.js` module from API (self-hosted noVNC), removing runtime CDN dependency and prior ESM path mismatch |
| P4-P1-11 | Operator UX polish (Slack request/confirmation cards + harness page styling) | **Closed (runtime validated)** | Block Kit card-style messages + OTP-success guard implemented in `apps/slack-bot/src/soft-hitl-bridge.ts`, and harness UI refreshed in `test-harness/templates/login.html`, `test-harness/templates/otp.html`, `test-harness/templates/dashboard.html`; evidence in `implementation_tracker/phase_4/evidence/slack_ux_refresh_20260219T193312Z/` and `implementation_tracker/phase_4/evidence/slack_ux_guard_20260219T193654Z/` |

## 4. P2 Remediation List (Quality, Governance, Productization)

| ID | Item | Status | Notes |
|---|---|---|---|
| P4-P2-01 | Recursive canonical JSON for audit hash-chain robustness | Open | Current canonicalization is shallow-key sort |
| P4-P2-02 | Full OTel/OTLP pipeline and dashboards/runbooks | Open | Metrics exist; end-to-end telemetry operations closure pending |
| P4-P2-03 | Security scanning reliability and formal vuln triage gate | Open | `pnpm audit` endpoint flakiness observed; define resilient security gate policy |
| P4-P2-04 | Teams live-provider soak and parity validation | Open | Teams flow code exists; real provider validation pending |

## 5. User Directive Mapping

| Directive | State |
|---|---|
| 1. Slack bot token details later | Acknowledged; implementation prepared for credential injection when provided |
| 2. Replace manual bot JWT workflow | **Completed and runtime-validated** |
| 3. Real Slack workspace E2E after other remediations | **Planned and deferred by design** |
| 4. Fix controller state-machine test regression | **Completed and validated** |
| 5. Add single-call POST URL wrapper | **Completed and runtime-validated** |

## 6. Phase 4 Exit Criteria (Strict)

Phase 4 is complete only when all are true:

1. All non-Slack P0 items are closed with runtime evidence (not code-only).
2. Slack workspace HITL flow is demonstrated end-to-end with evidence.
3. Full in-cluster regression (including Section 22.4 and wrapper path) passes.
4. Updated tracker documents and evidence bundles are published in `implementation_tracker/phase_4/evidence`.
