# Phase 2 Critical Checkpoint Review

**Date:** 2026-02-19  
**Scope reviewed:**  
- `specification_docs/*` (authoritative spec, task plan, sprint plan, integration contract, implementation guidance)  
- `implementation_tracker/*` (all phase summaries + after-action report)  
- Codebase evidence pass (`apps/*`, `charts/*`, `infra/*`, CI, tests)

---

## 1. Executive Assessment

### Bottom line
This project is a **strong scaffold, not a fully functional MVP**.

Current state is:
- **Buildability:** strong (`make build`, `make test`, `make lint` pass locally)
- **Functional completeness:** partial (core stubs remain in critical runtime paths)
- **Reliability:** low-to-medium (limited real integration execution; mostly mocked tests)
- **Specification compliance:** materially incomplete in several MUST requirements

### Checkpoint verdict
**NOT READY for “full functionality / full reliability / full specification compliance.”**  
Ready to enter a focused **Phase 2 hardening + integration closure** cycle.

---

## 2. What Is Verified Right Now

## 2.1 Verified by execution in this checkpoint
- `make build` passed across workspace packages.
- `make test` passed (`shared` + `api` + `controller` + `worker`; 181 total tests in output).
- `make lint` passed.

## 2.2 Verified by direct code inspection
- Many planned modules exist and are structured coherently.
- Multiple critical paths are still explicitly stubbed/TODO in production code paths.
- Several tracker claims of “complete” conflict with current implementation details.

---

## 3. Critical Findings (Severity-Ordered)

## P0 - Spec-breaking functional gaps

1. **Controller pod/network lifecycle is stubbed (no real K8s API calls).**
- Evidence: `apps/controller/src/pod-manager.service.ts:32`, `apps/controller/src/pod-manager.service.ts:51`, `apps/controller/src/pod-manager.service.ts:76`, `apps/controller/src/pod-manager.service.ts:96`
- Impact: session orchestration is non-operational in real cluster.

2. **HITL stream and OTP endpoints are stubbed in active API path.**
- Evidence: `apps/api/src/modules/hitl/hitl.service.ts:39`, `apps/api/src/modules/hitl/hitl.service.ts:43`, `apps/api/src/modules/hitl/hitl.service.ts:160`
- Also: `apps/api/src/modules/hitl/hitl.controller.ts:23` routes directly to this stubbed service.
- Impact: FR-15/FR-38 effectively not satisfied in actual endpoint behavior.

3. **No implemented stream transport route despite returned stream URLs.**
- Evidence:
  - URLs returned: `apps/api/src/modules/hitl/hitl.service.ts:54`, `apps/api/src/modules/streaming/vnc-stream.provider.ts:69`
  - No matching controller/gateway routes found in `apps/api/src` for `/stream/*` or `/vnc/*`.
- Impact: generated URLs are not backed by serving path.

4. **WebSocket `/events` contract missing (spec section 11.6).**
- Evidence: no `WebSocketGateway`/events implementation found in `apps/api/src` (code search returned none).
- Impact: required real-time event interface is absent.

5. **Admin UI is a stub package, not a working UI.**
- Evidence: `apps/admin-ui/package.json:6`-`apps/admin-ui/package.json:9` (echo scripts only).
- Impact: major functional and UAT gap for operator workflows.

6. **Egress-proxy requirement not implemented as a deployable component.**
- Evidence:
  - Spec requires egress-proxy component.
  - Chart has only config value: `charts/browser-hitl/values.yaml:336`
  - No egress-proxy templates in `charts/browser-hitl/templates`.
- Impact: FR-41/NFR-09 not enforceable as specified.

## P1 - Reliability/compliance gaps that can cause runtime failure or drift

1. **HITL acknowledgment gate (`hitl_pause_until`) not enforced in API flow.**
- Spec: must return 409 with retry_after when pause active.
- Evidence: `apps/api/src/modules/hitl/hitl.service.ts:175` onward transitions FAILED->STARTING without pause check.

2. **HITL baton semantics do not fully match contract.**
- Spec requires takeover only from `HUMAN_REQUESTED` + `LOGIN_IN_PROGRESS`.
- Evidence: `apps/api/src/modules/hitl/hitl.service.ts:66` onward does not enforce session state or required baton precondition.
- Release path does not include Admin override as specified.

3. **Per-endpoint rate limits are not implemented.**
- Spec requires `/login` 5/min/IP and `/sessions/{id}/stream` 3/min/user.
- Evidence: global default only in `apps/api/src/app.module.ts:22`; no route-level throttle decorators found.

4. **Controller reconcile interval is hardcoded at 15s despite config variable.**
- Evidence: `apps/controller/src/reconcile.service.ts:49` hardcodes 15000; computed env interval at `:40` not used by decorator.

5. **NetworkPolicy selector likely mismatches pod labels.**
- Pod labels set in `apps/controller/src/pod-manager.service.ts:117`-`apps/controller/src/pod-manager.service.ts:120`.
- Policy selector uses `statefulset.kubernetes.io/pod-name` at `apps/controller/src/pod-manager.service.ts:197`.
- Worker pods are created as plain Pods, not StatefulSet members.

6. **Worker writes non-spec health value `RECYCLE_REQUESTED` into enum-limited column.**
- Write site: `apps/worker/src/main.ts:116`
- Allowed enum values: `apps/api/src/entities/session.entity.ts:38`
- Impact: DB write failure risk under recycle path.

7. **Worker RLS/session scoping implementation is fragile.**
- RLS policy created: `apps/api/src/migrations/1708300000001-WorkerRLS.ts:29` onward
- Worker sets `app.session_id` once on one pooled connection: `apps/worker/src/session-db.ts:20`-`apps/worker/src/session-db.ts:24`
- Later queries use pool and may run on different connections.
- Impact: inconsistent RLS behavior, possible access failures or policy bypass assumptions.

8. **Credential secret resolution is not actual K8s Secret integration.**
- Evidence: `apps/worker/src/main.ts:156`-`apps/worker/src/main.ts:163` uses env fallbacks.
- Impact: FR-04 implementation incomplete.

9. **Observability is shim mode, not spec OTel implementation.**
- Evidence: `apps/api/src/modules/observability/observability.service.ts:18`-`apps/api/src/modules/observability/observability.service.ts:20`, `apps/api/src/modules/observability/observability.service.ts:161`
- Impact: FR-25 and section 14 tracing requirements not met.

10. **CI pipeline references missing Dockerfiles and non-existent e2e target.**
- Missing files (referenced in CI matrix): `infra/docker/Dockerfile.controller`, `infra/docker/Dockerfile.slack-bot`, `infra/docker/Dockerfile.teams-bot`, `infra/docker/Dockerfile.admin-ui` (not present).
- CI e2e command uses `pnpm nx run-many --target=test:e2e --all || true` at `.github/workflows/ci.yml:369`; no `test:e2e` target found.
- Impact: CI gives false confidence; e2e stage non-gating.

## P2 - Structural risks / drift signals

1. **Tracker declares full completion while critical runtime TODOs remain.**
- Documents claiming completion conflict with code-level TODOs/stubs.
- This creates governance risk and planning drift.

2. **Entity duplication across API/controller remains drift-prone.**
- Same schema represented in multiple codepaths.

3. **Streaming provider exists but is not integrated into the HITL endpoint path.**
- `VncStreamProvider` is implemented (`apps/api/src/modules/streaming/vnc-stream.provider.ts`) but `HitlService` still returns placeholder token URLs.

4. **Artifact consumption tracking happens at URL issuance, not verified first access.**
- Evidence: `apps/api/src/modules/artifacts/artifacts.service.ts:46`-`apps/api/src/modules/artifacts/artifacts.service.ts:53`
- Spec intends first successful access accounting.

---

## 4. Cross-Document Consistency Assessment

### Observed contradictions
1. Phase tracker files mark broad completion through phases 10.
2. `INITIAL_BUILD_AFTER_ACTION_REPORT.md` already acknowledges major caveats.
3. Current code inspection validates those caveats and surfaces additional hard blockers.

### Assessment
Documentation quality is high, but completion status in tracker docs is **overstated relative to executable reality**.  
Going forward, phase status must be tied to explicit evidence gates, not code presence.

---

## 5. Compliance Posture vs Spec (High-Level)

## Functionality
- Core auth/config/session APIs: partially functional.
- HITL end-to-end: not fully functional (stream/otp path stubs in active endpoints).
- Admin UI + WebSocket real-time: not delivered.
- Egress-proxy enforcement: not delivered.

## Reliability
- Unit-heavy test posture is good, but integration depth is insufficient.
- K8s, NATS ACL/JWT resolver, MinIO access path, Playwright-in-cluster are not proven end-to-end.

## Security/compliance
- Some controls implemented (JWT, encryption logic, RLS migration scaffolding, token CAS services).
- Critical enforcement paths are incomplete or not wired (stream path, artifact single-use enforcement in serving path, OTel/audit operationalization, egress proxy).

---

## 6. Next Phase Action Items (Phase 2 Program)

This is the minimum program to reach your stated target of full functionality, reliability, and spec compliance.

## Workstream A - Truth Alignment and Exit-Gate Discipline (Immediate)
1. Re-baseline tracker status:
- Replace “COMPLETE” with evidence-based status (`implemented`, `wired`, `integration-tested`, `uat-passed`).
2. Add mandatory evidence fields per task:
- `code_ref`, `runtime_proof`, `automated_test_proof`, `security_proof`.
3. Freeze new features until P0 gaps below are closed.

**Exit gate A:** no task may be marked complete without executable proof.

## Workstream B - Core Runtime Closure (P0)
1. Replace controller pod/network stubs with real K8s client calls.
- Implement create/delete Pod + NetworkPolicy + error handling + retries.
2. Wire HITL endpoints to real streaming/OTP/token services.
- `POST /sessions/{id}/stream` must use `StreamTokenService`/provider path.
- `POST /sessions/{id}/otp` must write Redis key with TTL and no logging.
3. Implement actual stream access path.
- Ingress + auth_request/token validation + route to noVNC sidecar.
4. Implement WebSocket `/events` tenant-scoped relay from NATS.
5. Build minimal working Admin UI for required UAT flows.
6. Add and deploy egress-proxy component + allowlist synchronization.

**Exit gate B:** UAT flows 1-4 and 7-8 (section 22.4) pass in local cluster with evidence.

## Workstream C - Contract/State-Machine Semantics Corrections (P1)
1. Enforce `hitl_pause_until` gate and 409 retry semantics in acknowledge API.
2. Enforce baton preconditions (`HUMAN_REQUESTED`, `LOGIN_IN_PROGRESS`) and admin release semantics.
3. Implement per-endpoint throttling policy exactly as spec.
4. Fix reconcile interval config (env-driven, not hardcoded decorator).
5. Fix NetworkPolicy selector to target actual pod labels.
6. Remove invalid `RECYCLE_REQUESTED` write or formalize it into schema/spec.
7. Ensure worker RLS is connection-safe:
- set `app.session_id` per connection/transaction, not once per pool lifecycle.

**Exit gate C:** all section 9 + 11 contract behaviors backed by integration tests.

## Workstream D - Infrastructure/CI Reality Closure
1. Add missing Dockerfiles referenced in CI or adjust CI matrix.
2. Remove `|| true` from e2e stage; make failures blocking.
3. Define actual `test:e2e` Nx targets and implement tests.
4. Add `helm template` and `helm install` smoke checks in CI.

**Exit gate D:** CI fails on any broken image/e2e step; green CI means deployable.

## Workstream E - Reliability and Security Validation
1. Promote “integration” tests from mocked to real dependencies:
- Postgres, Redis, NATS, MinIO, Playwright worker against `test-harness`.
2. Add red-team test automation for:
- stream replay rejection
- artifact replay rejection
- cross-tenant NATS denial
- non-allowlisted egress blocked
3. Replace observability shim with real OTel auto/manual spans + OTLP export.
4. Validate audit chain for 7-day continuous run as per exit gate.

**Exit gate E:** spec section 16/17 coverage achieved with artifacts.

---

## 7. Suggested Phase 2 Execution Order

1. **Week 1:** Workstream A + B (highest risk runtime blockers)
2. **Week 2:** Workstream C (semantic correctness + security gates)
3. **Week 3:** Workstream D + E (CI truthfulness + real integration confidence)
4. **Week 4:** Full UAT + security sign-off + compliance package refresh

This sequence minimizes wasted effort by restoring runtime truth first.

---

## 8. Definition of Done for Phase 2 (Strict)

Phase 2 is complete only when all are true:
1. No P0 findings remain.
2. Section 11.6 WebSocket events implemented and tenant-scoped.
3. HITL stream/OTP/acknowledge flows fully wired and integration-tested.
4. Real K8s reconcile path creates/deletes pods and policies in cluster.
5. Egress proxy operational with allowlist enforcement evidence.
6. CI pipeline fully executable (no missing Dockerfiles, no non-gating e2e bypass).
7. UAT 22.4 all 8 flows pass with evidence package.
8. Security checklist and audit-chain verification gates pass.

---

## 9. Final Checkpoint Position

The project is **not failing**; it has a solid architectural base and meaningful testable logic.  
But it is currently in a **dangerous middle state**: high implementation volume with unresolved critical wiring and enforcement gaps.

The correct move is a hard Phase 2 closure sprint focused on:
- wiring real runtime behavior,
- enforcing spec semantics,
- converting mocked confidence into integration truth,
- and making tracker status evidence-driven.

Only after that can this system credibly claim full functionality, reliability, and spec compliance.
