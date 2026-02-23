# Task: Full Agentic Implementation Attempt

**Document ID:** TASK_AGENT_IMPLEMENTATION_GUIDANCE
**Date:** 2026-02-18
**Scope:** Execution guidance for implementing the Browser HITL MVP end-to-end from the finalized specification set.

---

## 1. Readiness Statement

The specification set is ready for a full agentic implementation attempt for MVP scope.

Readiness basis:
- No blocking open questions remain for MVP execution.
- State ownership, concurrency, security controls, and HITL lifecycle are explicitly defined.
- Task plan and sprint plan are aligned with final spec semantics.
- External orchestration contract for agent platforms is documented.

MVP boundary reminder:
- Implement login/session/HITL/export platform only.
- Defer CDP migration, deep key-management evolution, and broader workflow engine concerns.

---

## 2. Source of Truth (Read in Order)

1. `MVP_BROWSER_SPEC_CODEX.md`
2. `MVP_TASK_PLAN.md`
3. `MVP_SPRINT_PLAN.md`
4. `AGENT_INTEGRATION_CONTRACT.md`
5. `CODEX_SPEC_BUILD_LOG.md`

Conflict rule:
- If any document conflicts, treat `MVP_BROWSER_SPEC_CODEX.md` as authoritative.
- Record deviations/clarifications in `CODEX_SPEC_BUILD_LOG.md`.

---

## 3. Implementation Task Definition

Build an in-cluster MVP service stack that supports:
1. Automated session initiation and health maintenance.
2. HITL escalation and secure human takeover/release.
3. OTP relay and post-HITL automation resume.
4. Artifact extraction, encryption, MinIO storage, and NATS export.
5. Auditable, tenant-safe operations with replay-resistant token flows.

Success condition:
- An external agent platform can initiate, pause for HITL, and resume using the service contract in `AGENT_INTEGRATION_CONTRACT.md`.

---

## 4. Mandatory Design Constraints

- Controller is sole writer of `sessions.state`.
- State transitions use optimistic locking (`state_version`).
- Baton transitions use CAS (`session_batons.version`).
- Single-use token enforcement uses Redis Lua CAS (`issued` -> `consumed`).
- Egress domain allowlisting is enforced via egress proxy (not native NetworkPolicy).
- Sensitive-step screenshot persistence is forbidden.

---

## 5. Execution Strategy (Agentic)

1. Build in the sequence defined in `MVP_TASK_PLAN.md`.
2. Complete each phase with tests before moving to the next.
3. Enforce hard gates at security/compliance/operational checkpoints.
4. Keep all implementation decisions within MVP scope.
5. Log assumptions and any unresolved ambiguities immediately.

---

## 6. Human Review Gates (Required)

1. Security gate:
- Token enforcement, NATS ACLs, encryption pipeline, RLS policy validation.

2. Operational gate:
- State machine correctness, reconcile behavior, HITL timeout/escalation logic.

3. Platform gate:
- Egress-proxy and NetworkPolicy behavior under real target URL sets.

4. UAT gate:
- End-to-end agent pause/resume workflow validated with human-in-loop steps.

---

## 7. Definition of Done (MVP)

1. All tests in `MVP_BROWSER_SPEC_CODEX.md` section 16 pass.
2. All UAT flows in section 22.4 pass with evidence.
3. Security checklist signed.
4. SBOM generated, signed, and reviewed.
5. Post-MVP acceptance checkpoint completed.

---

## 8. Practical Guidance That Will Matter

- Prioritize correctness of state machines and token semantics before UI polish.
- Treat replay resistance and tenant isolation as first-class implementation tasks, not hardening extras.
- Keep worker behavior deterministic and idempotent where possible.
- Minimize implicit behavior; encode transitions and failures explicitly.
- If in doubt between speed and correctness for security primitives, choose correctness.

---

## 9. Local K8s Execution Target

Expected local/VPS baseline:
- Kubernetes v1.29+
- NGINX ingress
- local-path or standard storage class
- In-cluster Postgres, Redis, NATS, MinIO, egress proxy
- Optional test harness app in-cluster

This is intentionally fully contained for local validation before broader environments.

---

## 10. Output Artifacts Expected From Implementation Attempt

1. Working services and Helm chart deployment.
2. Passing CI test suite (unit/integration/E2E).
3. UAT evidence package.
4. Security validation notes.
5. Updated build log entries capturing any implementation-time clarifications.

