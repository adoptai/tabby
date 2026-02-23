# Phase 4 Execution Log

## Governance

1. This log tracks only verified actions performed in Phase 4 scope.
2. P0 closures require runtime proof artifacts before final closure claim.
3. User directives for Slack testing order are enforced.

## 2026-02-19 - Entry 01 (Initialization + Core Closures)

- Completed:
  - Established Phase 4 tracking and remediation register.
  - Implemented service-to-service auth issuance endpoint:
    - `POST /auth/service-token`
    - tenant-scoped, role-scoped service JWT issuance.
  - Implemented bot-side token refresh/auth flow (Slack + Teams) using service credentials.
  - Removed dependence on manual JWT injection workflow from bot runtime path.
  - Added one-call agent ergonomics endpoint:
    - `POST /agent/run-url`
    - wraps app creation, scale, wait-for-state, and returns actionable HITL endpoints.
  - Fixed controller state-machine regression in tests.
  - Updated Helm chart wiring for service auth env/secret injection and bot `API_BASE_URL` defaults.
  - Updated `TEST_EXECUTION.md` to document new service-auth workflow and wrapper endpoint testing.

- Validation executed:
  - `pnpm --filter @browser-hitl/api build` -> PASS
  - `pnpm --filter @browser-hitl/api test` -> PASS
  - `pnpm --filter @browser-hitl/controller test` -> PASS
  - `pnpm --filter @browser-hitl/controller lint` -> PASS
  - `pnpm --filter @browser-hitl/slack-bot build` -> PASS
  - `pnpm --filter @browser-hitl/slack-bot lint` -> PASS
  - `pnpm --filter @browser-hitl/teams-bot build` -> PASS
  - `pnpm --filter @browser-hitl/teams-bot lint` -> PASS
  - `pnpm nx run-many --target=test --all --parallel=3` -> PASS
  - `helm template browser-hitl charts/browser-hitl` -> PASS

- Evidence:
  - `implementation_tracker/phase_4/evidence/checkpoint_20260219T160624Z/validation_summary.json`

- Files added:
  - `apps/api/src/modules/agent/agent.module.ts`
  - `apps/api/src/modules/agent/agent.controller.ts`
  - `apps/api/src/modules/agent/agent.service.ts`
  - `apps/api/src/modules/agent/agent.service.spec.ts`
  - `implementation_tracker/phase_4/PHASE_4_REMEDIATION_REGISTER.md`
  - `implementation_tracker/phase_4/evidence/checkpoint_20260219T160624Z/validation_summary.json`

- Files updated:
  - `apps/api/src/app.module.ts`
  - `apps/api/src/modules/auth/auth.controller.ts`
  - `apps/api/src/modules/auth/auth.service.ts`
  - `apps/api/src/modules/auth/auth.service.spec.ts`
  - `apps/controller/src/state-machine.service.spec.ts`
  - `apps/slack-bot/src/api-client.ts`
  - `apps/slack-bot/src/handlers/hitl-actions.ts`
  - `apps/slack-bot/src/nats-listener.ts`
  - `apps/teams-bot/src/api-client.ts`
  - `apps/teams-bot/src/handlers/hitl-actions.ts`
  - `charts/browser-hitl/templates/api-deployment.yaml`
  - `charts/browser-hitl/templates/configmap.yaml`
  - `charts/browser-hitl/templates/secrets.yaml`
  - `charts/browser-hitl/templates/slack-bot-deployment.yaml`
  - `charts/browser-hitl/templates/teams-bot-deployment.yaml`
  - `charts/browser-hitl/values.yaml`
  - `TEST_EXECUTION.md`

- Remaining:
  - Runtime deploy validation for new service-auth + wrapper paths.
  - Real Slack workspace end-to-end proof (pending user-provided Slack token details).

## 2026-02-19 - Entry 02 (Runtime Deploy + Endpoint Proof)

- Completed:
  - Built and loaded API image `browser-hitl/api:phase4a` into kind cluster.
  - Helm upgrade (release `browser-hitl`) with service-auth secrets/config:
    - `SERVICE_AUTH_CLIENT_ID=phase4-bot`
    - `SERVICE_AUTH_CLIENT_SECRET=phase4-secret`
    - `SERVICE_AUTH_ALLOWED_TENANT_IDS=*`
    - `SERVICE_AUTH_ALLOWED_ROLES=Operator`
    - `SERVICE_AUTH_DEFAULT_ROLE=Operator`
  - Verified API runtime behavior:
    - `POST /auth/service-token` returns bearer token (HTTP 200).
    - `POST /agent/run-url` creates run and returns action endpoints (HTTP 201).

- Evidence:
  - `implementation_tracker/phase_4/evidence/checkpoint_20260219T160624Z/service_token_response.json`
  - `implementation_tracker/phase_4/evidence/checkpoint_20260219T160624Z/agent_run_url_response.json`
  - `implementation_tracker/phase_4/evidence/checkpoint_20260219T160624Z/endpoint_validation_summary.json`
  - `implementation_tracker/phase_4/evidence/checkpoint_20260219T164057Z/service_token_response.json`
  - `implementation_tracker/phase_4/evidence/checkpoint_20260219T164057Z/agent_run_url_response.json`
  - `implementation_tracker/phase_4/evidence/checkpoint_20260219T164057Z/endpoint_validation_summary.json`

## 2026-02-19 - Entry 03 (UAT 22.4 Hardening + Full Pass)

- Completed:
  - Ran full UAT 22.4 suite against Phase 4 deployment; initial run failed due rollout-timeout brittleness in flow 6.
  - Hardened `scripts/e2e_uat_22_4.py`:
    - Added deployment-ready fallback check when rollout timeout occurs but deployment is effectively updated+available.
    - Increased rollout wait windows for flow 6 env flip/restore.
  - Re-ran UAT; second run failed due cluster CPU exhaustion from stale prior `uat-22-4-*` apps.
  - Added deterministic preflight cleanup:
    - scale prior `uat-22-4-*` apps to zero,
    - wait until related sessions terminate before creating the new UAT app.
  - Re-ran UAT a third time and achieved full PASS (flows 1-8).

- Validation executed:
  - `python3 -m py_compile scripts/e2e_uat_22_4.py` -> PASS
  - `EVIDENCE_ROOT=implementation_tracker/phase_4/evidence API_URL=http://localhost:18080 UAT_TEST_HARNESS_BUILD_IMAGE=false UAT_TEST_HARNESS_KIND_LOAD=true ./scripts/e2e-uat-22-4.sh` -> PASS

- Evidence:
  - Failure evidence (rollout timeout): `implementation_tracker/phase_4/evidence/uat_22_4_20260219T161659Z/summary.json`
  - Failure evidence (resource starvation): `implementation_tracker/phase_4/evidence/uat_22_4_20260219T162544Z/summary.json`
  - Final pass evidence: `implementation_tracker/phase_4/evidence/uat_22_4_20260219T163153Z/summary.json`
  - Cleanup evidence: `implementation_tracker/phase_4/evidence/uat_22_4_20260219T163153Z/preflight_uat_cleanup.json`

## 2026-02-19 - Entry 04 (Slack HITL Soft-First Plan)

- Completed:
  - Produced implementation/update plan for real-human Slack HITL demonstration.
  - Confirmed target workflow framing: headless automation -> HITL request -> human OTP input -> automation resumes -> Slack success notification.
  - Chosen soft-first scope to minimize changes and accelerate live validation.

- Plan artifact:
  - `implementation_tracker/phase_4/SLACK_HITL_SOFT_IMPLEMENTATION_PLAN.md`

## 2026-02-19 - Entry 05 (Slack HITL Soft Path - Implementation)

- Completed:
  - Implemented Slack completion notifications in `apps/slack-bot/src/nats-listener.ts`:
    - subscribed to `session.state.changed.>`
    - posts completion messages for:
      - `LOGIN_IN_PROGRESS -> HEALTHY`
      - `LOGIN_IN_PROGRESS -> FAILED`
  - Improved intervention prompt copy in `hitl.started` Slack message.
  - Added normalized tenant channel override handling:
    - supports `SLACK_CHANNEL_<TENANT_ID_UPPER>` with non-alnum normalization to `_`.
  - Added soft-mode Slack bridge executable with direct command UX:
    - file: `apps/slack-bot/src/soft-hitl-bridge.ts`
    - script: `pnpm --filter @browser-hitl/slack-bot start:soft`
    - command format: `OTP <session_id> <code>`
  - Added manual scenario script to trigger OTP HITL and wait for human recovery:
    - `scripts/hitl_manual_slack_scenario.py`
  - Added live operator runbook:
    - `implementation_tracker/phase_4/SLACK_HITL_SOFT_TEST_RUNBOOK.md`

- Validation executed:
  - `pnpm --filter @browser-hitl/slack-bot lint` -> PASS
  - `pnpm --filter @browser-hitl/slack-bot build` -> PASS
  - soft bridge startup smoke -> PASS (posted startup message to Slack)
  - soft bridge NATS event smoke -> PASS (posted HITL-required message from synthetic `hitl.started`)

- Runtime signal:
  - Slack channel received:
    - `Soft HITL bridge online. Waiting for interventions.`
    - synthetic HITL prompt with OTP command instructions

- Next:
  - Run full real-human OTP loop using runbook and capture evidence.

## 2026-02-19 - Entry 06 (Live Human Slack OTP Checkpoint)

- Completed:
  - Ran live soft-path Slack HITL scenario with real operator message in `#tabby-experiments`.
  - First human attempt used placeholder literal (`<code>`), which delivered but did not authenticate.
  - Updated soft bridge to reduce operator error:
    - HITL prompt now includes explicit example OTP value (`123456` for test harness).
    - OTP command now validates numeric format and rejects placeholders/non-digit values.
  - Re-ran manual scenario and achieved PASS (`HEALTHY`) after human OTP submission.
  - Fixed completion notification edge case:
    - soft bridge now posts resume message for any pending session transitioning to `HEALTHY`
      (not only `LOGIN_IN_PROGRESS -> HEALTHY`).
  - Verified completion message behavior by NATS started + state-changed simulation.

- Evidence:
  - Live manual run PASS:
    - `implementation_tracker/phase_4/evidence/manual_slack_hitl_20260219T185055Z/summary.json`
  - Slack timestamps (manual run):
    - OTP command: `1771527089.898069`
    - OTP delivered ack: `1771527092.308489`
  - Slack completion-message fix validation (synthetic transition):
    - HITL prompt: `1771527183.441839`
    - Resume message: `1771527184.561979`

## 2026-02-19 - Entry 07 (Stream Viewer 404 Closure)

- Completed:
  - Diagnosed ngrok stream-page blank screen/`rfb.js` 404 root cause:
    - API viewer template referenced invalid noVNC CDN path
      `@novnc/novnc@1.5.0/core/rfb.js`.
  - Fixed stream viewer import path:
    - `apps/api/src/modules/streaming/streaming.controller.ts`
    - updated to `@novnc/novnc@1.5.0/lib/rfb.js`.
  - Rebuilt and rolled API runtime with explicit image bump:
    - built `browser-hitl/api:phase4b`
    - loaded image into kind cluster
    - set deployment image + completed rollout.

- Validation executed:
  - Retrieved live stream page over ngrok and verified import path contains `lib/rfb.js` (no `core/rfb.js`).
  - Probed external websocket upgrade path and got `101 Switching Protocols` on:
    - `wss://<ngrok-host>/vnc-ws?...`

- Evidence:
  - `implementation_tracker/phase_4/evidence/stream_fix_20260219T191515Z/summary.json`
  - `implementation_tracker/phase_4/evidence/stream_fix_20260219T191515Z/viewer_import_check.txt`
  - `implementation_tracker/phase_4/evidence/stream_fix_20260219T191515Z/ws_upgrade_probe.json`

## 2026-02-19 - Entry 08 (Stream Viewer ESM Export Fix)

- Completed:
  - Diagnosed new browser runtime error after 404 fix:
    - `.../lib/rfb.js does not provide an export named 'default'`.
  - Root cause:
    - npm package `@novnc/novnc@1.5.0/lib/rfb.js` is CJS-transpiled output, not browser-native ESM.
  - Implemented viewer import correction to browser-native ESM source:
    - `apps/api/src/modules/streaming/streaming.controller.ts`
    - `https://cdn.jsdelivr.net/gh/novnc/noVNC@v1.5.0/core/rfb.js`
  - Rebuilt and rolled API runtime:
    - image `browser-hitl/api:phase4c`
    - deployment image updated and rollout completed.

- Validation executed:
  - Live ngrok-served viewer page confirms import path now points to `gh/novnc/noVNC@v1.5.0/core/rfb.js`.
  - Source module check confirms `export default class RFB` in upstream ESM file.

- Evidence:
  - `implementation_tracker/phase_4/evidence/stream_fix_20260219T192243Z/summary.json`
  - `implementation_tracker/phase_4/evidence/stream_fix_20260219T192243Z/viewer_import_check.txt`
  - `implementation_tracker/phase_4/evidence/stream_fix_20260219T192243Z/novnc_export_check.txt`

## 2026-02-19 - Entry 09 (UX Polish: Harness UI + Slack Cards)

- Completed:
  - Confirmed latest live HITL session state:
    - session `b647b0dc-dcb4-4adb-a5cd-9c6f4a832a0c` is `HEALTHY`.
  - Refreshed test-harness visual UX with sensible CSS styling:
    - `test-harness/templates/login.html`
    - `test-harness/templates/otp.html`
    - `test-harness/templates/dashboard.html`
  - Refactored Slack soft bridge messages to Block Kit "card" style:
    - `apps/slack-bot/src/soft-hitl-bridge.ts`
    - HITL request card now shows session/app context and command shape
      `OTP <session_id> <one-time-code>` without exposing literal OTP test value.
    - Success card now thanks the user and confirms automation continuation.
    - Failure and delivery acknowledgements updated for cleaner operator-facing copy.
  - Rebuilt Slack bot and relaunched soft bridge process for runtime activation.

- Validation executed:
  - `pnpm --filter @browser-hitl/slack-bot lint` -> PASS
  - `pnpm --filter @browser-hitl/slack-bot build` -> PASS
  - Synthetic event validation in Slack:
    - request card header: `Action Required: OTP Verification`
    - success card header: `Thank You: Verification Complete`
    - no literal `123456` in request prompt content.

- Evidence:
  - `implementation_tracker/phase_4/evidence/slack_ux_refresh_20260219T193312Z/final_session_state.json`
  - `implementation_tracker/phase_4/evidence/slack_ux_refresh_20260219T193312Z/slack_recent_messages.json`
  - `implementation_tracker/phase_4/evidence/slack_ux_refresh_20260219T193312Z/summary.json`

## 2026-02-19 - Entry 10 (Slack Completion Guard Fix)

- Completed:
  - Addressed false-positive completion messaging risk:
    - prior behavior could emit "Thank You: Verification Complete" on `HEALTHY`
      even if no OTP was submitted via Slack.
  - Updated pending-session tracking in `apps/slack-bot/src/soft-hitl-bridge.ts`:
    - track `otpSubmittedAt` when OTP command is successfully submitted.
    - emit "Thank You: Verification Complete" only if OTP was submitted.
    - otherwise emit neutral closure card "Session Recovered Automatically".
  - Rebuilt Slack bot and relaunched soft bridge with restored NATS port-forward.

- Validation executed:
  - `pnpm --filter @browser-hitl/slack-bot lint` -> PASS
  - `pnpm --filter @browser-hitl/slack-bot build` -> PASS
  - Synthetic no-OTP path validation:
    - request card posted
    - followed by "Session Recovered Automatically" (no thank-you card).

- Evidence:
  - `implementation_tracker/phase_4/evidence/slack_ux_guard_20260219T193654Z/slack_recent_messages.json`
  - `implementation_tracker/phase_4/evidence/slack_ux_guard_20260219T193654Z/summary.json`

## 2026-02-19 - Entry 11 (Live Human Run Re-Validation)

- Completed:
  - Triggered a fresh manual Slack HITL run and validated full human OTP loop:
    - app `ffbaf969-1306-437d-be02-a501283e870e`
    - session `f0485893-40cb-4419-b7ef-58b7fb958fd0`
    - final state `HEALTHY`.
  - Operator confirmed VNC stream and successful Slack interaction.
  - Guard behavior validated in live outcome:
    - success "Thank You" card emitted after real OTP submission.
  - Deployed updated test-harness UI image so visual polish is active in cluster:
    - `browser-hitl/test-harness:phase4u1`.

- Important reliability note:
  - `hitl.started` event still required manual NATS stimulation in this run to ensure Slack request prompt delivery.
  - Controller state transition observed was `STARTING -> HEALTHY` (without canonical `LOGIN_IN_PROGRESS` transition chain), consistent with known open item on explicit OTP-requested eventing.

- Evidence:
  - Manual run summary: `implementation_tracker/phase_4/evidence/manual_slack_hitl_20260219T193805Z/summary.json`
  - Slack timeline: `implementation_tracker/phase_4/evidence/manual_slack_hitl_20260219T193805Z/slack_timeline.json`
  - Full postmortem: `implementation_tracker/phase_4/POSTMORTEM_2026-02-19_HITL_LIVE_VALIDATION.md`

## 2026-02-19 - Entry 12 (Full SBOM Bundle Generation via Syft)

- Completed:
  - Generated full-source SBOM for project workspace using Syft.
  - Generated per-image SBOMs for all unique runtime images currently used in the `browser-hitl` namespace snapshot.
  - Produced both SPDX JSON and CycloneDX JSON outputs.
  - Added artifact integrity checksums and manifest.

- Output bundle:
  - `implementation_tracker/phase_4/sbom/sbom_20260219T201118Z`
  - generation record: `implementation_tracker/phase_4/SBOM_GENERATION_2026-02-19.md`

- Counts:
  - source artifacts: 2 (`source.spdx.json`, `source.cyclonedx.json`)
  - image list size: 10
  - image SPDX artifacts: 10
  - image CycloneDX artifacts: 10

## 2026-02-19 - Entry 13 (Closure Matrix Execution - Fix-Now Batch 2)

- Completed:
  - Added exact closure matrix and started implementation execution tracking:
    - `implementation_tracker/final_assessment/TABBY_LIMITATIONS_CLOSURE_MATRIX.md`
  - Implemented additional fix-now hardening items:
    - `LIM-012`: Slack soft bridge command polling now uses paginated history backfill (`cursor` + bounded pages), reducing missed-command risk during channel bursts.
    - `LIM-041`: Added standardized API pagination DTO with strict bounds (`limit 1..200`, `offset 0..100000`) and applied it across apps/sessions/users/tenants list endpoints.
    - `LIM-043`: Added strict Slack operator allowlist gating in soft bridge (`SLACK_SOFT_ALLOWED_USER_IDS`), fail-closed unless explicit override is enabled.
    - `LIM-046`: Egress proxy admin API now fails closed if `EGRESS_PROXY_ADMIN_TOKEN` is unset (unless explicit insecure override flag is set).
    - `LIM-052`: Service auth tenant scope now fails closed; wildcard tenant scope is blocked unless explicitly enabled.
  - Updated Helm defaults/templates for new service-auth and egress-proxy hardening env vars.

- Validation executed:
  - `pnpm nx run @browser-hitl/api:test` -> PASS
  - `pnpm nx run @browser-hitl/api:build` -> PASS
  - `pnpm nx run @browser-hitl/slack-bot:build` -> PASS
  - `helm template browser-hitl charts/browser-hitl` -> PASS

- Notes:
  - This batch prioritizes production-conducive hardening defaults; local development now requires explicit opt-in for insecure modes where applicable.

## 2026-02-19 - Entry 14 (Closure Matrix Execution - Fix-Now Batch 3)

- Completed:
  - Implemented deterministic OTP-request publication from the controller state machine:
    - `hitl.otp-requested` is now emitted from the authoritative `LOGIN_NEEDED -> LOGIN_IN_PROGRESS` transition path, paired with `hitl.started`.
    - Added app name resolution in controller for richer OTP request payloads.
  - Implemented deterministic HITL completion publication for closure contracts:
    - Controller now emits `hitl.completed` with `SUCCESS` and `TIMEOUT` outcomes when interventions are closed in `LOGIN_IN_PROGRESS`.
    - Slack soft bridge now subscribes to `hitl.completed` to clear stale pending interventions on timeout/failure closure.
  - Added `POST /agent/run-url` idempotency semantics:
    - `Idempotency-Key` header support.
    - Redis-backed reservation + replay path.
    - Payload-hash mismatch protection for key reuse.
    - In-progress collision handling.
  - Added intervention lifecycle observability instrumentation:
    - Counters/histogram for requested/submitted/completed/success/timeout/failed/resumed states and request-to-resolution latency.
    - OTP submission path now increments dedicated lifecycle counter.

- Limitation closures advanced in this batch:
  - `LIM-001` -> Implemented
  - `LIM-017` -> Implemented
  - `LIM-040` -> Implemented
  - `LIM-057` -> Implemented

- Validation executed:
  - `pnpm nx run @browser-hitl/controller:test` -> PASS
  - `pnpm nx run @browser-hitl/api:test` -> PASS
  - `pnpm nx run @browser-hitl/slack-bot:build` -> PASS
  - `pnpm nx run @browser-hitl/api:build` -> PASS
  - `pnpm nx run @browser-hitl/controller:build` -> PASS
  - `pnpm nx run @browser-hitl/slack-bot:lint` -> PASS
  - `helm template browser-hitl charts/browser-hitl` -> PASS

## 2026-02-19 - Entry 15 (Closure Matrix Execution - Fix-Now Batch 4)

- Completed:
  - Hardened artifact retrieval path to enforce single-use token consumption at access time:
    - Added authenticated API download route: `GET /artifacts/:id/download?token_id=...`
    - Token CAS validation now occurs before object stream retrieval.
    - Consumption/audit is now recorded at successful retrieval (not only issuance).
    - URL issuance now returns API download URL instead of internal MinIO host URL.
  - Improved `run-url` ergonomics for multi-session runs:
    - Response now includes `session_ids` and per-session endpoint/stream objects while retaining primary `session_id` compatibility.
  - Stream URL canonicalization hardened:
    - Added validated `PUBLIC_BASE_URL` support with explicit host/protocol fallback controls.
  - Controller drift + orphan handling implemented:
    - Runtime drift reconciliation now detects missing pods for active sessions and self-heals state/runtime cleanup.
    - Added orphan worker pod sweeper for missing/terminated session ownership.
  - Egress policy path hardened to fail-closed:
    - Allowlist sync failures now error (configurable via `EGRESS_POLICY_FAIL_CLOSED`) and trigger session termination in reconcile.
    - NetworkPolicy creation now propagates errors to session provisioning failure handling.
  - Tightened worker egress NetworkPolicy scope:
    - Replaced namespace-wide internal-port allowance with explicit component pod selectors.
  - Tightened controller RBAC:
    - Removed unneeded `secrets` and `configmaps` read permissions.

- Limitation closures advanced in this batch:
  - `LIM-002` -> Implemented
  - `LIM-006` -> Implemented
  - `LIM-008` -> Implemented
  - `LIM-023` -> Implemented
  - `LIM-036` -> Implemented
  - `LIM-042` -> Implemented
  - `LIM-047` -> Implemented
  - `LIM-049` -> Implemented
  - `LIM-054` -> Implemented

- Validation executed:
  - `pnpm nx run @browser-hitl/api:test` -> PASS
  - `pnpm nx run @browser-hitl/controller:test` -> PASS
  - `pnpm nx run @browser-hitl/api:build` -> PASS
  - `pnpm nx run @browser-hitl/controller:build` -> PASS
  - `pnpm nx run @browser-hitl/slack-bot:build` -> PASS
  - `pnpm nx run @browser-hitl/slack-bot:lint` -> PASS
  - `helm template browser-hitl charts/browser-hitl` -> PASS

## 2026-02-19 - Entry 16 (Closure Matrix Execution - Fix-Now Batch 5)

- Completed:
  - Implemented session-scoped egress allowlist enforcement (`LIM-005`):
    - Controller now generates per-session authenticated proxy URLs using `EGRESS_PROXY_SESSION_KEY`.
    - Egress proxy validates session credentials and evaluates allowlists by session scope (no global union by default).
    - Added fail-closed behavior when session key is missing unless explicit insecure override is enabled.
    - Updated Helm values/secrets/deployments for `EGRESS_PROXY_SESSION_KEY` and session-scope hardening flags.
  - Implemented noVNC self-hosting (`LIM-030`):
    - API now serves local noVNC ESM module at `/vnc/assets/rfb.js`.
    - Viewer no longer depends on runtime CDN fetch for `rfb.js`.
  - Implemented stream token query reduction (`LIM-044`):
    - Stream URLs now emit token in URL fragment (`#token=...`) by default.
    - Viewer forwards token to WebSocket via `Sec-WebSocket-Protocol` (`token.<jwt>`) instead of URL query.
    - Proxy accepts token from websocket subprotocol, with query token retained only for backward compatibility.
  - Reduced runtime/chart drift (`LIM-033`):
    - Removed unused Helm worker-template ConfigMap (`worker-template-configmap.yaml`) to eliminate stale template divergence.
  - Closed previously-implemented-but-unmarked fix-now items in matrix:
    - `LIM-018`, `LIM-022`, `LIM-028`, `LIM-029`, `LIM-039`.

- Limitation closures advanced in this batch:
  - `LIM-005` -> Implemented
  - `LIM-018` -> Implemented (matrix sync)
  - `LIM-022` -> Implemented (matrix sync)
  - `LIM-028` -> Implemented (matrix sync)
  - `LIM-029` -> Implemented (matrix sync)
  - `LIM-030` -> Implemented
  - `LIM-033` -> Implemented
  - `LIM-039` -> Implemented (matrix sync)
  - `LIM-044` -> Implemented

- Validation executed:
  - `NX_DAEMON=false pnpm nx run @browser-hitl/api:test` -> PASS
  - `NX_DAEMON=false pnpm nx run @browser-hitl/controller:test` -> PASS
  - `NX_DAEMON=false pnpm nx run @browser-hitl/worker:test` -> PASS
  - `NX_DAEMON=false pnpm nx run @browser-hitl/api:build` -> PASS
  - `NX_DAEMON=false pnpm nx run @browser-hitl/controller:build` -> PASS
  - `NX_DAEMON=false pnpm nx run @browser-hitl/worker:build` -> PASS
  - `NX_DAEMON=false pnpm nx run @browser-hitl/slack-bot:build` -> PASS
  - `NX_DAEMON=false pnpm nx run @browser-hitl/slack-bot:lint` -> PASS
  - `helm template browser-hitl charts/browser-hitl` -> PASS

## 2026-02-19 - Entry 17 (Local ngrok Tunnelization + Operator Runbook)

- Completed:
  - Brought up host ngrok tunnel for local API testing (`localhost:18080`) and captured active public URL.
  - Updated live API deployment stream routing env to current tunnel host:
    - `STREAM_HOST=d157-2803-6000-e005-64e-cf54-a5f8-929e-fb27.ngrok-free.app`
    - `STREAM_PROTOCOL=https`
  - Added reusable local tunnel lifecycle script:
    - `scripts/local-stack-ngrok.sh` with `up|down|status|url`.
    - Supports optional API stream env apply (`LOCAL_APPLY_STREAM_ENV=true`).
  - Added Makefile local test orchestration targets:
    - `local-ngrok-up`
    - `local-ngrok-up-apply-stream-host`
    - `local-ngrok-status`
    - `local-ngrok-url`
    - `local-ngrok-down`
    - `e2e-uat-22-4-local`
  - Added root operator runbook:
    - `RUNBOOK.md` for full stack bring-up, ngrok wiring, automated E2E/UAT, and Slack HITL validation.

- Validation executed:
  - `bash -n scripts/local-stack-ngrok.sh` -> PASS
  - `make -n local-ngrok-up local-ngrok-up-apply-stream-host local-ngrok-status local-ngrok-url local-ngrok-down e2e-uat-22-4-local` -> PASS
  - `make local-ngrok-up-apply-stream-host` -> PASS
  - `make local-ngrok-url` -> PASS
  - `kubectl -n browser-hitl set env deployment/browser-hitl-api STREAM_HOST=<captured_host> STREAM_PROTOCOL=https` -> PASS
  - `kubectl -n browser-hitl rollout status deployment/browser-hitl-api --timeout=180s` -> PASS

- Evidence:
  - `implementation_tracker/phase_4/evidence/local_ngrok_bootstrap_20260219T235321Z/summary.json`
  - `implementation_tracker/phase_4/evidence/local_ngrok_bootstrap_20260219T235321Z/ngrok_tunnels.json`
  - `implementation_tracker/phase_4/evidence/local_ngrok_bootstrap_20260219T235321Z/ngrok_upstream_probe.json`
  - `implementation_tracker/phase_4/evidence/local_ngrok_bootstrap_20260219T235321Z/api_stream_env.txt`

- Files added:
  - `scripts/local-stack-ngrok.sh`
  - `RUNBOOK.md`

- Files updated:
  - `Makefile`

## 2026-02-20 - Entry 18 (Slack Card + Viewer Regression Closure)

- Completed:
  - Fixed soft Slack HITL card operator UX regression:
    - Added explicit `Reply With OTP` button on request cards in `apps/slack-bot/src/soft-hitl-bridge.ts`.
    - Button uses Slack app redirect to open the target channel for command reply.
  - Fixed viewer runtime regression causing `rfb.js` failures:
    - `apps/api/src/modules/streaming/streaming.controller.ts` now serves `/vnc/assets/rfb.js` by:
      - loading local `@novnc/novnc/core/rfb.js` when present, or
      - falling back to cached fetch from `https://cdn.jsdelivr.net/gh/novnc/noVNC@v1.5.0/core/rfb.js`.
    - Added inline favicon link in stream HTML (`<link rel="icon" href="data:," />`) to suppress browser `/favicon.ico` 404 noise.
  - Fixed ngrok/local routing drift that produced bad Slack stream links:
    - Root cause: `PUBLIC_BASE_URL=http://localhost:18080` from configmap overrode `STREAM_HOST`.
    - Local tunnel script now applies `PUBLIC_BASE_URL=https://<ngrok-host>` together with stream host/protocol.
  - Hardened local tunnel lifecycle resilience:
    - `scripts/local-stack-ngrok.sh` now re-checks health after API rollout and repairs dropped port-forward before returning success.

- Runtime deployment and validation:
  - Built and rolled API image: `browser-hitl/api:phase4f`.
  - Verified:
    - `/vnc/assets/rfb.js` returns HTTP 200 over ngrok.
    - stream viewer HTML imports `/vnc/assets/rfb.js` and includes inline favicon link.
    - latest Slack HITL card contains both:
      - `Open Live Stream` (public ngrok URL),
      - `Reply With OTP`.

- Validation executed:
  - `pnpm --filter @browser-hitl/slack-bot build` -> PASS
  - `pnpm --filter @browser-hitl/slack-bot lint` -> PASS
  - `pnpm --filter @browser-hitl/api build` -> PASS
  - `pnpm --filter @browser-hitl/api lint` -> PASS
  - `docker build -f infra/docker/Dockerfile.api -t browser-hitl/api:phase4f .` -> PASS
  - `kind load docker-image browser-hitl/api:phase4f --name browser-hitl-phase3` -> PASS
  - `helm upgrade browser-hitl charts/browser-hitl -n browser-hitl --reuse-values --set images.api.tag=phase4f` -> PASS
  - `kubectl -n browser-hitl rollout status deployment/browser-hitl-api --timeout=180s` -> PASS

- Evidence:
  - `implementation_tracker/phase_4/evidence/slack_reply_button_stream_fix_20260220T004655Z/summary.json`
  - `implementation_tracker/phase_4/evidence/slack_reply_button_stream_fix_20260220T004655Z/slack_message_summary.json`
  - `implementation_tracker/phase_4/evidence/slack_reply_button_stream_fix_20260220T004655Z/stream_url_response.json`
  - `implementation_tracker/phase_4/evidence/slack_reply_button_stream_fix_20260220T004655Z/viewer_import_check.txt`
  - `implementation_tracker/phase_4/evidence/slack_reply_button_stream_fix_20260220T004655Z/rfb_head.txt`

## 2026-02-20 - Entry 19 (Viewer 404 Deep Closure: Full noVNC Module Tree)

- Completed:
  - Diagnosed remaining viewer 404 chain after `rfb.js` fix:
    - root cause was missing serving routes for transitive noVNC ESM dependencies.
    - browser requests included both `/vnc/assets/*` and `/vnc/vendor/*` module paths.
  - Extended API streaming asset serving in `apps/api/src/modules/streaming/streaming.controller.ts`:
    - added `GET /vnc/assets/*` recursive module serving with safe path normalization.
    - added `GET /vnc/vendor/*` recursive vendor module serving (pako zlib modules).
    - both routes support local package resolution when available and CDN fallback to pinned `noVNC@v1.5.0`.
    - added per-path in-memory caching and content-type resolution for served modules.
  - Built/rolled API image `browser-hitl/api:phase4h`.

- Validation executed:
  - `pnpm --filter @browser-hitl/api build` -> PASS
  - `pnpm --filter @browser-hitl/api lint` -> PASS
  - `docker build -f infra/docker/Dockerfile.api -t browser-hitl/api:phase4h .` -> PASS
  - `kind load docker-image browser-hitl/api:phase4h --name browser-hitl-phase3` -> PASS
  - `helm upgrade browser-hitl charts/browser-hitl -n browser-hitl --reuse-values --set images.api.tag=phase4h` -> PASS
  - `kubectl -n browser-hitl rollout status deployment/browser-hitl-api --timeout=180s` -> PASS
  - Module probes over ngrok:
    - `/vnc/assets/rfb.js` -> 200
    - `/vnc/assets/util/int.js` -> 200
    - `/vnc/assets/input/keyboard.js` -> 200
    - `/vnc/assets/decoders/raw.js` -> 200
    - `/vnc/assets/crypto/crypto.js` -> 200
    - `/vnc/vendor/pako/lib/zlib/inflate.js` -> 200
    - `/vnc/vendor/pako/lib/zlib/deflate.js` -> 200

- Evidence:
  - `implementation_tracker/phase_4/evidence/viewer_404_final_fix_20260220T011158Z/summary.json`
  - `implementation_tracker/phase_4/evidence/viewer_404_final_fix_20260220T011158Z/module_status.tsv`
  - `implementation_tracker/phase_4/evidence/viewer_404_final_fix_20260220T011158Z/viewer_import_check.txt`

## 2026-02-20 - Entry 20 (Slack OTP Reply Parsing Reliability Fix)

- Completed:
  - Diagnosed missing Slack response after user OTP command:
    - user message was formatted as inline code (wrapped in backticks), e.g. `` `OTP <session_id> 123456` ``.
    - soft bridge regex previously matched only plain `OTP ...` and silently ignored wrapped text.
  - Implemented robust command normalization in `apps/slack-bot/src/soft-hitl-bridge.ts`:
    - strips common Slack wrappers (`> ` quote prefix, backticks, quotes).
    - continues to enforce OTP digits-only validation.
    - now emits explicit feedback for malformed `OTP`/`OPEN` commands instead of silent ignore.
  - Rebuilt and restarted soft bridge runtime with updated parser.
  - Triggered fresh HITL request message for live re-test session.

- Validation executed:
  - `pnpm --filter @browser-hitl/slack-bot build` -> PASS
  - `pnpm --filter @browser-hitl/slack-bot lint` -> PASS
  - Runtime signal observed:
    - new user OTP command was parsed and produced explicit response (`OTP delivery failed ...`) instead of silent drop.

- Evidence:
  - `implementation_tracker/phase_4/evidence/otp_command_parse_fix_20260220T011832Z/summary.json`
  - `implementation_tracker/phase_4/evidence/otp_command_parse_fix_20260220T011832Z/slack_history.json`
  - `implementation_tracker/phase_4/evidence/otp_command_parse_fix_20260220T011832Z/highlights.json`

## 2026-02-20 - Entry 21 (Final Slack E2E Closure + Fresh ngrok Reactivation)

- Completed:
  - Closed the worker-side OTP state progression regression:
    - updated `apps/worker/src/login-dsl-runner.ts` to invoke an OTP wait-start callback when sensitive `wait_for` enters OTP polling.
    - wired `apps/worker/src/main.ts` to mark `health_result_type=AUTH_FAIL` immediately at OTP wait entry.
    - this unblocks controller transition from `STARTING` to `LOGIN_NEEDED`/`LOGIN_IN_PROGRESS` before OTP submission.
  - Added regression coverage in `apps/worker/src/login-dsl-runner.spec.ts` to assert OTP wait callback invocation.
  - Built/loaded new worker image `browser-hitl/worker:phase3h` and updated controller runtime worker image selection.
  - Re-activated local ngrok with fresh host and re-applied API stream environment:
    - `STREAM_PROTOCOL=https`
    - `STREAM_HOST=8a5f-2803-6000-e005-64e-cf54-a5f8-929e-fb27.ngrok-free.app`
    - `PUBLIC_BASE_URL=https://8a5f-2803-6000-e005-64e-cf54-a5f8-929e-fb27.ngrok-free.app`
  - Executed final live Slack E2E in `#tabby-experiments`:
    - HITL request posted for session `762d538c-04cf-4659-bac0-f96b34b5e69f`.
    - human OTP command posted in Slack.
    - bot responses observed:
      - `OTP delivered for session ...`
      - `OTP accepted for session ... Agent resumed.`
    - session converged to `HEALTHY` with `health_result_type=PASS`.

- Validation executed:
  - `pnpm --filter @browser-hitl/worker test -- login-dsl-runner.spec.ts` -> PASS
  - `pnpm --filter @browser-hitl/worker build` -> PASS
  - `docker build -f infra/docker/Dockerfile.worker -t browser-hitl/worker:phase3h .` -> PASS
  - in-node import verified:
    - `crictl images` shows `browser-hitl/worker:phase3h`
  - `kubectl set env -n browser-hitl deployment/browser-hitl-controller WORKER_IMAGE=browser-hitl/worker:phase3h` -> PASS
  - `kubectl rollout status -n browser-hitl deployment/browser-hitl-controller --timeout=180s` -> PASS
  - `kubectl set env -n browser-hitl deployment/browser-hitl-api STREAM_PROTOCOL=https STREAM_HOST=<fresh_ngrok_host> PUBLIC_BASE_URL=<fresh_ngrok_url>` -> PASS
  - `kubectl rollout status -n browser-hitl deployment/browser-hitl-api --timeout=180s` -> PASS
  - Viewer endpoint probes on fresh tunnel:
    - `/vnc/assets/rfb.js` -> 200
    - `/vnc/vendor/pako/lib/zlib/inflate.js` -> 200
    - `/vnc/<session_id>` -> 200

- Evidence:
  - `implementation_tracker/phase_4/evidence/manual_slack_hitl_20260220T020755Z/summary.json`
  - `implementation_tracker/phase_4/evidence/final_slack_e2e_20260220T021032Z/summary.json`
  - `implementation_tracker/phase_4/evidence/final_slack_e2e_20260220T021032Z/slack_history.json`
  - `implementation_tracker/phase_4/evidence/final_slack_e2e_20260220T021032Z/session_state.json`
  - `implementation_tracker/phase_4/evidence/final_slack_e2e_20260220T021032Z/stream_url.json`

## 2026-02-20 - Entry 22 (Executive Demo Slack Message Styling Refresh)

- Completed:
  - Updated Slack soft-HITL executive-demo copy and layout in `apps/slack-bot/src/soft-hitl-bridge.ts`.
  - Action Required card changes:
    - Header now: `Action Required: Salesforce Authentication 🔒`.
    - Primary body now: `Your adopt.ai agent requires authentication to proceed. Please submit your one time password (OTP) so the work can proceed!`
    - Removed Session ID/App ID field block from card body.
    - Kept `Reply in this channel with:` command example.
    - Removed optional stream refresh command line.
    - Kept `Open Live Stream` action button.
    - Removed `Reply With OTP` action button.
  - OTP submission acknowledgement changes:
    - Replaced with: `Thanks. I received your code. Waiting for your Adopt agent to continue the task..`
  - Verification completion message changes:
    - Header now: `Thank You: Verification Complete ✅`.
    - Subtext now: `Your code was accepted. The agent is continuing its task.`
    - Removed Session ID/Transition details from verification block.

- Validation executed:
  - `pnpm --filter @browser-hitl/slack-bot build` -> PASS
  - `pnpm --filter @browser-hitl/slack-bot lint` -> PASS
  - Restarted soft bridge runtime and confirmed updated Action Required block in live Slack channel.

- Evidence:
  - `implementation_tracker/phase_4/evidence/slack_demo_styling_20260220T022714Z/summary.json`
  - `implementation_tracker/phase_4/evidence/slack_demo_styling_20260220T022714Z/action_required_message.json`
  - `implementation_tracker/phase_4/evidence/slack_demo_styling_20260220T022714Z/slack_history.json`

## 2026-02-20 - Entry 23 (Runbook Hardening for Clean-Canvas Slack/VNC E2E)

- Completed:
  - Updated root `RUNBOOK.md` to a deterministic clean-start sequence:
    - explicit clean-canvas reset (`local-ngrok-down`, helm uninstall, kind delete).
    - explicit fresh-ngrok-first requirement before new session startup.
    - explicit CPU-capacity remediation for stale active apps/worker pods.
    - updated expected Slack message copy and VNC checks for the executive-demo flow.
  - Added local environment template `.env.example` for Slack/API/NATS/admin wiring.
  - Added local operator env file `.env.local` (git-ignored) and stored:
    - `SLACK_BOT_TOKEN=<configured>`
    - `SLACK_CHANNEL=tabby-experiments`
  - Added Make targets to enforce repeatable local operations:
    - `local-ngrok-refresh-apply-stream-host`
    - `hitl-scale-down-active`
    - `slack-soft-start`
  - Added utility script:
    - `scripts/hitl-scale-down-active-apps.sh` (scales all apps with `desired_session_count>0` to `0`).
  - Updated `implementation_tracker/phase_4/SLACK_HITL_SOFT_TEST_RUNBOOK.md` to align with root runbook and latest message/flow behavior.

- Validation executed:
  - `bash -n scripts/hitl-scale-down-active-apps.sh` -> PASS
  - `API_URL=http://localhost:18080 ./scripts/hitl-scale-down-active-apps.sh` -> PASS
  - `make help | rg "local-ngrok-refresh-apply-stream-host|hitl-scale-down-active|slack-soft-start"` -> PASS
  - verified `.env.local` contains `SLACK_BOT_TOKEN` and `SLACK_CHANNEL` entries.

- Evidence:
  - `RUNBOOK.md`
  - `.env.example`
  - `scripts/hitl-scale-down-active-apps.sh`
  - `Makefile`
  - `implementation_tracker/phase_4/SLACK_HITL_SOFT_TEST_RUNBOOK.md`

## 2026-02-20 - Entry 24 (Reliability Hardening Release - Environment Sensitivity Closure Pass)

- Completed:
  - Implemented deterministic local reliability orchestration scripts:
    - `scripts/local-reliability-preflight.sh`
      - strict checks for API reachability, admin auth, ngrok/API stream-host alignment, viewer asset probes, stale active-app drain, worker pod state health, and optional local NATS availability.
      - supports `--auto-fix` mode to remediate stale env/state in one pass.
    - `scripts/local-fresh-e2e.sh`
      - one-pass orchestration flow for local reliability runs:
        - refresh ngrok + apply API stream env
        - scale down stale active apps
        - clear stale worker pods
        - bring up managed local NATS port-forward
        - bring up managed Slack soft bridge
        - run full reliability preflight
    - `scripts/local-nats-port-forward.sh`
      - managed `up/down/status` lifecycle for local NATS port-forward with PID/log tracking.
    - `scripts/local-slack-soft-bridge.sh`
      - managed `up/down/status/logs` lifecycle for Slack soft bridge with env-file loading, startup checks, PID/log tracking.
  - Extended Makefile with deterministic reliability targets:
    - `local-nats-up`, `local-nats-status`, `local-nats-down`
    - `local-slack-soft-up`, `local-slack-soft-status`, `local-slack-soft-logs`, `local-slack-soft-down`
    - `local-reliability-preflight`
    - `local-fresh-e2e`
    - `local-fresh-down`
  - Improved `make help` target discovery by including numeric target names (`[a-zA-Z0-9_-]+`), ensuring reliability targets with `e2e` are visible.
  - Updated `RUNBOOK.md` and phase-4 Slack runbook to include single-command deterministic reliability path (`make local-fresh-e2e`) and managed helper process mode.

- Validation executed:
  - `bash -n scripts/local-nats-port-forward.sh scripts/local-slack-soft-bridge.sh scripts/local-reliability-preflight.sh scripts/local-fresh-e2e.sh` -> PASS
  - `./scripts/local-reliability-preflight.sh --env-file .env.local --auto-fix --require-nats` -> PASS
  - `./scripts/local-slack-soft-bridge.sh up` -> PASS
  - `./scripts/local-slack-soft-bridge.sh status` -> PASS
  - `./scripts/local-nats-port-forward.sh up` + `status` -> PASS
  - `./scripts/local-fresh-e2e.sh --env-file .env.local` -> PASS
  - `make local-fresh-e2e` -> PASS
  - `make local-fresh-down` -> PASS
  - post-down checks (`local-nats status`, `local-slack-soft status`, `make local-ngrok-status`) -> PASS

- Evidence:
  - `scripts/local-reliability-preflight.sh`
  - `scripts/local-fresh-e2e.sh`
  - `scripts/local-nats-port-forward.sh`
  - `scripts/local-slack-soft-bridge.sh`
  - `Makefile`
  - `RUNBOOK.md`
  - `implementation_tracker/phase_4/SLACK_HITL_SOFT_TEST_RUNBOOK.md`

## 2026-02-20 - Entry 25 (Reliability Hardening Release - Runtime Revalidation on New Branch)

- Completed:
  - Revalidated reliability hardening flow on branch `reliability_hardening_release`.
  - Confirmed the new one-command bootstrap path works from a clean local condition where API was initially unavailable.
  - Confirmed `make help` now reliably exposes hardening targets with numeric suffixes (including `local-fresh-e2e`).

- Validation executed:
  - `bash -n scripts/local-fresh-e2e.sh scripts/local-nats-port-forward.sh scripts/local-reliability-preflight.sh scripts/local-slack-soft-bridge.sh` -> PASS
  - `make help | rg "local-fresh-e2e|local-reliability-preflight|local-nats-up|local-slack-soft-up|local-fresh-down"` -> PASS
  - `./scripts/local-reliability-preflight.sh --env-file .env.local --auto-fix --require-nats` -> FAIL (expected on clean canvas): API not yet reachable at `http://localhost:18080`
  - `make local-fresh-e2e` -> PASS
    - refreshed ngrok + applied API stream env
    - started NATS port-forward on `127.0.0.1:4222`
    - started Slack soft bridge and observed healthy startup log marker
    - full preflight PASS including viewer asset checks:
      - `/vnc/assets/rfb.js` -> 200
      - `/vnc/vendor/pako/lib/zlib/inflate.js` -> 200
    - validated stream host alignment against active ngrok host:
      - `02f3-2803-6000-e005-64e-cf54-a5f8-929e-fb27.ngrok-free.app`

- Evidence:
  - command output from `make local-fresh-e2e` (this run)
  - `Makefile`
  - `scripts/local-fresh-e2e.sh`
  - `scripts/local-reliability-preflight.sh`
  - `scripts/local-nats-port-forward.sh`
  - `scripts/local-slack-soft-bridge.sh`
