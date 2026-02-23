# Phase 3 Full Deep-Dive Assessment (Batch B Closure)

**Date:** 2026-02-19  
**Scope:** Batch B execution to close dynamic egress allowlist runtime enforcement and reassess true specification position.

---

## 1. Inputs and Levelset Baseline

### Specification sources levelset
- `specification_docs/MVP_BROWSER_SPEC_CODEX.md`
  - FR-41, NFR-09, sections 9.3, 13.8, 15.4
- `specification_docs/MVP_TASK_PLAN.md`
  - Task 27 acceptance criteria (NetworkPolicy generation + egress proxy allowlist updates)
- `specification_docs/README_FIRST__TASK_AGENT_IMPLEMENTATION_GUIDANCE.md`
  - Egress allowlist enforcement at egress proxy layer

### Prior tracker references
- `implementation_tracker/phase_1/INITIAL_BUILD_AFTER_ACTION_REPORT.md`
- `implementation_tracker/phase_2/FULL_REASSESSMENT_LEVELSET_2026-02-19_CHECKPOINT_3.md`
- `implementation_tracker/phase_3/PHASE_3_EXECUTION_LOG.md`

### Runtime evidence produced in this phase
- Deterministic Batch B egress harness passes:
  - `implementation_tracker/phase_3/evidence/batch_b_egress_20260219T030253Z/summary.json`
  - `implementation_tracker/phase_3/evidence/batch_b_egress_20260219T030443Z/summary.json`
- Validation command evidence:
  - `pnpm --filter @browser-hitl/controller lint`
  - `pnpm --filter @browser-hitl/controller build`
  - `pnpm --filter @browser-hitl/controller test`
  - `pnpm --filter @browser-hitl/worker lint`
  - `pnpm --filter @browser-hitl/worker build`
  - `pnpm --filter @browser-hitl/worker test`
  - `helm template browser-hitl charts/browser-hitl`

---

## 2. What Was Implemented in Batch B

1. **Runtime egress control-plane API implemented**
- New egress proxy runtime service:
  - `charts/browser-hitl/files/egress-proxy/server.js`
- Supports:
  - HTTP proxy forwarding
  - CONNECT tunneling
  - `PUT /allowlist` for session-specific allowlist updates
  - `DELETE /allowlist/{session_id}` for cleanup
  - `GET /allowlist` + `GET /healthz` observability endpoints

2. **Helm egress-proxy deployment converted to dynamic runtime**
- ConfigMap now ships executable proxy server script:
  - `charts/browser-hitl/templates/egress-proxy-configmap.yaml`
- Deployment now runs Node runtime proxy + admin endpoint:
  - `charts/browser-hitl/templates/egress-proxy-deployment.yaml`
- Service exposes both proxy and admin ports:
  - `charts/browser-hitl/templates/egress-proxy-service.yaml`
- Values updated for admin port/image defaults:
  - `charts/browser-hitl/values.yaml`

3. **Controller allowlist lifecycle wiring completed**
- Session create/sync:
  - `syncEgressAllowlist(sessionId, targetUrls)`
- Session terminate cleanup:
  - `clearEgressAllowlist(sessionId)`
- Delete-networkpolicy path now also clears proxy allowlist
- Reconcile loop now re-syncs active sessions each cycle
- Files:
  - `apps/controller/src/pod-manager.service.ts`
  - `apps/controller/src/reconcile.service.ts`

4. **Runtime config + auth token wiring for control-plane**
- Default allowlist endpoint env now rendered:
  - `EGRESS_PROXY_ALLOWLIST_URL` in `charts/browser-hitl/templates/configmap.yaml`
- Optional admin token secret/env plumbing:
  - `charts/browser-hitl/templates/secrets.yaml`
  - `charts/browser-hitl/templates/controller-deployment.yaml`

5. **Worker proxy traffic routing fix**
- Worker Chromium now applies proxy flag when configured:
  - `apps/worker/src/main.ts`
- Controller-created pods now inject `EGRESS_PROXY_URL` into worker env:
  - `apps/controller/src/pod-manager.service.ts`

6. **Batch B deterministic validation harness added**
- `scripts/e2e_batch_b_egress.py`
- `scripts/e2e-batch-b.sh`
- `make e2e-batch-b` target in `Makefile`

7. **Coverage additions**
- Controller unit tests for allowlist sync/cleanup and worker env injection:
  - `apps/controller/src/pod-manager.service.spec.ts`

---

## 3. Actual Functionality Sanity Check

## 3.1 What is now proven functional (with runtime evidence)

From `batch_b_egress_20260219T030443Z/summary.json`:

1. Default allowlist permits expected host.
2. Non-allowlisted host is blocked for plain HTTP.
3. Non-allowlisted host is blocked for CONNECT.
4. Runtime `PUT /allowlist` updates allowlist successfully.
5. Previously blocked host becomes reachable immediately after update.
6. Runtime `DELETE /allowlist/{session_id}` removes session entry.
7. Previously allowed host is blocked again after deletion.

This confirms control-plane update semantics and enforcement behavior are operational in live process execution.

## 3.2 What is validated at compile/test level

1. Controller builds/lints/tests pass with new logic.
2. Worker builds/lints/tests pass with proxy-flag changes.
3. Helm chart renders successfully with new egress runtime templates.

## 3.3 What is not yet proven in this batch

1. In-cluster end-to-end proof with real controller-created worker pods executing actual browser traffic through deployed egress proxy.
2. Real UAT flow evidence showing target URL updates via API propagate through controller reconcile to active worker behavior in cluster.

---

## 4. Compliance Mapping (Spec vs Current)

| Requirement | Current status | Evidence | Notes |
|---|---|---|---|
| FR-41: Controller updates egress proxy allowlist from `target_urls` | **Implemented** | `apps/controller/src/pod-manager.service.ts`, `apps/controller/src/reconcile.service.ts` | Sync now occurs on create and periodic reconcile; cleanup on termination added |
| FR-41: Domain allowlisting enforced in egress proxy | **Implemented (runtime harness proven)** | `charts/browser-hitl/files/egress-proxy/server.js`, Batch B evidence summaries | HTTP + CONNECT allow/deny behavior proven locally |
| NFR-09: Deny-all egress by default with dynamic allowlist | **Partially proven** | Existing NP generation + Batch B runtime harness | Needs in-cluster proof with real worker/browser traffic |
| Task-plan #27 acceptance: NP + egress-proxy allowlist update + cleanup semantics | **Mostly satisfied** | Controller wiring + egress proxy API + tests | Remaining proof gap is cluster-level runtime validation |
| Section 15.4 `EGRESS_PROXY_URL` runtime usability | **Implemented** | Worker flag + pod env injection | Verified at code/test level; cluster proof pending |

---

## 5. Risk and Gap Analysis (Post-Batch-B)

## Closed in this batch

1. Static-only egress proxy gap (no update API) is closed.
2. Controller-to-proxy allowlist sync path is now functional.
3. Allowlist cleanup on session termination is implemented.
4. Worker proxy flag is wired, removing a critical runtime blind spot.

## Remaining to claim full spec compliance

1. **P0: In-cluster functional proof package**
- Must demonstrate deployed controller + worker + egress-proxy behavior in Kubernetes, not only local harness.

2. **P0: Full UAT matrix completeness**
- Batch B closure does not complete section 22.4 flow matrix.

3. **P1: Observability and broader integration depth**
- OTel and broader infra integration items remain as previously identified.

---

## 6. Conclusion

Batch B is functionally closed at implementation and deterministic runtime-harness level.  
Dynamic egress allowlist runtime enforcement is now real, testable, and evidenced.

The project is materially closer to full compliance, but final full-claim status still depends on:
1. In-cluster proof of this behavior with real session lifecycle traffic.
2. Remaining UAT/compliance closures outside Batch B scope.
