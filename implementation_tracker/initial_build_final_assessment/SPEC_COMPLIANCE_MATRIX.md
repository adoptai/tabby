# Spec Compliance Matrix (MVP Browser Spec)

**Date:** 2026-02-19  
**Authority:** `specification_docs/MVP_BROWSER_SPEC_CODEX.md` (source of truth)

Status legend:
1. `CLOSED` = implemented and runtime-evidenced.
2. `PARTIAL` = implemented but not fully evidenced or missing reliability hardening.
3. `OPEN` = not fully delivered for production-grade compliance.

## 1. Functional Requirement Domains (Section 7)

| Spec domain | Status | Notes |
|---|---|---|
| 7.1 Application registration | CLOSED | CRUD and app/session scale paths operational. |
| 7.2 Session management | PARTIAL | Core lifecycle operational; production HA and long-run stability still pending. |
| 7.3 Auth detection and recovery | PARTIAL | Recovery works in UAT/harness; deterministic OTP-request event publication still open. |
| 7.4 HITL streaming and control | PARTIAL | Stream, takeover/release, OTP and replay controls validated; event trigger reliability gap remains. |
| 7.5 Artifact extraction and export | CLOSED | UAT flow validates artifact export + MinIO object presence. |
| 7.6 Observability and audit | PARTIAL | Audit and hash-chain checks pass; full OTel pipeline/dashboard maturity still open. |
| 7.7 RBAC and tenant isolation | PARTIAL | Core tenant scoping exists; enterprise identity and policy hardening still required. |
| 7.8 Failure modes and recovery | PARTIAL | Multiple failure flows validated; production resiliency under scale/fault injection still open. |
| 7.9 Knowledge bootstrap (V1.5 minimal) | OPEN | Not a closure focus in current PoC cycle. |
| 7.10 Session recycling | CLOSED | UAT recycle flow passed with evidence. |
| 7.11 Credential health | PARTIAL | Credential flow exists; operational rotation/reminder governance not fully evidenced. |
| 7.12 Streaming degradation fallback | PARTIAL | Framework exists; full production validation for sustained degraded mode is limited. |
| 7.13 Tenant provisioning | PARTIAL | Provisioning paths exist; multi-tenant production hardening still pending. |
| 7.14 OTP relay | CLOSED | Redis relay path and human OTP loop validated. |
| 7.15 HITL acknowledgement | PARTIAL | Acknowledge path present; requires repeated production-style reliability validation. |
| 7.16 Browser controls | PARTIAL | Baseline controls exist; policy-depth hardening before production still needed. |
| 7.17 Network policy generation | PARTIAL | UAT deny behavior passes; production control-plane rigor and audits remain. |

## 2. Non-Functional Domains (Section 8)

| NFR domain | Status | Notes |
|---|---|---|
| 8.1 Performance | PARTIAL | No formal sustained benchmark package yet against target SLOs. |
| 8.2 Reliability | PARTIAL | End-to-end works; one deterministic HITL eventing gap still open. |
| 8.3 Scalability | OPEN/PARTIAL | Capacity model defined; 50-100 worker scale not yet load-proven. |
| 8.4 Security | PARTIAL | Strong core controls present; pre-prod hardening and governance still required. |
| 8.5 Degradation | PARTIAL | Some resilience patterns implemented; full degraded-mode operations not comprehensively proven. |

## 3. Testing and Exit Gates (Sections 16 and 22.5)

| Gate | Status | Notes |
|---|---|---|
| Automated tests passing | CLOSED (for current suites) | Unit/integration/UAT scripts pass for current scope. |
| Full 22.4 UAT flows | CLOSED | Evidence package indicates all 8 flows pass. |
| HITL manual consecutive success criterion | PARTIAL | Live pass demonstrated; sustained consecutive run target should be repeated under final trigger model. |
| SBOM generated/signed/reviewed | PARTIAL | Generated and reviewed; signing/attestation governance still to finalize. |
| Security checklist sign-off | OPEN/PARTIAL | Technical review exists; formal sign-off package pending. |
| 7-day audit verification continuity | OPEN | Hash-chain checks pass in runs, but consecutive-day governance gate not yet evidenced. |

## 4. Key Compliance Blockers to Full Production Claim

1. Deterministic authoritative OTP-request event emission and consumption.
2. Formal security sign-off including identity, secrets, transport hardening, and HA posture.
3. Commercial/license closure for active runtime stack.
4. Scale/load proof for 50-100 worker operating envelope.

