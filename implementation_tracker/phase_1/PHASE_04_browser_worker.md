# Phase 4: Browser Worker

**Status**: COMPLETE
**Tasks**: 29-39

## Tasks Completed

### Task 29: Worker Container Build ✅
- `infra/docker/Dockerfile.worker` - Playwright base image + Xvfb + x11vnc
- `infra/docker/worker-entrypoint.sh` - Startup sequence per spec section 15.5
- `infra/docker/Dockerfile.api` - API image
- `infra/docker/Dockerfile.novnc` - noVNC sidecar

### Task 30: Login DSL Runner ✅
- `apps/worker/src/login-dsl-runner.ts`
- All 15 DSL actions, credential interpolation, frame/popup context, retries

### Task 31: OTP Relay Polling ✅
- `apps/worker/src/otp-relay.ts`
- Polls Redis otp:{session_id} at 1s, reads + deletes immediately

### Task 32: Keepalive Runner ✅
- `apps/worker/src/keepalive-runner.ts`
- Interval-based: actions → 2s pause → health → write → re-extract if stale

### Task 33: Health Predicate Evaluation ✅
- `apps/worker/src/health-predicate-runner.ts`
- url_check, dom_check, network_check with PASS/TRANSIENT_FAIL/AUTH_FAIL

### Task 34: Artifact Extraction Pipeline ✅
- `apps/worker/src/artifact-extractor.ts`
- Extracts cookies, headers, csrf_token, localStorage, sessionStorage

### Task 35: Artifact Encryption ✅
- AES-256-GCM with 12-byte random nonce
- Blob format: [nonce][ciphertext][auth tag]

### Task 36: MinIO Upload + NATS Publish ✅
- Uploads to MinIO at {app_id}/{session_id}/{timestamp}.enc
- Publishes to auth.bundle.exported.{tenant_id}.{app_id}

### Task 37: Worker Health HTTP Server ✅
- `apps/worker/src/health-server.ts`
- GET /health and GET /status on port 8091

### Task 38: Session Recycling Trigger ✅
- `apps/worker/src/recycling-monitor.ts`
- Monitors memory watermark (2.5GB) and session age
- Signals controller via RECYCLE_REQUESTED health result

### Task 39: Screenshot Fallback Mode ✅
- `apps/worker/src/screenshot-fallback.ts`
- Activates when VNC FPS < 1 for >30s, captures every 2s

## Key Decisions / Fixes
- Added "DOM" lib to worker tsconfig.json for page.evaluate callbacks (document, window, etc.)
- Changed currentFrame type to `Page | Frame | FrameLocator` to handle iframe context
- Added @types/pg for PostgreSQL types
