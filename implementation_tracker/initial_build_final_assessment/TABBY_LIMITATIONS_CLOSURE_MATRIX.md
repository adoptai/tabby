# TABBY Limitations Closure Matrix

**Date:** 2026-02-19  
**Source:** `implementation_tracker/final_assessment/TABBY_POC_LIMITATIONS.md`  
**Purpose:** Exact item-by-item closure classification and execution tracking for production-oriented hardening.

Status legend:
1. `Fix now` = can be implemented in this codebase now in a production-conducive way.
2. `Partial now` = can be advanced now, but full closure needs infra/platform rollout choices.
3. `External dependency` = requires organizational/legal/platform input beyond immediate code changes.

Execution legend:
1. `Queued`
2. `In progress`
3. `Implemented`
4. `Deferred` (intentionally postponed)

## 1. Closure Summary

1. Total items tracked: **58**
2. `Fix now`: **43**
3. `Partial now`: **15**
4. `External dependency`: **0**

## 2. Exact Matrix

| ID | Limitation | Bucket | Execution | Notes |
|---|---|---|---|---|
| LIM-001 | Authoritative OTP-request event publication path incomplete | Fix now | Implemented | Controller now publishes deterministic `hitl.otp-requested` alongside HITL start from `LOGIN_NEEDED` path |
| LIM-002 | Controller reconcile blind to pod-runtime drift | Fix now | Implemented | Reconcile now checks session->pod drift and self-heals missing runtime pod/session mismatches |
| LIM-003 | `LOGIN_IN_PROGRESS` timeout source fragile (`last_login_at`) | Fix now | Implemented | `last_login_at` now updated when entering `LOGIN_IN_PROGRESS` and at worker login start |
| LIM-004 | No leader election/distributed reconcile lock | Partial now | Queued | Code + deployment coordination needed |
| LIM-005 | Egress allowlist union across sessions | Fix now | Implemented | Egress proxy now enforces session-scoped allowlists via per-session proxy credentials and secret-backed validation |
| LIM-006 | Egress policy programming not fail-closed | Fix now | Implemented | Egress allowlist sync now fail-closed (configurable) and terminates sessions on policy sync failures |
| LIM-007 | Artifact pipeline can continue metadata path after failed upload | Fix now | Implemented | Upload errors now fail extraction before DB/event metadata is persisted |
| LIM-008 | Artifact token single-use not enforced in retrieval path | Fix now | Implemented | Added API download retrieval path that validates/consumes artifact token before streaming object |
| LIM-009 | Security defaults too permissive/fallback-heavy | Fix now | Queued | Remove insecure defaults and require explicit secrets |
| LIM-010 | OTP endpoint accepts any non-empty value | Fix now | Implemented | OTP input now restricted to digits-only 4-10 char format |
| LIM-011 | Soft bridge pending state is memory-only | Partial now | Queued | Add durable pending store and replay-safe recovery |
| LIM-012 | Soft bridge polling/history window can miss commands | Fix now | Implemented | Added paginated history backfill (`cursor` + bounded max pages) for command polling |
| LIM-013 | Stream active state is process-local map | Partial now | Queued | Move to shared store for HA |
| LIM-014 | Worker encryption key zero-fallback | Fix now | Implemented | Extraction now requires explicit valid 64-hex key; zero-fallback removed |
| LIM-015 | Worker DB boundary/least-privilege incomplete | Fix now | In progress | Session scoping query parameterized; credential isolation hardening still pending |
| LIM-016 | `Viewer` can perform takeover/release/OTP mutation | Fix now | Implemented | HITL mutate endpoints now restricted to `Admin`/`Operator` |
| LIM-017 | `POST /agent/run-url` lacks idempotency key semantics | Fix now | Implemented | Added `Idempotency-Key` support with Redis-backed reservation/replay and payload-hash mismatch protection |
| LIM-018 | Duplicate human action dedupe semantics absent | Fix now | Implemented | Added Redis-backed `Idempotency-Key` replay protection on HITL mutate actions (takeover/release/otp/acknowledge) |
| LIM-019 | NATS publish is best-effort/degraded silent mode | Partial now | Queued | Improve reliability path + alerting + policy |
| LIM-020 | Event transport lacks durable workflow guarantees | Partial now | Queued | Require durable consumer + exactly-once-ish handling model |
| LIM-021 | Notes requested by bot not persisted to intervention records | Fix now | Implemented | `acknowledge` now accepts note and stores `human_note` on latest intervention |
| LIM-022 | Baton timeout constants not fully enacted | Fix now | Implemented | Enforced baton timeout transitions for `HUMAN_REQUESTED` and `HUMAN_CONTROL` inactivity windows |
| LIM-023 | Session/pod orphan garbage collection incomplete | Fix now | Implemented | Added orphan worker pod sweeper and session runtime cleanup on missing pod detection |
| LIM-024 | Reconcile loop scalability bottleneck | Partial now | Queued | Requires architecture and scheduling choices |
| LIM-025 | No intervention queue/prioritization strategy | Partial now | Queued | Define queue semantics and arbitration |
| LIM-026 | No autoscaling control loops for worker fleet | Partial now | Queued | Needs cluster policy and cost envelope decisions |
| LIM-027 | No per-session/per-tenant circuit breaker policy | Fix now | Queued | Add retry cutoff + cooldown policies |
| LIM-028 | DSL `evaluate` lacks policy sandbox controls | Fix now | Implemented | `evaluate` action disabled by default; explicit policy/env opt-in required |
| LIM-029 | Browser policy enforcement partial | Fix now | Implemented | Added explicit clipboard shim blocking and file chooser blocking enforcement hooks |
| LIM-030 | Viewer depends on runtime CDN for noVNC module | Fix now | Implemented | API now serves local `/vnc/assets/rfb.js` module from bundled noVNC dependency |
| LIM-031 | Observability in shim mode, not full OTel | Partial now | Queued | code+infra rollout for telemetry stack |
| LIM-032 | Placeholder admin UI/operator workflow | Fix now | Deferred | Not P0 for backend hardening wave |
| LIM-033 | Config drift risk (worker template vs runtime path) | Fix now | Implemented | Removed unused Helm worker-template ConfigMap to eliminate dead/stale manifest drift |
| LIM-034 | App/session archival lifecycle incomplete | Fix now | Queued | Add archival and cleanup jobs |
| LIM-035 | Session cap/tuning operational gaps | Partial now | Queued | Requires policy decisions and tenant governance |
| LIM-036 | Stream URL host/protocol mismatch risk by env | Fix now | Implemented | Stream URLs now derive from validated `PUBLIC_BASE_URL` with explicit fallback host/protocol controls |
| LIM-037 | Late OTP accepted when not awaiting OTP | Fix now | Implemented | OTP submit now requires session state `LOGIN_IN_PROGRESS` and active intervention |
| LIM-038 | OTP for terminated/non-existent runtime can be accepted into Redis | Fix now | Implemented | OTP path now blocks non-eligible session states before Redis write |
| LIM-039 | Worker error taxonomy collapses to `AUTH_FAIL` too broadly | Fix now | Implemented | Worker now classifies errors into `AUTH_FAIL` vs `TRANSIENT_FAIL` via explicit signal mapping |
| LIM-040 | No stale intervention cancellation contract | Fix now | Implemented | Controller now emits `hitl.completed` on SUCCESS/TIMEOUT; soft bridge consumes completion for stale/expired closure handling |
| LIM-041 | API pagination and query bound constraints uneven | Fix now | Implemented | Standardized pagination DTO with hard min/max bounds across list endpoints |
| LIM-042 | `run-url` multi-session return semantics ambiguous | Fix now | Implemented | `run-url` now returns `session_ids` and per-session endpoint/stream descriptors for multi-session runs |
| LIM-043 | Soft bridge command authorization not strict role-bound | Fix now | Implemented | Added explicit Slack operator user allowlist gating (fail-closed unless override enabled) |
| LIM-044 | Stream token in URL query string exposure | Fix now | Implemented | Default stream links use URL fragment token and websocket subprotocol token transport (query retained only for legacy compatibility) |
| LIM-045 | Sensitive viewer response cache headers not explicit | Fix now | Implemented | Added `no-store/no-cache` and hardening headers on viewer HTML responses |
| LIM-046 | Proxy admin API can be unauthenticated if token unset | Fix now | Implemented | Egress proxy now refuses start without admin token unless insecure override is explicitly enabled |
| LIM-047 | Network policy allows broad internal namespace access by ports | Fix now | Implemented | NetworkPolicy egress now uses explicit component pod selectors instead of namespace-wide internal port allow |
| LIM-048 | Worker uses high-privilege MinIO credentials | Partial now | Queued | scoped credentials/STS likely needs infra controls |
| LIM-049 | Internal-only presigned URL host risk | Fix now | Implemented | Artifact URL issuance now returns API download route (optionally external-base) instead of internal MinIO URL |
| LIM-050 | JWT fallback secret path present | Fix now | Implemented | JWT key resolution now fail-closed outside tests; removed insecure dev fallback |
| LIM-051 | Service auth is single shared client credential | Partial now | Queued | multi-client registry and rotation policy |
| LIM-052 | Wildcard tenant scope default in service auth | Fix now | Implemented | Service auth now requires explicit tenant allowlist and blocks wildcard unless explicitly enabled |
| LIM-053 | Redis/NATS transport/auth hardening defaults weak | Partial now | Queued | requires deployment cert/auth policy |
| LIM-054 | Controller RBAC overly broad on secrets/configmaps | Fix now | Implemented | Removed unnecessary controller Role permissions for `secrets` and `configmaps` |
| LIM-055 | SQL `SET app.session_id` interpolation not parameterized | Fix now | Implemented | Session scoping now uses parameterized `set_config('app.session_id', $1, false)` |
| LIM-056 | `x11vnc -nopw` local trust assumptions | Partial now | Queued | local-only but hardening tied to container/network model |
| LIM-057 | No full intervention lifecycle SLO instrumentation | Fix now | Implemented | Added lifecycle counters/histogram for requested/submitted/completed/resumed/failed and request->resolution latency |
| LIM-058 | Release confidence relies on manual evidence aggregation | Partial now | Queued | add policy-driven automated release gates |

## 3. Immediate Fix-now Batch (Started)

Current execution batch in this pass:
1. LIM-003 (`last_login_at` lifecycle)
2. LIM-007 (artifact upload integrity gate)
3. LIM-010 (OTP schema/state hardening)
4. LIM-014 (encryption key fallback removal)
5. LIM-016 (RBAC tightening for HITL mutations)
6. LIM-021 (persist intervention note)
7. LIM-037/LIM-038 (late/invalid OTP state gating)
8. LIM-055 (parameterized session scoping SQL)

## 4. Current Execution Result (This Pass)

Implemented in code in this pass:
1. LIM-003
2. LIM-007
3. LIM-010
4. LIM-014
5. LIM-016
6. LIM-021
7. LIM-037
8. LIM-038
9. LIM-055
10. LIM-045
11. LIM-050
12. LIM-012
13. LIM-041
14. LIM-043
15. LIM-046
16. LIM-052
17. LIM-001
18. LIM-017
19. LIM-040
20. LIM-057
21. LIM-002
22. LIM-006
23. LIM-008
24. LIM-023
25. LIM-036
26. LIM-042
27. LIM-047
28. LIM-049
29. LIM-054
30. LIM-018
31. LIM-022
32. LIM-028
33. LIM-029
34. LIM-039
35. LIM-005
36. LIM-030
37. LIM-033
38. LIM-044

Validation run:
1. `pnpm nx run @browser-hitl/api:test` -> PASS
2. `pnpm nx run @browser-hitl/worker:test` -> PASS
3. `pnpm nx run @browser-hitl/controller:test` -> PASS
4. `pnpm nx run @browser-hitl/api:build` -> PASS
5. `pnpm nx run @browser-hitl/worker:build` -> PASS
6. `pnpm nx run @browser-hitl/controller:build` -> PASS
7. `pnpm nx run @browser-hitl/api:test` (post hardening follow-up) -> PASS
8. `pnpm nx run @browser-hitl/api:build` (post hardening follow-up) -> PASS
9. `pnpm nx run @browser-hitl/slack-bot:build` -> PASS
10. `helm template browser-hitl charts/browser-hitl` -> PASS
11. `pnpm nx run @browser-hitl/controller:test` -> PASS
12. `pnpm nx run @browser-hitl/api:test` -> PASS
13. `pnpm nx run @browser-hitl/slack-bot:build` -> PASS
14. `pnpm nx run @browser-hitl/api:build` -> PASS
15. `pnpm nx run @browser-hitl/controller:build` -> PASS
16. `pnpm nx run @browser-hitl/slack-bot:lint` -> PASS
17. `pnpm nx run @browser-hitl/api:test` -> PASS
18. `pnpm nx run @browser-hitl/controller:test` -> PASS
19. `pnpm nx run @browser-hitl/api:build` -> PASS
20. `pnpm nx run @browser-hitl/controller:build` -> PASS
21. `pnpm nx run @browser-hitl/slack-bot:build` -> PASS
22. `pnpm nx run @browser-hitl/slack-bot:lint` -> PASS
23. `helm template browser-hitl charts/browser-hitl` -> PASS
24. `NX_DAEMON=false pnpm nx run @browser-hitl/api:test` -> PASS
25. `NX_DAEMON=false pnpm nx run @browser-hitl/controller:test` -> PASS
26. `NX_DAEMON=false pnpm nx run @browser-hitl/worker:test` -> PASS
27. `NX_DAEMON=false pnpm nx run @browser-hitl/api:build` -> PASS
28. `NX_DAEMON=false pnpm nx run @browser-hitl/controller:build` -> PASS
29. `NX_DAEMON=false pnpm nx run @browser-hitl/worker:build` -> PASS
30. `NX_DAEMON=false pnpm nx run @browser-hitl/slack-bot:build` -> PASS
31. `NX_DAEMON=false pnpm nx run @browser-hitl/slack-bot:lint` -> PASS
32. `helm template browser-hitl charts/browser-hitl` -> PASS
