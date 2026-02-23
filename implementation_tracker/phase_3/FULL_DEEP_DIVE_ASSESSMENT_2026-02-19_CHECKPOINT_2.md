# Phase 3 Full Deep-Dive Assessment (Checkpoint 2)

**Date:** 2026-02-19  
**Scope:** Post-Batch-C reassessment after real in-cluster closure execution.

---

## 1. Inputs and Levelset Baseline

### Specification levelset
- `specification_docs/MVP_BROWSER_SPEC_CODEX.md`
  - FR-41, NFR-09, sections 9.3, 13.8, 15.4, 22.4
- `specification_docs/MVP_TASK_PLAN.md`
  - Task 27 acceptance (NetworkPolicy + proxy allowlist sync/update/cleanup semantics)
- `specification_docs/README_FIRST__TASK_AGENT_IMPLEMENTATION_GUIDANCE.md`

### Tracker continuity
- `implementation_tracker/phase_2/FULL_REASSESSMENT_LEVELSET_2026-02-19_CHECKPOINT_3.md`
- `implementation_tracker/phase_3/PHASE_3_EXECUTION_LOG.md`
- `implementation_tracker/phase_3/FULL_DEEP_DIVE_ASSESSMENT_2026-02-19.md`

---

## 2. What Was Closed in This Checkpoint

1. **Real in-cluster Batch A proof completed**
- Evidence:
  - `implementation_tracker/phase_3/evidence/batch_a_20260219T045954Z/summary.json`
  - `implementation_tracker/phase_3/evidence/batch_a_20260219T045954Z/ws_probe_first.json`
  - `implementation_tracker/phase_3/evidence/batch_a_20260219T045954Z/ws_probe_replay.json`
- Verified:
  - stream URL issuance
  - viewer endpoint path
  - websocket first-connect `101`
  - websocket replay rejection `401`
  - 5-loop takeover/release execution path

2. **Real in-cluster controller->egress allowlist lifecycle proof completed**
- New Batch C validator:
  - `scripts/e2e_batch_c_incluster.py`
  - `scripts/e2e-batch-c.sh`
- Evidence:
  - `implementation_tracker/phase_3/evidence/batch_c_incluster_20260219T050401Z/summary.json`
- Verified:
  - initial allowlist sync for created session (`example.com`)
  - app target_urls update propagated to allowlist (`httpbin.org`)
  - allowlist entry removed after scale-down/session cleanup

3. **Runtime blockers that previously invalidated in-cluster proof were resolved**
- API probe mismatch fixed (`/metrics` probe path):
  - `charts/browser-hitl/templates/api-deployment.yaml`
  - `charts/browser-hitl/values.yaml`
- Controller dynamic worker image wiring fixed:
  - `charts/browser-hitl/templates/configmap.yaml`
- Worker pod runtime hardening:
  - secret mount from `credential_ref`
  - noVNC numeric non-root UID
  - worker filesystem mode adjusted for Chromium stability
  - file: `apps/controller/src/pod-manager.service.ts`
- Worker startup error handling hardened:
  - early launch/credential errors now write `AUTH_FAIL` in worker catch path
  - file: `apps/worker/src/main.ts`
- Worker/runtime version alignment:
  - Playwright pinned for deterministic compatibility
  - `apps/worker/package.json`
  - `infra/docker/Dockerfile.worker`
- Batch A validator correctness hardened:
  - first websocket must be `101`
  - session readiness state gating
  - `scripts/e2e_batch_a.py`

4. **Direct browser liveness probe completed against running worker pod**
- In-pod Playwright runtime executed in live cluster worker:
  - opened `https://example.com`
  - captured screenshot
  - returned page metadata (`title=Example Domain`, URL, bytes)
  - confirmed probe must use configured proxy path under deny-by-default worker egress controls
- Evidence:
  - `implementation_tracker/phase_3/evidence/browser_runtime_proof_20260219T052126Z/runtime_probe_output.json`
  - `implementation_tracker/phase_3/evidence/browser_runtime_proof_20260219T052126Z/proof-example.png`
  - `implementation_tracker/phase_3/evidence/browser_runtime_proof_20260219T053027Z/runtime_probe_output.json`
  - `implementation_tracker/phase_3/evidence/browser_runtime_proof_20260219T053027Z/proof-example.png`

---

## 3. Current Functional Sanity Position

## 3.1 Proven functional now

1. In-cluster stream path issues stream URLs and supports real websocket upgrade (`101`).
2. Single-use stream tokens reject replay (`401`) in-cluster.
3. Controller-managed egress allowlist sync/update/remove lifecycle is operational in-cluster.
4. Core cluster services are stable after rollout (`api`, `controller`, `egress-proxy`, `postgres`, `redis`, `nats`, `minio` ready).
5. Worker browser runtime can actively load and render target pages (direct in-pod Playwright liveness probe).

## 3.2 Proven but with forced preconditions

1. Takeover/release loop passes in-cluster (`HITL_LOOP_COUNT=5`) with `FORCE_HITL_PRECONDITIONS=true` DB helper path.
2. This is valid closure evidence for endpoint behavior, but not yet a pure "no-forcing" operator-flow proof.

---

## 4. Compliance Mapping (Updated)

| Requirement | Status | Evidence | Notes |
|---|---|---|---|
| FR-41: controller updates proxy allowlist from target_urls | **Implemented + in-cluster proven** | `batch_c_incluster_20260219T050401Z/summary.json` | create/update/delete lifecycle confirmed |
| FR-41: allowlist enforced at egress proxy | **Implemented + runtime-proven** | Batch B deterministic runtime + Batch C control-plane proof | in-cluster worker traffic deny/allow packet-level proof still pending |
| NFR-09: deny-by-default + dynamic allowlist | **Partially proven** | Batch B PASS + Batch C PASS | final confidence boost requires in-cluster data-plane deny/allow capture from worker traffic |
| Stream token replay safety | **In-cluster proven** | `batch_a_20260219T045954Z/ws_probe_first.json`, `ws_probe_replay.json` | `101` then `401` confirmed |
| Task-plan #27 acceptance | **Substantially satisfied** | Batch B + Batch C evidence | one remaining angle is stronger in-cluster data-plane egress traffic proof |

---

## 5. Remaining Gaps (Post-Checkpoint-2)

## P0

1. **No-force takeover proof run**
- Produce a full Batch A pass without `FORCE_HITL_PRECONDITIONS=true` DB mutation helper.
- Latest explicit check result: still open (`FAIL`):
  - `implementation_tracker/phase_3/evidence/batch_a_20260219T052209Z/summary.json`

2. **In-cluster egress data-plane traffic proof**
- Demonstrate real worker-browser traffic deny/allow behavior through deployed proxy for allowlist changes.

3. **Section 22.4 matrix completion**
- Expand automation/evidence to full UAT flows (acknowledge/pause windows, OTP flow, failure paths, notifications).

## P1

1. OTel/OTLP observability pipeline closure (currently shim mode).
2. Admin UI feature completion vs section 12.4 controls.
3. Broader integration hardening (NATS ACL/JWT resolver runtime path, artifact semantics refinement).

---

## 6. Position Statement

This checkpoint materially upgrades confidence from code-level/local harness to **real in-cluster execution evidence**.  
Batch A in-cluster stream/replay behavior and Batch C in-cluster egress control-plane lifecycle are now passing with auditable artifacts.

The project is significantly closer to full compliance, but final full-claim status still requires:
1. no-force takeover evidence,
2. stronger in-cluster egress data-plane allow/deny proof,
3. full section 22.4 UAT matrix closure.
