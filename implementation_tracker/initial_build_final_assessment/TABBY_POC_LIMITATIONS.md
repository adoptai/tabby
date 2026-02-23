# TABBY PoC Limitations and Production Hardening Review

**Date:** 2026-02-19  
**Scope:** Current Browser HITL PoC behavior, known limits, failure modes, edge cases, and production-grade hardening requirements.

## 1) Direct Answers to the Current Questions

### 1.1 OTP lifespan and no-response behavior
Current behavior:
1. OTP values are stored in Redis with a 60-second TTL (`otp:{sessionId}` with `SET EX 60 NX`).
2. Worker polls Redis every 1 second and waits up to the DSL step timeout (commonly 120 seconds) for OTP.
3. If no OTP arrives, worker throws OTP timeout and writes `AUTH_FAIL` health.
4. Controller keeps session in `LOGIN_IN_PROGRESS` until timeout logic trips (10-minute timeout), then transitions to `FAILED`.
5. In soft Slack bridge mode, pending session tracking is in-memory and pruned after a max age (default 2 hours).

Limitations:
1. OTP submit API does not require session to be in `LOGIN_IN_PROGRESS`; late OTP can still be accepted.
2. OTP format is weakly validated at API layer (`non-empty string`), not digits-only.
3. No first-class “intervention expired” message contract; operator UX depends on bot logic.
4. Wrong OTP can consume the one pending slot and create operator retry friction.

### 1.2 Can requester pass arbitrary URL?
Current behavior:
1. `POST /agent/run-url` accepts one URL and requires it to be valid `https://`.
2. `target_urls` validation also requires HTTPS URLs.
3. Login DSL steps (`goto`) and login URL are not equivalently constrained to HTTPS, so app-level config can still point browser steps at other URLs.

Limitations:
1. `run-url` is not truly arbitrary URL (HTTP/non-HTTPS are rejected there).
2. Policy consistency is uneven between `target_urls` and login/action URLs.

### 1.3 Can a worker be locked to a specific service/site?
Current behavior:
1. Worker session is tied to an app (`app_id`) that carries `target_urls`.
2. Controller syncs `target_urls` into egress proxy allowlist.
3. Per-session NetworkPolicy is created.

Limitations:
1. Egress proxy allowlist enforcement is host-based and globally merged across sessions.
2. Allowlist sync failures are warn-and-continue, not fail-closed.
3. Policy is domain-level, not path/method-level.
4. Proxy bypass list allows internal host patterns, so “lock” is not strict zero-trust by default.

### 1.4 What does policy look like for a worker (dummy login/dashboard case)?
Current behavior:
1. Policy is app config: `target_urls`, `login_config`, `keepalive_config`, `export_policy`, `notification_config`, `browser_policy`.
2. Dummy/test harness flow uses login + OTP + dashboard checks via DSL and keepalive checks.
3. Browser policy defaults are `downloads=false`, `clipboard=false`, `file_chooser=false`.

Limitations:
1. Browser policy is partially enforced; downloads are actively canceled, clipboard/file chooser controls are not deeply enforced end-to-end.
2. OTP prompt config exists, but OTP wait behavior is inferred from sensitive `wait_for` steps, not strongly driven by a distinct runtime contract.

### 1.5 What happens on duplicate submissions?
Current behavior:
1. `POST /agent/run-url`: no idempotency key; duplicate calls create additional app/run records.
2. `POST /apps/{id}/sessions/scale`: overwrites desired count (idempotent-ish set operation).
3. `POST /sessions/{id}/otp`: second write while one is pending returns conflict.
4. Stream tokens are single-use via Redis CAS and reject replay.

Limitations:
1. No request-level idempotency for agent wrapper endpoint.
2. Duplicate run-url requests can cause app/session sprawl and capacity waste.
3. Artifact token single-use semantics exist in service code, but enforcement in artifact retrieval path is incomplete.

---

## 2) First-Pass Limitation Register

## 2.1 P0 / Critical blockers (production gate)

1. **Authoritative OTP-request event gap**  
   `hitl.otp-requested` publication is not an authoritative native runtime path for all intervention cases; the PoC relied on `hitl.started` and, in prior validation, manual event stimulation in one run.

2. **Controller reconciliation blind to pod reality**  
   Reconcile logic is state-table-driven and does not robustly self-heal when worker pods disappear/crash while session rows remain active.

3. **`LOGIN_IN_PROGRESS` timeout source is fragile**  
   Timeout uses `last_login_at` if present, else `started_at`; `last_login_at` is not updated in live flow, so long-lived sessions can hit incorrect immediate timeout behavior when later requiring HITL.

4. **No leader election / distributed reconcile lock**  
   Reconcile mutex is in-process only; controller scale-out can create race conditions and duplicated orchestration actions.

5. **Egress allowlist not truly per-session enforced**  
   Proxy combines all session allowlists into one union set, enabling cross-session policy bleed.

6. **Egress control is not fail-closed**  
   Allowlist sync or NetworkPolicy creation failures mostly log warnings/errors and continue runtime.

7. **Artifact pipeline can claim success on failed upload**  
   Worker upload errors are swallowed in upload path, but DB/event publication can still proceed, creating references to missing objects.

8. **Artifact token single-use not fully wired to access path**  
   Artifact token CAS exists, but retrieval path returns MinIO presigned URL without enforcing consume-on-access in the primary path.

9. **Security defaults are unsafe for production**  
   Defaults include weak/fallback secrets patterns, single shared service credential model, wildcard tenant allowance, and permissive internal service auth defaults.

10. **OTP endpoint missing state and format hard checks**  
    OTP API accepts any non-empty string and does not enforce “session currently awaiting OTP” precondition.

11. **Slack soft bridge is volatile and poll-based**  
    Pending interventions are in-memory only; restart loses in-flight state. Polling with fixed history window risks missed commands under burst traffic.

12. **Stream provider state is in-memory and leaks lifetime context**  
    Active stream tracking is per-process Map with no HA semantics and no robust lifecycle cleanup (`startStream` has no guaranteed matching `stopStream`).

13. **Worker encryption key fallback is insecure**  
    Artifact encryption falls back to all-zero key material if tenant key env is absent.

14. **Worker DB least-privilege story incomplete**  
    Worker uses shared `DATABASE_URL` and SQL session-variable string interpolation; dedicated hardened worker credential boundary is not strongly enforced in runtime defaults.

15. **RBAC over-permissive on HITL controls**  
    `Viewer` role can call takeover/release/OTP endpoints, expanding blast radius beyond least privilege expectations.

## 2.2 P1 / High-impact limitations

1. No idempotency key support for `POST /agent/run-url`.
2. No dedupe contract for repeated human actions across channels/users.
3. Slack/Teams bots subscribe with broad wildcards; strong tenant-scoped broker authz is not evident end-to-end.
4. NATS publish path is best-effort; controller degrades silently if NATS unavailable.
5. Event transport semantics are not true durable workflow orchestration guarantees.
6. `takeover/release` human notes capture is surfaced in bot UX but not persisted through API path.
7. `BATON_TIMEOUTS` and backoff strategy are defined in shared constants but not fully enacted in runtime logic.
8. Session lifecycle lacks robust stale session/pod garbage-collection guarantees.
9. Reconcile loop is serial and may not scale predictably with large app/session counts.
10. No formal queueing/prioritization for high-concurrency intervention workloads.
11. No dynamic autoscaling control loops for worker fleet based on queue/load/SLOs.
12. No resilient per-session or per-tenant circuit breaker policy for repeated failing targets.
13. Login DSL supports powerful actions (`evaluate`) without policy sandbox controls.
14. Browser policy controls are partially declarative and partially enforced.
15. Viewer HTML depends on external CDN for noVNC module at runtime.

## 2.3 P2 / Medium limitations (operability and maintainability)

1. Observability is shim-based; OpenTelemetry-grade tracing/metrics not fully active.
2. Metrics quality is limited for real SLO debugging (latency histograms, queue depth, HITL MTTR).
3. Admin UI is intentionally placeholder-level and not production-grade operator console.
4. Config drift risk exists (worker template configmap present but runtime pod build path is elsewhere).
5. No strong app/session archival lifecycle and cleanup workflow.
6. Default tenant session caps and tuning require manual ops adjustment for large-scale workloads.
7. CI covers significant scope but does not replace long-running soak/chaos/security load programs.
8. Ingress, service, and token host derivation can still produce environment-specific link mismatches without strict external URL config discipline.

---

## 3) Failure Modes and Edge Cases (First Pass)

1. Human sends OTP after automation already recovered: OTP may still be accepted by API despite no active OTP wait.
2. Human sends OTP for terminated session: key write can succeed, but no consumer exists.
3. Two operators submit OTP concurrently: one wins pending slot; others conflict.
4. Wrong OTP submitted first: worker consumes it; remediation requires another prompt loop.
5. Session enters `FAILED` and no operator ack arrives: dead-end until manual intervention.
6. Worker pod dies during `HEALTHY`: state may remain stale without pod-level reconcile correction.
7. Worker pod dies during `STARTING`: session can remain stuck if health/result transitions do not advance.
8. NATS outage: core state machine may keep running but operators lose prompt/visibility.
9. Redis outage during OTP/stream token CAS: OTP/stream operations fail; user experience degrades hard.
10. MinIO outage during artifact export: metadata/events may report export while object is absent.
11. Slack bot restart during pending intervention: in-memory pending map is lost.
12. Slack channel noise burst > history limit: command polling can miss older actionable messages.
13. Stream token shared in public channel: first consumer can spend token; others fail unpredictably.
14. noVNC upstream not ready: viewer page loads but websocket connect fails.
15. Egress allowlist sync fails: session may run with stale policy and inconsistent access profile.
16. Duplicate `run-url` submissions by retrying client: new app/session objects pile up.
17. Large reconcile duration > interval: loop skips cycles (`reconciling` flag), increasing latency.
18. Controller scale-out without leader-election: conflicting creates/deletes/policy sync actions.
19. Test harness/internal URLs rely on proxy bypass patterns: production policy drift can break flows unexpectedly.
20. Session stream URL host/protocol misconfigured: links unusable outside cluster.

---

## 4) Production Hardening Requirements (Baseline)

## P0 hardening required before production pilot

1. Implement authoritative OTP-request event publication path and verify deterministic end-to-end behavior under restart/failure.
2. Add controller leader election (or distributed lock) and pod-state-aware reconciliation.
3. Make egress enforcement fail-closed; block session start if policy programming fails.
4. Enforce true per-session egress identity at proxy (not global allowlist union).
5. Enforce OTP API preconditions: correct session state, strict OTP schema, replay/late-submit handling.
6. Implement request idempotency keys for `POST /agent/run-url` and other mutation endpoints.
7. Fix artifact pipeline atomicity: only persist/export success after durable object write.
8. Wire artifact token consume validation into actual retrieval path.
9. Remove insecure key/secret fallbacks; enforce mandatory secure secret provisioning.
10. Tighten RBAC for HITL controls (Viewer should not mutate unless explicitly intended and justified).

## P1 hardening (near-term after P0)

1. Durable eventing semantics (broker authz, durable consumers, replay-safe processing).
2. Persist pending intervention state in durable store for bot processes.
3. Full OTel metrics/tracing/log correlation and operator dashboards.
4. Comprehensive retry/backoff semantics and baton timeout enforcement.
5. Strong channel/user authorization checks for bot commands.
6. Session/pod orphan cleanup controllers and runbook automation.
7. Multi-tenant production authN/authZ integration (OIDC/SSO, scoped service identities).

## P2 hardening (scale and maturity)

1. Fleet autoscaling strategy (node pools, HPA/VPA, admission controls, quotas).
2. Soak/chaos/performance test program for 50-100 concurrent browser workers.
3. Operational SLOs and error budgets (stream success, intervention MTTR, recovery rates).
4. Release governance: signed SBOM + provenance + policy gates.
5. Formal production operations model (on-call, paging, incident response, rollback automation).

---

## 5) Second-Pass Deep Dive (Additional Findings)

This section captures additional issues identified after a second review pass across API/controller/worker/bot/chart/runtime paths.

## 5.1 Additional workflow correctness gaps

1. **`last_login_at` is not updated in live worker flow**  
   Timeout logic for `LOGIN_IN_PROGRESS` therefore falls back to `started_at`, which can cause incorrect timeout behavior for long-lived sessions requiring re-auth later.

2. **Intervention type granularity is coarse in controller path**  
   Interventions are created as `MANUAL` rather than strongly typed OTP/CAPTCHA-specific states in core state handling.

3. **Operator notes are not persisted despite UX prompts**  
   Bot UX requests “what happened” notes, but API acknowledge path does not persist `human_note` into intervention records.

4. **Session transitions can misclassify root cause**  
   Worker catch-all error handling writes `AUTH_FAIL` for broad error classes, potentially triggering HITL for non-auth outages.

5. **No explicit stale-intervention cancellation contract**  
   If automation recovers before human action, stale guidance can still be present in channel history and confuse operators.

## 5.2 Additional state-machine and control-plane gaps

1. **Backoff model is defined but not orchestrationally enforced end-to-end**.
2. **Baton timeout constants exist but runtime timeout transitions are not comprehensively implemented**.
3. **`STARTING` can remain stuck if health signals never arrive and retry bookkeeping does not advance**.
4. **Session DB state is source-of-truth, but runtime pod/service reality checks are limited**.
5. **Controller delete/cleanup operations are mostly best-effort; orphaned resources are possible under repeated API errors**.

## 5.3 Additional API contract and ergonomics limitations

1. No mutation idempotency headers/keys for critical write endpoints.
2. Pagination query params are not consistently bounded by strict max constraints.
3. `run-url` returns one session handle even when `desired_sessions > 1`, which is ambiguous for orchestration clients.
4. API contracts for asynchronous workflows are mixed (polling + side effects) without robust workflow IDs/status channels.
5. Endpoint-level consistency for URL policy (HTTPS vs non-HTTPS) is uneven across config fields.

## 5.4 Additional Slack/HITL messaging and identity gaps

1. **Soft bridge command authorization model is channel-membership-based, not policy-verified role mapping per command**.
2. **Any eligible channel participant can submit OTP unless additional checks are layered externally**.
3. **Message polling with fixed `limit` risks missed commands during high message volume windows**.
4. **Soft bridge pending interventions are memory-resident and lost on restart**.
5. **Bot channel resolution in listener path is env-driven and not fully derived from app notification config in runtime**.
6. **Tokenized stream links are posted in channel text; token handling relies on short TTL/single-use but still expands accidental exposure surface**.

## 5.5 Additional streaming and viewer-path limitations

1. Viewer page loads noVNC from external CDN at runtime; availability and supply-chain trust become runtime dependencies.
2. Stream access token is carried in URL query string; this has log/referrer/history exposure considerations.
3. Response cache control headers for sensitive viewer pages are not explicitly hardened.
4. Stream “active” accounting is process-local and not HA-safe.
5. Upstream noVNC connection failures consume single-use token attempts, increasing operator retry churn.

## 5.6 Additional egress and policy-model limitations

1. **Proxy allowlist is host-based only (no path/method granularity)**.
2. **Per-session allowlists are merged globally in proxy decision path (cross-session bleed risk)**.
3. **Admin API auth for proxy allowlist is optional; if unset, control plane is unauthenticated**.
4. **Network policy includes internal namespace allowances by port, which can exceed strict least-privilege expectations**.
5. **Policy programming failures are not strict blockers for runtime progression**.
6. **Proxy bypass patterns enable internal address exceptions; production posture must ensure this list is minimal and reviewed**.

## 5.7 Additional data integrity and crypto/storage limitations

1. **Artifact export can produce metadata/events even when object upload failed**.
2. **Encryption key fallback behavior is unsafe (zero key default path)**.
3. **Worker uses high-privilege MinIO credentials and can create buckets dynamically; stronger scoped credentials are needed**.
4. **Artifact retrieval path does not fully enforce token consume semantics at access boundary**.
5. **Presigned URL host can be internal-only depending on MinIO endpoint config, which breaks external consumers**.

## 5.8 Additional security posture limitations

1. JWT module/strategy contains insecure fallback secret value path for non-prod config mistakes.
2. Service-token model is single shared client credential by default; compromise impact is broad.
3. Default service auth tenant scope allows wildcard (`*`) unless constrained.
4. Redis/NATS internal auth/TLS posture is not production-hardened by default values.
5. Controller RBAC includes broad secret/configmap read permissions; can be narrowed by principle of least privilege.
6. Worker SQL session variable uses direct string interpolation for `SET app.session_id` (internal input, but should still be parameterized/escaped robustly).
7. `x11vnc` is launched with `-nopw` (local-only bind reduces but does not eliminate lateral-risk assumptions inside compromised pod context).

## 5.9 Additional observability and operations limitations

1. Observability module is explicit shim mode; production tracing pipeline not fully established.
2. No complete intervention lifecycle SLO instrumentation (requested->submitted->resumed->verified) out of the box.
3. No durable operator audit-to-runtime correlation dashboard packaged.
4. Alerting strategy for stuck sessions, stale interventions, and missing event publications is not fully codified.
5. Runbook automation for common failures (pod orphaning, event outage, proxy drift) is partial.

## 5.10 Additional scale and performance limitations

1. Reconcile loop is single-threaded/serial per cycle and can degrade with large app/session cardinality.
2. High session counts imply many K8s resources (pods/services/networkpolicies) and API-server pressure; no measured ceiling in current evidence.
3. Stateful dependencies are single-replica in current posture (availability bottlenecks).
4. Tenant default `max_sessions` is 10 and lacks full admin API for dynamic governance in current surface.
5. No admission control/capacity-aware scheduling guardrails to protect cluster from request storms.

## 5.11 Additional test and release-process limitations

1. Many code paths have unit tests, but a material set of tests are mock-heavy versus true failure injection.
2. Long-duration soak tests for intervention churn, stream churn, and broker outages are not yet institutionalized.
3. Security abuse cases (cross-tenant bot misuse, replay attempts under adversarial conditions, proxy control-plane abuse) need explicit continuous test packs.
4. Release confidence still relies on manual evidence aggregation; production should formalize automated release gates with pass/fail criteria tied to SLO/security policies.

---

## 6) Additional Edge-Case Matrix (Second Pass)

1. **Healthy session later needs login after many hours** -> may timeout incorrectly due `started_at` fallback.
2. **Operator sends OTP while no OTP wait active** -> API may accept; value expires unused.
3. **Operator submits malformed OTP text** -> API accepts non-empty string; worker fills literal text.
4. **Two concurrent `run-url` retries from caller** -> duplicate app/session creation.
5. **Controller restarted mid-reconcile** -> partial resource creation/deletion can leave drift.
6. **Slack bridge restart mid-intervention** -> pending map loss, orphaned user instructions.
7. **NATS publish fails silently in degraded mode** -> no operator notification despite state changes.
8. **MinIO transient write error** -> export metadata can still indicate success path.
9. **Stream URL generated with wrong external host** -> operators receive unusable links.
10. **Viewer token already consumed by first opener** -> second operator sees unauthorized/expired behavior.
11. **Mass channel chatter during poll cycle** -> OTP command can be missed by fixed history limit.
12. **Proxy admin token unset in-cluster** -> any in-cluster actor can mutate allowlists.
13. **Allowlist for one session includes sensitive domain** -> other sessions inherit access due global union.
14. **Worker pod fails but session row stays active** -> stale “healthy/starting” perception.
15. **No ack on FAILED session** -> indefinite stop with no auto-recovery.
16. **High-frequency reconcile + many apps** -> reconcile overlap skipping increases transition latency.
17. **External CDN outage** -> viewer page loads but noVNC module import fails.
18. **Service auth secret leak** -> attacker can mint API tokens broadly (subject to env constraints).
19. **Redis unavailable during stream token validation** -> stream fails closed; operational outage.
20. **Fallback secrets accidentally left in deployment** -> predictable auth/encryption weakness.

---

## 7) Final Deep-Dive Verdict

Current PoC is functionally strong for demonstration, but production-grade reliability and security require a formal hardening wave.

If target is a **production-ready HITL browser platform**, the dominant closure themes are:
1. deterministic intervention eventing,
2. strict per-session policy enforcement,
3. pod-state-aware reconciliation and HA control-plane safety,
4. hardened auth/secret/network defaults,
5. durable workflow semantics with idempotency and robust edge-case handling.
