# Production Readiness and Scaling Plan

**Date:** 2026-02-19

## 1. Objective

Define the pragmatic path from current functional PoC to a production-ready platform that can support approximately 50-100 concurrent browser workers while preserving HITL reliability.

## 2. Current Reality

1. Functional core workflows are proven (including UAT 22.4 and live Slack OTP demonstration).
2. Runtime environment is currently PoC-oriented (single-node capacity, single-replica stateful services).
3. One top reliability gap remains: deterministic native OTP-request eventing path.

## 3. Scaling Model (50-100 Workers)

Per-session worker pod profile:
1. CPU request: 1.1 cores (worker + noVNC).
2. Memory request: 2.125 GiB.
3. CPU limit: 2.25 cores.
4. Memory limit: 3.25 GiB.

Approximate cluster requests (excluding Kubernetes/system overhead):
1. 50 workers: ~57.35 cores, ~108.7 GiB.
2. 100 workers: ~112.35 cores, ~214.9 GiB.

Implication:
- Production operation requires a dedicated multi-node worker pool and autoscaling strategy.

## 4. Recommended Production Architecture for Scale

1. Node pool separation:
- worker pool for browser sessions only,
- control/services pool for API/controller/bots,
- optional stateful pool for databases/object store.

2. Horizontal autoscaling:
- HPA for API/controller/bots,
- worker scaling driven by desired sessions + intervention queue depth.

3. Session placement and resilience:
- anti-affinity for workers across nodes,
- PodDisruptionBudget for critical control-plane services,
- graceful drain handling with session handoff/recreate logic.

4. Stateful reliability:
- migrate from single-replica PoC stateful services to HA-managed equivalents,
- backup/restore and disaster-recovery drills.

## 5. Reliability Engineering Model

## 5.1 Target SLOs (initial production proposal)
1. Session create success: >= 99.0%.
2. HITL prompt delivery latency p95: <= 15s.
3. OTP-to-resume latency p95: <= 60s.
4. Stream first-connect success: >= 99.5%.
5. Stream replay rejection correctness: 100%.

## 5.2 Reliability controls
1. Deterministic event contracts (`hitl.otp-requested` authoritative source).
2. Idempotent controller reconciliation with bounded retries and dead-letter handling.
3. Automatic stale-session cleanup and preflight drain controls.
4. Warm-up/readiness gating for noVNC websocket path.
5. Synthetic monitoring:
- periodic end-to-end canary session,
- canary HITL trigger and stream probe,
- alert on state stuck conditions.

## 6. Operational Readiness Requirements

1. Full OTel traces and service-level dashboards (API/controller/worker/bot).
2. Alerting on:
- stuck `LOGIN_IN_PROGRESS`,
- rising `FAILED` transitions,
- token replay attempts,
- Slack delivery failures,
- resource pressure (CPU/memory/pod scheduling failures).
3. Runbooks for:
- session recovery,
- worker recycle storms,
- Slack provider outage fallback,
- stream path outage handling.

## 7. Product and Workflow Evolution Path

## Phase A (Immediate closure)
1. Close deterministic OTP-request eventing gap.
2. Run repeated live Slack E2E without manual event stimulation.
3. Harden public stream URL base and ingress behavior.

## Phase B (Scale hardening)
1. Introduce autoscaling policies and capacity limits per tenant.
2. Separate worker and control-plane node pools.
3. Move stateful dependencies to HA model.

## Phase C (Production controls)
1. Formal release gates (security + legal + SBOM attestation).
2. Incident response and SLO governance.
3. Tenancy/identity hardening and enterprise auth integration.

## 8. Go/No-Go Criteria for Production Pilot

Go only if all are true:
1. 10+ consecutive full E2E HITL runs pass with no manual event injection.
2. Load test at target concurrency tier demonstrates stable SLO adherence.
3. Security P0 controls completed and signed.
4. Commercial/license review completed for active runtime stack.
5. Disaster recovery/backup validation completed.

