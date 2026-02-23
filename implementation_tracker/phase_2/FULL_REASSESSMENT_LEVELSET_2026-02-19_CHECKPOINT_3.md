# Phase 2 Full Reassessment and Levelset (Checkpoint 3)

**Date:** 2026-02-19  
**Checkpoint intent:** Post-Batch-A closure verification and remaining-item levelset toward full functionality, reliability, and spec compliance.

---

## 1. Evidence Basis

### Source docs re-reviewed
- `specification_docs/MVP_BROWSER_SPEC_CODEX.md`
- `specification_docs/MVP_TASK_PLAN.md`
- `specification_docs/AGENT_INTEGRATION_CONTRACT.md`
- `implementation_tracker/INITIAL_BUILD_AFTER_ACTION_REPORT.md`
- `implementation_tracker/phase_2/PHASE_2_EXECUTION_LOG.md`
- `implementation_tracker/phase_2/FULL_REASSESSMENT_LEVELSET_2026-02-19.md`

### New executable/runtime evidence in this checkpoint
- `pnpm --filter @browser-hitl/api build` (pass)
- `pnpm --filter @browser-hitl/api lint` (pass)
- `API_URL=http://localhost:8080 ./scripts/e2e-smoke.sh` (pass)
- `./scripts/e2e-batch-a.sh` with deterministic local harness:
  - evidence: `implementation_tracker/phase_2/evidence/batch_a_20260219T024724Z/summary.json`
  - result: `PASS`
  - websocket first-connect: `101`
  - websocket replay: `401`
  - takeover/release loops: `5` pass

---

## 2. Net-New Closures Since Checkpoint 2

1. **Batch A execution path is now operational and evidence-generating.**
- deterministic harness path added:
  - synthetic session seeding
  - forced HITL preconditions for repeatable loop checks
  - replay-negative websocket proof capture
- primary artifacts:
  - `scripts/e2e_batch_a.py`
  - `scripts/batch-a-seed-session.js`
  - `scripts/batch-a-force-hitl-state.js`
  - `scripts/mock-novnc-upstream.py`

2. **Critical websocket routing bug fixed.**
- Root issue: Nest `WsAdapter` destroyed unknown upgrade paths, killing `/vnc-ws` requests.
- Fix:
  - `apps/api/src/common/adapters/permissive-ws.adapter.ts`
  - `apps/api/src/main.ts` now uses `PermissiveWsAdapter`
  - `apps/api/src/main.ts` forces `VncWsProxyService` initialization
- Outcome validated by runtime probes (`101` first connect, `401` replay).

3. **Operational test documentation expanded to full-spectrum guidance.**
- `TEST_EXECUTION.md` now covers:
  - agent and human setup
  - deterministic local Batch A mode
  - cluster mode
  - Slack HITL validation path
  - proof-of-life acceptance checklist

---

## 3. Updated Compliance Position

| Area | Prior status | Current status | Evidence | Remaining gap |
|---|---|---|---|---|
| Stream URL + single-use replay rejection | Code-complete, unproven | **Runtime-proven in local harness** | `batch_a_20260219T024724Z/ws_probe_first.json`, `ws_probe_replay.json` | Need in-cluster real worker/noVNC proof for full production claim |
| HITL takeover/release semantics | Code-complete | **Runtime-proven in repeated loops** | `batch_a_20260219T024724Z/takeover_release_loops.json` | Need equivalent proof in real controller-driven session lifecycle |
| Websocket coexistence (`/events` + `/vnc-ws`) | Hidden regression risk | **Closed for local runtime** | adapter fix + passing probes | Needs in-cluster regression test coverage |
| Batch A automation package | In progress | **Closed (deterministic execution path exists)** | `scripts/e2e_batch_a.py`, pass evidence dir | Expand to full 22.4 flow matrix |
| Egress allowlist runtime enforcement | Open P0 | **Still open** | N/A | Controller expects dynamic API but proxy remains static-config |
| Section 22.4 full UAT automation | Open P0 | **Partially improved** | Batch A now covered | Remaining UAT flows still missing |
| Observability OTel/OTLP pipeline | Open P1 | **Unchanged (still open)** | shim logs | Implement real telemetry pipeline |

---

## 4. Remaining Items (Re-Leveled)

## P0 (blocking full compliance claim)

1. **In-cluster real-stream proof package**
- Run Batch A against real controller-created worker pods and noVNC service.
- Require evidence of:
  - first connect success
  - replay rejection
  - 5-loop takeover/release
  - no manual DB forcing in final proof run.

2. **Dynamic egress allowlist control-plane closure**
- Implement real update API in egress proxy (or replace proxy component).
- Wire controller `updateEgressAllowlist` to supported endpoint.
- Validate allow/deny behavior with runtime tests.

3. **Complete Section 22.4 UAT flow coverage**
- Extend automation beyond Batch A:
  - login needed -> HITL started -> takeover -> OTP -> release -> recovery
  - failure/acknowledge/pause-window semantics
  - stream denial paths for invalid/expired tokens
  - audit and notification confirmations.

## P1

1. **Admin UI feature closure against section 12.4 controls.**
2. **Replace observability shim with OTel exporters and trace propagation.**
3. **Artifact consumption semantics fix (record on first successful access, not issuance).**
4. **NATS ACL/JWT resolver runtime integration closure.**
5. **FR-36 screenshot fallback operational wiring (actual FPS reporting trigger path).**

---

## 5. Next Closure Batches (Execution-Ready)

1. **Batch B (P0): Dynamic Egress Enforcement**
- Implement mutable allowlist endpoint + controller integration.
- Add deterministic deny/allow integration tests.

2. **Batch C (P0): In-Cluster Batch A Proof**
- Deploy on kind/k3d.
- Run Batch A against real worker/noVNC sessions.
- Capture closure evidence under `implementation_tracker/phase_2/evidence/`.

3. **Batch D (P0/P1): Full UAT Matrix + Slack HITL**
- Automate remaining UAT flows.
- Produce Slack HITL proof artifacts and log correlation.

4. **Batch E (P1): Observability/Integration Hardening**
- OTel pipeline implementation and infra-backed integration suite expansion.

---

## 6. Position Statement

Phase 2 has materially advanced: Batch A is now executable with strong runtime evidence and the websocket routing defect has been resolved.  
The project is **not yet at full spec compliance** due to remaining P0 items: real in-cluster proof, dynamic egress runtime enforcement, and full 22.4 UAT coverage.
