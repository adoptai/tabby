# Production Questions (Structured)

This is the ordered production-question set for planning, design reviews, and rollout decisions.

## 1. Infra and Platform

1. What is the minimum Kubernetes footprint for production (CPU, memory, storage, node count), and what is the scalable/expanded footprint by tenant and session volume?
2. Which components must run in-cluster vs managed externally (Postgres, Redis, NATS, MinIO, ingress, secrets backend)?
3. What is the production topology for multi-tenant isolation: shared namespace, namespace-per-tenant, or cluster-per-tier?
4. What is the authoritative ingress strategy for API and viewer traffic, including TLS, WAF, and rate limiting?
5. Should an API manager/router be embedded in this solution (for example Cosmo), or should it remain in the adopt.ai platform layer?
6. What are the required infrastructure environments (dev, staging, pre-prod, prod), and what promotion gates exist between them?
7. What is the environment strategy for config drift control (Helm values, overlays, policy as code)?
8. What is the production strategy for NATS JetStream durability (`sync_interval=always`) vs throughput trade-offs?
9. What is the operational strategy for browser worker image lifecycle (patching cadence, CVE response, rollback process)?
10. What are the network egress controls in production, and who owns allowlist policy changes and approvals?
11. What is the canonical set of production configurables for this stack, and which configs are inherited from other adopt.ai runtime services?

## 2. Workflow and Agent Orchestration

1. How should agentic orchestration be enabled for this product subgroup (ownership boundary between agent platform and Browser HITL)?
2. What are the canonical service workflow profiles (authentication agent, action agent, recovery agent, other)?
3. What does a production worker specification profile look like per workflow (resource class, timeout profile, browser policy, keepalive policy)?
4. Where should Playwright playbooks/login DSL templates live, and what is the governance model for shared vs app-specific playbooks?
5. What is the standard onboarding workflow for a new target app (registration, credential setup, validation, dry-run, go-live)?
6. How are active sessions updated when app login/keepalive config changes (live patch vs recycle vs rolling replacement)?
7. What is the authoritative end-to-end HITL sequence contract from signal emission to human completion to agent resume?
8. What retry and timeout defaults should be standardized for external agent consumers (`/agent/run-url` and session polling/subscription)?
9. What is the explicit decision policy for when to move from VNC to CDP (trigger metrics, approval owner, migration windows)?
10. Do we need workflow policy controls per app type (strict auth-only mode vs broader action automation mode)?
11. What are the default keepalive intervals/session age limits by app class, and how are those changed safely for already-running agents?

## 3. HITL UX and Operator Experience

1. What is the production standard for Slack/Teams message UX, wording, and escalation semantics?
2. How are operator identities mapped to tenants and channels at scale, and who maintains that mapping?
3. What are the expected operator SLAs for OTP response and intervention completion?
4. What should happen when stream link generation fails (fallback UX, retry path, escalation target)?
5. What is the policy for stale HITL prompts and stale session cleanup in operator channels?
6. What is the required viewer experience baseline (latency, quality, reconnect behavior, screenshot fallback behavior)?
7. Should there be a dedicated operator console for active interventions beyond chat messages?
8. What are the human factors requirements for executive/demo mode vs production mode messaging?

## 4. Security, Secrets, and Compliance

1. Where should secrets live in production (K8s secrets only, external vault, hybrid), and what is the rotation workflow?
2. How are application credentials for automated agents created, approved, rotated, and revoked?
3. How are per-tenant encryption keys for artifact bundles provisioned, rotated, and retired?
4. What is the target authentication model for operators/admins in production (OIDC/SAML timeline vs local JWT fallback)?
5. What are the hard requirements for tenant isolation for data, control plane actions, and stream access?
6. What are the audit logging requirements for compliance (immutability, retention, searchable fields, export format)?
7. What data classification applies to OTP artifacts, session artifacts, and stream metadata?
8. What logging and telemetry redaction standards are required to prevent secret/token/OTP leakage?
9. What compliance targets must be met (SOC2, ISO 27001, GDPR/CCPA, customer-specific controls)?
10. What is the formal security position on VNC/noVNC/websockify licensing and risk vs CDP migration timing?

## 5. Data and State Management

1. What data must remain inside the HITL stack vs be persisted in standard adopt.ai platform services?
2. What are the source-of-truth boundaries for session state, app config, intervention history, and agent workflow state?
3. What is the retention policy for sessions, interventions, artifacts, and audit records by environment?
4. What are the backup/restore and disaster recovery requirements for Postgres, MinIO, Redis, and NATS?
5. How should artifact single-use semantics be enforced and audited at scale?
6. What is the production strategy for schema migrations and rollback safety during releases?
7. What is the data lifecycle for tenant offboarding and right-to-be-forgotten requests?

## 6. Reliability, Monitoring, and SRE

1. What are the formal SLOs/SLIs for API availability, session readiness, HITL latency, stream reliability, and recovery time?
2. Which metrics are mandatory, and where are the sinks (Prometheus, OTEL collector, Datadog, Splunk, other)?
3. What production alerts are required (session stuck states, intervention timeout, stream failures, export failures, queue lag)?
4. What healthcheck model is required for each service (readiness/liveness/startup/functional synthetic checks)?
5. What is the incident response model (on-call ownership, severity matrix, escalation paths, runbooks)?
6. What are the failure-mode drills required before go-live (NATS outage, Redis outage, Postgres failover, ingress disruption)?
7. What are the replay/idempotency guarantees for critical events and APIs, and how are they monitored?

## 7. Scale and Performance

1. Where and how do we execute production-representative scale tests, and what workloads are required?
2. What are the primary expected bottlenecks (CPU scheduling, browser memory, Redis throughput, NATS throughput, ingress bandwidth)?
3. What are the mitigation strategies per bottleneck (autoscaling policy, quota policy, backpressure, admission control)?
4. What tenant/session quotas are required, and how are quota breaches handled?
5. What is the capacity planning model for concurrent active sessions and concurrent HITL interventions?
6. What are the performance acceptance criteria for stream TTFF and operator input latency in enterprise networks?

## 8. Integration and Enterprise Fit

1. How does this solution integrate into the broader adopt.ai control plane (auth, tenancy, audit, observability, config delivery)?
2. What external system integrations are required on day one (Slack, Teams, SIEM, ticketing, secrets manager)?
3. Salesforce-specific: what is the approved first production use case, credential model, and validation workflow?
4. What integration contract versioning policy is required for external agent consumers and partner teams?
5. How should tenant provisioning be automated across platform dependencies (NATS ACLs, storage buckets, keys, identity mappings)?

## 9. Delivery, Rollout, and Change Management

1. What is the expected LoE and rollout speed into live adopt.ai infra tiers?
2. What is the phased rollout plan (internal dogfood, pilot tenants, limited GA, full GA)?
3. What are the production go/no-go gates and exit criteria for each rollout phase?
4. What rollback strategy is required for failed releases (control plane rollback, session preservation, artifact continuity)?
5. What change windows and release cadence are acceptable for customers with always-on automation needs?
6. What is the deprecation strategy for API/contract changes impacting agents or operator workflows?

## 10. Documentation, Tooling, and Ownership

1. What agentic documentation/tooling set is required for seamless pickup, maintenance, enhancement, and troubleshooting?
2. Which runbooks are mandatory at production readiness (day-0 deployment, day-1 operations, day-2 incident response)?
3. Who owns each domain operationally (platform, workflow, security, integration, UX)?
4. What evidence standards are required for UAT/prod-readiness sign-off (artifacts, logs, replayable test runs)?
5. What local/dev tooling should be standardized (make targets, env templates, smoke flows) to reduce operational regressions?
