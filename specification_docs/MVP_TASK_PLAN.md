# MVP Task Plan (Browser HITL)

**Scope:** Task-level build plan for MVP implementation of the browser human-in-the-loop system.
**Date:** 2026-02-18 (v3 — final verification pass)
**Spec Reference:** `MVP_BROWSER_SPEC_CODEX.md` v6

---

## Phase 0: Test Harness + Repo Foundations

1. **Build test harness app (Python/FastAPI).**
   - Acceptance: login page, OTP page (code: 123456), logout endpoint, protected page with `#user-menu`, `/api/me` endpoint, containerized. This is the development fixture for ALL subsequent phases.

2. **Create monorepo structure (pnpm + NX).**
   - Acceptance: directories `apps/{api,controller,worker,slack-bot,teams-bot,admin-ui}`, `packages/shared`, `charts/`, `infra/`, `test-harness/`. pnpm-workspace.yaml and nx.json configured. Build scripts run.

3. **Create shared types and schemas package.**
   - Acceptance: TypeScript types for `login_config`, `keepalive_config`, `export_policy`, `notification_config`, `browser_policy`, all session/baton states, health result types, DSL actions. Published as `@browser-hitl/shared`.

4. **Define login DSL semantics and validation rules.**
   - Acceptance: All 15 DSL actions defined (goto, fill, type, click, select, wait_for, wait_for_url, frame, main_frame, popup, keyboard, evaluate, sleep, screenshot, reload). Validator implemented in shared package. Rejects invalid configs.

5. **Define health predicate evaluation types.**
   - Acceptance: url_check, dom_check, network_check implemented with result types (PASS, TRANSIENT_FAIL, AUTH_FAIL). Policy engine (all/any/quorum) implemented. Tested.

6. **Define BrowserStreamProvider interface.**
   - Acceptance: TypeScript interface in shared package (per spec section 11.5). VncStreamProvider stub created.

7. **Define Chromium hardening flags and runtime policy.**
   - Acceptance: Full flag set documented (section 13.2). Canonical launch command tested in container.

8. **Document cluster defaults and sizing guide.**
   - Acceptance: K8s v1.29+, NGINX ingress, local-path storage, cluster sizing table (section 15.12). Bootstrap checklist includes encryption-at-rest verification.

## Phase 1: Core Data + Auth + Bootstrap

9. **Implement Postgres schema and TypeORM migrations.**
   - Acceptance: All tables from section 10.1 (tenants, users, user_identities, applications, sessions, interventions, artifact_bundles, artifact_consumptions, audit_events, audit_anchors). Migrations run on startup with advisory lock.

10. **Implement admin auth (basic + JWT).**
    - Acceptance: `POST /login` returns JWT; bcrypt cost 12; minimum password 12 chars. JWT includes tenant_id, user_id, role. `JWT_SIGNING_KEY_ID` supports rotation.

11. **Implement RBAC middleware.**
    - Acceptance: NestJS guards enforce Admin/Operator/Viewer roles on all endpoints. Tenant scoping via JWT `tenant_id` claim.

12. **Implement bootstrap flow.**
    - Acceptance: On first startup with empty database, creates tenant (BOOTSTRAP_TENANT_NAME), admin user (ADMIN_BOOTSTRAP_EMAIL/PASSWORD), provisions MinIO bucket and encryption key. Idempotent — skips if tenant exists.

## Phase 2: API Service

13. **Implement tenant APIs.**
    - Acceptance: `POST /tenants` (with MinIO bucket + key provisioning), `GET /tenants` (paginated). RBAC enforced.

14. **Implement user APIs.**
    - Acceptance: `POST /users`, `GET /users` (paginated). RBAC enforced.

15. **Implement app APIs.**
    - Acceptance: `POST /apps`, `GET /apps` (paginated), `GET /apps/{id}`, `PUT /apps/{id}`. Validation per section 10.2. desired_session_count validated against tenant max_sessions.

16. **Implement session APIs.**
    - Acceptance: `POST /apps/{id}/sessions/scale` (persists to applications.desired_session_count), `GET /sessions` (paginated), `GET /sessions/{id}`, `GET /sessions/{id}/interventions` (paginated).

17. **Implement artifact access API.**
    - Acceptance: `GET /artifacts/{id}` returns presigned URL. Records consumption in artifact_consumptions table. Single-use enforcement via Redis.

18. **Implement HITL API endpoints.**
    - Acceptance: `POST /sessions/{id}/stream`, `POST /sessions/{id}/takeover`, `POST /sessions/{id}/release`, `POST /sessions/{id}/otp`, `POST /sessions/{id}/acknowledge`. All per section 11.2.

19. **Implement error response format and rate limiting.**
    - Acceptance: Standard error format (section 11.1). Rate limits: /login 5/min/IP, /stream 3/min/user, others 60/min/user.

20. **Implement WebSocket events endpoint.**
    - Acceptance: `WS /events` with JWT auth. Relays NATS events to connected UI clients filtered by tenant.

## Phase 3: Session Controller

21. **Implement reconcile loop.**
    - Acceptance: Reads desired_session_count from applications table, compares to actual sessions, creates/terminates pods accordingly. Configurable interval (RECONCILE_INTERVAL_SECONDS).

22. **Implement session state machine.**
    - Acceptance: All 11 transitions from section 9.1 table implemented. Includes UNHEALTHY→HEALTHY (transient recovery), STARTING→LOGIN_NEEDED, STARTING→FAILED, FAILED→STARTING (subject to hitl_pause_until gate). TERMINATED is a terminal state with no outbound transitions.

23. **Implement health status reading.**
    - Acceptance: Controller reads health_result_type from sessions table during reconcile. Controller is the single writer for sessions.state. Distinguishes TRANSIENT_FAIL from AUTH_FAIL.

24. **Implement backoff and retry logic.**
    - Acceptance: Retry matrix (section 9.4) enforced. Base delay 30s, multiplier 2x, max 30 min, max 5 login attempts/hour/app.

25. **Implement HITL triggers.**
    - Acceptance: On LOGIN_NEEDED, publishes to NATS `hitl.started.{tenant_id}.{session_id}` and creates intervention record.

26. **Implement failure acknowledgement flow.**
    - Acceptance: FAILED state requires operator acknowledgement. `POST /sessions/{id}/acknowledge` transitions to STARTING only when hitl_pause_until is null/past; otherwise returns 409 with retry_after_seconds.

27. **Implement NetworkPolicy generation.**
    - Acceptance: Creates deny-all NetworkPolicy per browser worker pod allowing DNS/internal/egress-proxy only. Updates egress-proxy allowlist from application target_urls. Deletes policy on pod termination. Controller ServiceAccount has RBAC for networkpolicies.

28. **Implement session recycling checks.**
    - Acceptance: Sessions exceeding max_session_age_hours or memory watermark are gracefully recycled (export → terminate → recreate).

## Phase 4: Browser Worker

29. **Implement worker container build.**
    - Acceptance: Dockerfile with Playwright base image, Xvfb, x11vnc. Startup sequence per section 15.5 (lock cleanup, Xvfb start, wait for X11 socket, x11vnc start, Playwright launch, health server).

30. **Implement login DSL runner.**
    - Acceptance: Executes all 15 DSL actions from JSON config with error handling, retries, timeouts. Frame/popup context switching works. Error screenshots are disabled for sensitive steps.

31. **Implement OTP relay polling.**
    - Acceptance: Worker polls Redis `otp:{session_id}` at 1-second interval during OTP wait. Reads value, fills selector, deletes key. Respects otp_prompt.timeout_ms.

32. **Implement keepalive runner.**
    - Acceptance: Scheduled keepalive actions on interval. Time-sliced with health checks (keepalive first, 2s pause, then health checks).

33. **Implement health predicate evaluation.**
    - Acceptance: Runs url_check (via HTTP client with cookies), dom_check (via page selector), network_check (via HTTP client). Returns PASS/TRANSIENT_FAIL/AUTH_FAIL. Writes results to sessions table.

34. **Implement artifact extraction pipeline.**
    - Acceptance: Extracts cookies (context.cookies), headers (page.on('response') + allHeaders()), CSRF (DOM/meta), localStorage (page.evaluate), sessionStorage (page.evaluate). Filters by export_policy.artifact_types.

35. **Implement artifact encryption.**
    - Acceptance: AES-256-GCM with 12-byte random nonce. Blob format: [nonce][ciphertext][auth tag]. key_version tracked. Encryption in worker process only.

36. **Implement MinIO upload + NATS publish.**
    - Acceptance: Encrypted blob written to MinIO at `{app_id}/{session_id}/{timestamp}.enc`. Export metadata published to `auth.bundle.exported.{tenant_id}.{app_id}`.

37. **Implement worker health HTTP server.**
    - Acceptance: `GET /health` (liveness), `GET /status` (session state details) on port 8091.

38. **Implement session recycling trigger.**
    - Acceptance: Worker monitors own memory usage. Signals controller for recycling when exceeding watermark or max age.

39. **Implement screenshot fallback mode.**
    - Acceptance: When VNC frame rate <1 FPS for >30s, captures screenshots at 2-second interval for the viewer. Resumes VNC when bandwidth recovers.

## Phase 5: Streaming (VNC)

40. **Implement VncStreamProvider.**
    - Acceptance: Implements BrowserStreamProvider interface. startStream/stopStream/getStreamUrl/sendInput/isStreaming/getStreamMetrics.

41. **Build noVNC sidecar container.**
    - Acceptance: Dockerfile with websockify + noVNC. Connects to localhost:5900. Serves on :6080.

42. **Implement stream token generation.**
    - Acceptance: JWT with jti (UUID), session_id, user_id, exp (now + 10 min). Signed with JWT_SIGNING_KEY.

43. **Implement single-use stream token enforcement.**
    - Acceptance: Redis Lua CAS issued->consumed for `stream_token:{jti}` with EX 600. Fail-closed if Redis unavailable. Validated at NGINX auth_request or websockify token plugin.

44. **Implement viewer UX controls.**
    - Acceptance: Release Control button, session timer, idle timeout countdown (5 min), focus indicator. Screenshot fallback display.

## Phase 6: HITL Bots

45. **Implement Slack bot workflow.**
    - Acceptance: @slack/bolt. HITL request with app context and buttons (Open Stream, Submit OTP). OTP capture → Redis relay. Release control flow. "What happened?" prompt → intervention notes.

46. **Implement Teams bot workflow.**
    - Acceptance: botbuilder. Same flow as Slack.

47. **Implement "what happened?" prompt.**
    - Acceptance: Note stored in interventions.human_note. Tagged with app_id, session_id, timestamp, intervention type.

48. **Implement tenant creation script.**
    - Acceptance: CLI script (TypeScript) creates tenant via API, provisions resources.

49. **Implement Slack/Teams identity mapping script.**
    - Acceptance: CLI script maps external user IDs to tenants via user_identities table.

## Phase 7: Artifact Export

50. **Implement MinIO bucket provisioning.**
    - Acceptance: Bucket `artifact-bundles-{tenant_id}` created on tenant creation. Lifecycle rules set (day-level expiry).

51. **Implement artifact expiration CronJob.**
    - Acceptance: Runs every 15 minutes. Deletes MinIO objects where `expires_at` metadata has passed. Handles sub-day TTL precision.

52. **Implement NATS export.**
    - Acceptance: Publishes metadata to `auth.bundle.exported.{tenant_id}.{app_id}`.

53. **Implement NATS ACL model.**
    - Acceptance: Per-tenant subject isolation validated. No cross-tenant subscription possible.

54. **Implement presigned URL single-use enforcement.**
    - Acceptance: Redis tracks presigned URL consumption. Reject replayed URLs.

## Phase 8: Observability + Audit

55. **Implement audit logging.**
    - Acceptance: Append-only events with hash chain. pg_advisory_lock(42) for serialized writes. Canonical JSON payload.

56. **Implement daily anchor computation job.**
    - Acceptance: Scheduled job computes daily root_hash and stores in audit_anchors table.

57. **Implement hash chain verification job.**
    - Acceptance: Verifies chain integrity for a given date. Emits pass/fail report.

58. **Implement metrics and traces.**
    - Acceptance: @opentelemetry/auto-instrumentations-node installed. Manual spans for state transitions, HITL, extraction. Prometheus metrics for TTFF, HITL latency, uptime, intervention rate.

59. **Implement retention policy.**
    - Acceptance: 90-day default, configurable per tenant. Automatic cleanup of old audit events.

## Phase 9: Deployment + Compliance

60. **Implement Helm charts.**
    - Acceptance: Charts deploy all services with PVC defaults, env var configuration.

61. **Implement stateful service defaults.**
    - Acceptance: PVC sizes and storage classes configurable. NATS configured with sync_interval: always.

62. **Implement SBOM pipeline.**
    - Acceptance: Syft generates CycloneDX per build. cosign signs SBOM. Signatures stored with images.

63. **Implement CI/CD pipeline (GitHub Actions).**
    - Acceptance: lint → test → build → SBOM → e2e → publish pipeline. E2E uses k3d/kind.

## Phase 10: Testing + UAT

64. **Unit tests for state machines and validation rules.**
    - Acceptance: All 11 session transitions, 6 baton transitions, DSL validation, health predicate evaluation tested. TERMINATED terminal state verified. Pass in CI.

65. **Integration tests for artifact export, NATS ACL, audit chain.**
    - Acceptance: Full extraction → encryption → MinIO → NATS pipeline tested. ACL isolation verified. Hash chain integrity verified. Pass in CI.

66. **Integration test for OTP relay and single-use tokens.**
    - Acceptance: OTP write -> poll -> fill -> delete flow tested. Stream token Lua CAS tested.

67. **E2E HITL test with mock OTP.**
    - Acceptance: Passes 5 consecutive times against test harness.

68. **Manual UAT checklist execution.**
    - Acceptance: All 8 UAT flows from section 22.4 pass with audit evidence.

69. **Post-MVP UAT acceptance checkpoint (human/team review).**
    - Acceptance: Written sign-off that MVP meets PoC criteria.
