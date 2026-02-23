# Phase 2 Full Reassessment and Levelset (Checkpoint 2)

**Date:** 2026-02-19  
**Checkpoint intent:** Post-closure-batch full reassessment and remaining-levelset for full functionality, reliability, and specification compliance.

---

## 1. Scope and Evidence Basis

### Reviewed source-of-truth documents
- `specification_docs/MVP_BROWSER_SPEC_CODEX.md`
- `specification_docs/MVP_TASK_PLAN.md`
- `specification_docs/AGENT_INTEGRATION_CONTRACT.md`
- `implementation_tracker/INITIAL_BUILD_AFTER_ACTION_REPORT.md`
- `implementation_tracker/phase_2/CRITICAL_CHECKPOINT_REVIEW_2026-02-19.md`
- `implementation_tracker/phase_2/PHASE_2_EXECUTION_LOG.md`

### Executable evidence run in this checkpoint
- `make build` (pass)
- `make test` (pass)
- `make lint` (pass)
- `helm template browser-hitl charts/browser-hitl` (pass)
- targeted package validations for `@browser-hitl/api`, `@browser-hitl/controller`, `@browser-hitl/worker` (build/lint/test pass)

---

## 2. Net-New Closures Since Prior Checkpoint

1. **Stream transport path implemented end-to-end in code**
- Viewer bootstrap + noVNC page: `apps/api/src/modules/streaming/streaming.controller.ts:45`
- Upgrade proxy for `/vnc-ws` with single-use token CAS consumption at connect: `apps/api/src/modules/streaming/vnc-ws-proxy.service.ts:59`
- Streaming module wiring for controller + proxy service: `apps/api/src/modules/streaming/streaming.module.ts:10`

2. **Controller now provisions per-session noVNC service objects**
- noVNC service lifecycle methods: `apps/controller/src/pod-manager.service.ts:55`, `apps/controller/src/pod-manager.service.ts:72`
- session create/terminate path now creates/deletes service: `apps/controller/src/reconcile.service.ts:165`, `apps/controller/src/reconcile.service.ts:181`

3. **Network policy transport alignment tightened**
- API -> noVNC ingress allow rule: `apps/controller/src/pod-manager.service.ts:291`
- egress-proxy label selector corrected: `apps/controller/src/pod-manager.service.ts:271`

4. **Ingress now exposes stream routes**
- `/vnc` and `/vnc-ws` routed to API: `charts/browser-hitl/templates/ingress.yaml:42`, `charts/browser-hitl/templates/ingress.yaml:50`

5. **Controller RBAC expanded for dynamic runtime resources**
- `services` + `networkpolicies.update` permissions: `charts/browser-hitl/templates/controller-deployment.yaml:97`, `charts/browser-hitl/templates/controller-deployment.yaml:108`

6. **Runtime config alignment for stream proxy namespace/path**
- `WORKER_NAMESPACE`, `NOVNC_UPSTREAM_PATH`: `charts/browser-hitl/templates/configmap.yaml:24`

7. **Worker credential handling hardened**
- mounted-secret file read and fail-closed behavior: `apps/worker/src/main.ts:157`
- insecure default credential fallback removed: `apps/worker/src/main.ts:173`

8. **Controller provisioning rollback resilience improved**
- best-effort cleanup + FAILED state on partial provisioning failure: `apps/controller/src/reconcile.service.ts:171`

---

## 3. Reassessment vs Critical Spec Requirements

| Area | Spec reference | Status | Evidence | Remaining gap |
|---|---|---|---|---|
| Stream URL generation + single-use enforcement | FR-15, 13.6 | **Implemented in code** | `apps/api/src/modules/hitl/hitl.service.ts`, `apps/api/src/modules/streaming/stream-token.service.ts`, `apps/api/src/modules/streaming/vnc-ws-proxy.service.ts:75` | No in-cluster replay-negative proof yet |
| Stream route/access path | 11.2, 15.3 | **Implemented in code** | `apps/api/src/modules/streaming/streaming.controller.ts:45`, `apps/api/src/modules/streaming/vnc-ws-proxy.service.ts:46`, `charts/browser-hitl/templates/ingress.yaml:42` | Must validate with real worker pod + noVNC socket in K8s |
| WebSocket tenant events | 11.6 | **Implemented in code** | `apps/api/src/modules/events/events.gateway.ts:18` | Needs integration/UAT proof under live NATS |
| OTP relay | FR-38 | **Implemented in code** | `apps/api/src/modules/hitl/hitl.service.ts` | Needs full workflow UAT with worker OTP wait |
| Dynamic pod/network lifecycle | FR-41, 13.8 | **Mostly implemented** | `apps/controller/src/pod-manager.service.ts:36`, `apps/controller/src/pod-manager.service.ts:103` | Egress allowlist dynamic sync path not operational end-to-end |
| Egress proxy presence | FR-41 | **Partially implemented** | `charts/browser-hitl/templates/egress-proxy-deployment.yaml`, `charts/browser-hitl/templates/egress-proxy-configmap.yaml:10` | No controller-consumable runtime allowlist API endpoint in proxy |
| Worker credential secret usage | FR-04 intent | **Improved** | `apps/worker/src/main.ts:157` | Requires deployment/runtime verification of mounted secret path convention |
| Observability (OTel/OTLP) | Section 14, FR-25 | **Not compliant yet** | `apps/api/src/modules/observability/observability.service.ts:39` | Still shim mode; no real OTel pipeline |
| UAT acceptance flows | 22.4 | **Not complete** | smoke only (`scripts/e2e-smoke.sh`) | Full 8-flow UAT not automated or evidenced |
| Integration depth | Section 16/17 | **Not complete** | Current tests pass but mostly mocked | Real infra integration suite still pending |

---

## 4. Remaining Items (Levelset by Priority)

## P0 (Must close for full-functionality/full-compliance claim)

1. **Run and evidence true in-cluster stream E2E (including replay rejection).**
- Why: stream path is now code-complete but unproven operationally.
- Required evidence:
  - first `/vnc-ws` connect succeeds
  - token replay rejected
  - stream works for at least 5 consecutive HITL cycles

2. **Implement dynamic egress allowlist control plane actually consumed by controller.**
- Current mismatch:
  - controller calls `EGRESS_PROXY_ALLOWLIST_URL`: `apps/controller/src/pod-manager.service.ts:413`
  - deployed proxy config is static squid config only: `charts/browser-hitl/templates/egress-proxy-configmap.yaml:10`
- Required outcome: `applications.target_urls` updates enforceable at runtime without manual chart edits.

3. **Complete section 22.4 UAT flow automation/evidence package.**
- Current: smoke script validates basic auth/session only.
- Required: all expected UAT flows, including takeover/release and single-use rejection paths.

## P1 (High-value reliability/compliance closures)

1. **Upgrade Admin UI from baseline console to spec-driven HITL operations UI.**
- Current baseline: `apps/admin-ui/server.js`
- Missing: takeover/release controls, timers, event stream visualization, fallback indicators.

2. **Replace observability shim with real OpenTelemetry pipeline.**
- Current shim markers: `apps/api/src/modules/observability/observability.service.ts:39`.

3. **Fix artifact consumption semantics to first successful access.**
- Current behavior records consumption at URL issuance: `apps/api/src/modules/artifacts/artifacts.service.ts:46`.

4. **Integrate NATS ACL/JWT resolver beyond config-object generation.**
- Current state is logic-only service: `apps/api/src/modules/nats/nats-acl.service.ts:45`.

5. **Complete FR-36 operational wiring for screenshot fallback trigger path.**
- Current: fallback object created/stopped but no active FPS feed into `reportFrameRate`: `apps/worker/src/main.ts:122`, `apps/worker/src/screenshot-fallback.ts:27`.

6. **Harden stream state for multi-replica API operation.**
- Current in-memory stream tracking: `apps/api/src/modules/streaming/vnc-stream.provider.ts:30`.

## P2 (Governance/process hardening)

1. **Finish Workstream A truth alignment across all tracker docs.**
- Convert legacy “complete” claims into evidence-gated statuses with runtime proof references.

---

## 5. Next Closure Batch (Execution-Ready)

1. **Batch A: Stream + UAT proof package**
- Add automated E2E scenario(s) that:
  - request stream URL
  - perform websocket connect
  - validate replay rejection
  - execute takeover/release loop
- Output: logs + pass/fail artifacts under `implementation_tracker/phase_2/evidence/`.

2. **Batch B: Egress allowlist runtime enforcement**
- Add a real allowlist-update API path for egress proxy or replace proxy with component that supports dynamic updates.
- Wire controller `updateEgressAllowlist` to that supported API and validate with deny/allow tests.

3. **Batch C: Admin UI operational closure**
- Implement required HITL operator controls and live tenant events (`/events`) in UI.

4. **Batch D: Observability + integration hardening**
- Replace shim with OTel instrumentation/export.
- Expand integration tests to real Postgres/Redis/NATS/MinIO and worker browser path.

---

## 6. Current Phase 2 Position

**Assessment:** materially improved and now much closer to full runtime wiring, but **still not at full specification compliance** because production-critical proof and a few mandatory control paths remain open.

**Delta quality:** strong closure batch (stream transport, per-session noVNC service, credential hardening, provisioning rollback), with remaining risk concentrated in runtime proof and dynamic security controls.

