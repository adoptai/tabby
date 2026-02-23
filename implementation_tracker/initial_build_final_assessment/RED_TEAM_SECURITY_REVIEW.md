# Red Team Security Review

**Date:** 2026-02-19

## 1. Security Posture Summary

Current system has credible core controls for PoC use, but several controls required for real production risk acceptance are still pending.

## 2. Attack Surface Map

Primary exposed/control planes:
1. API authentication and control endpoints.
2. Stream issuance and websocket proxy path.
3. Slack HITL command ingestion and action routing.
4. Worker browser runtime (Chromium with containerized compensating controls).
5. State stores: Postgres, Redis, NATS, MinIO.
6. Deployment/supply chain path (images, tags, dependencies, SBOM integrity).

## 3. Mitigations Present Today

1. Stream single-use token semantics with CAS and TTL (replay-resistant design).
2. OTP relay with ephemeral Redis keying and deletion behavior.
3. Session-state and audit-event model with traceable transitions.
4. Tenant-scoped architecture patterns and NATS subject partitioning strategy.
5. Egress-control design with deny/allow model and proxy-centered enforcement intent.
6. Service-to-service auth path for bot integrations replaces manual JWT copy workflow.

## 4. Observed Risks and Likely Abuse Paths

## 4.1 Identity and secret risks
1. Service credentials are environment secret based and need stronger rotation policy.
2. Chat-bot interaction path requires strict channel/user authorization hardening to prevent misuse.

## 4.2 Stream/control-plane risks
1. Any stream URL base misconfiguration can cause exposure or unusable links.
2. Replay prevention is proven, but production deployment still needs rate-limit/WAF and stronger ingress segmentation.

## 4.3 Runtime/browser isolation risks
1. Chromium uses `--no-sandbox` (expected in this model) and relies on compensating container/K8s controls.
2. A compromised worker pod can become a pivot if network and identity boundaries are incomplete.

## 4.4 Event integrity/reliability risks
1. Slack prompt trigger path is not fully deterministic in all live runs (manual event stimulation used once).
2. Eventing ambiguity can create both availability risk and operator confusion.

## 4.5 Availability risks
1. Single-replica stateful services in this environment are SPOFs.
2. Capacity starvation occurred during testing when stale sessions were not drained.

## 4.6 Supply-chain/legal risks
1. Mutable tags and mixed license footprint increase security and legal uncertainty.
2. SBOM is present but signature/attestation policy is not fully operationalized end-to-end.

## 5. Essential Controls Before Real Deployment

## P0 security controls
1. Enforce deterministic OTP-request event publication and consumption path.
2. Implement production-grade authn/authz for bot actions (channel + identity + tenant scoping).
3. Pin all images by digest; block `latest` in production values.
4. Enforce secret rotation and short-lifetime credentials where possible.
5. Require TLS/mTLS across internal service links where supported (NATS, Redis, Postgres, object store path).

## P1 security controls
1. Add centralized policy enforcement for rate limits and abuse detection.
2. Add formal runtime hardening profiles (seccomp/AppArmor, read-only FS, dropped capabilities, non-root verification).
3. Add intrusion/audit correlation dashboards and alerting playbooks.
4. Execute adversarial test suite for replay, cross-tenant access, and token abuse.

## P2 governance controls
1. Signed SBOM + provenance attestation on every release.
2. Third-party dependency/license policy gating in CI.
3. Periodic red-team and tabletop incident exercises.

## 6. Red Team Priority Matrix

| Risk | Severity | Current status | Required action |
|---|---|---|---|
| Non-deterministic HITL event trigger | High | Open | Authoritative OTP-request event wiring + validation run |
| Bot channel/user authorization abuse | High | Partial | Strict identity mapping and command authorization gate |
| Mutable image tags / supply chain drift | High | Open | Digest pinning + signed release attestations |
| Worker isolation bypass impact | High | Partial | Harden pod security + strict egress and identity boundaries |
| Single replica stateful SPOFs | Medium-High | Open | HA architecture for data plane services |
| Observability gaps for incident response | Medium | Open | Full OTel + security event dashboards |

## 7. Bottom-Line Security Verdict

1. PoC security posture: acceptable for controlled internal evaluation.
2. Production security posture: not yet acceptable without the P0 controls above.
3. Most critical gap is now reliability-security coupling in HITL event determinism and production hardening discipline.

