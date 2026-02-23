# Functional Overview

## Purpose

Browser HITL solves the problem of keeping browser sessions authenticated to web applications that require periodic human interaction — OTP codes, CAPTCHAs, security prompts, consent screens, and other challenges that defeat pure automation.

## Use Cases

1. **Persistent Session Authentication**: Maintain always-on authenticated browser sessions for web applications that rotate credentials or require periodic re-authentication.

2. **MFA/OTP Resolution**: When a login flow encounters MFA, the system pauses automation, sends the OTP request to a human operator via Slack or Teams, and injects the response.

3. **CAPTCHA Intervention**: For CAPTCHA challenges, operators take over via live browser stream (VNC or CDP), solve the challenge, and release control back to automation.

4. **Artifact Export**: Extract authentication artifacts (cookies, headers, CSRF tokens, storage) encrypted with AES-256-GCM and deliver via presigned URLs or NATS events.

5. **Multi-Tenant Isolation**: Multiple organizations share the platform with PostgreSQL RLS isolation, tenant-scoped NATS subjects, and per-tenant encryption keys.

6. **Agent Credential Access**: AI agents request credentials via OAuth 2.0 Client Credentials grant. Concurrent requests are coalesced (10 agents → 1 login). Responses include freshness metadata (CACHED/EXTRACTED) and per-field volatility.

7. **Dual-Mode Streaming**: Per-application choice between VNC (headed Chromium + Xvfb + noVNC sidecar) and CDP (headless Chromium + `Page.startScreencast` relay). CDP mode uses fewer resources (1 container, no X11 stack).

## Workflows

### Login / Session Establishment

1. Operator creates an application with login DSL configuration
2. Operator scales desired session count
3. Controller reconciles: creates Worker pods
4. Worker launches Chromium, executes login DSL
5. Health checks evaluate success (URL, DOM, network)
6. If healthy → HEALTHY state, artifacts exported
7. If login needed → escalates to HITL

### HITL Escalation and Resolution

1. Worker detects MFA/CAPTCHA/challenge
2. Session enters LOGIN_IN_PROGRESS, baton enters HUMAN_REQUESTED
3. NATS event published: `hitl.otp-requested.{tenantId}.{sessionId}`
4. Slack/Teams bot sends notification with action buttons
5. Operator clicks "Take Over" → `POST /sessions/:id/takeover`
6. Operator views browser stream (VNC or CDP), enters OTP → `POST /sessions/:id/otp`
7. Worker reads OTP from Redis (60s TTL), types into browser
8. Login succeeds → HEALTHY, baton → AUTOMATION_CONTROL
9. Intervention record completed with outcome (SUCCESS/FAIL/TIMEOUT)

### Artifact Extraction

1. After successful login, Worker extracts:
   - Cookies (document.cookie + Playwright cookies)
   - HTTP headers (via intercept, filtered by allowlist)
   - CSRF tokens (meta tags, form hidden fields)
   - localStorage / sessionStorage
2. Artifacts encrypted with AES-256-GCM (per-tenant key)
3. Uploaded to MinIO with metadata
4. NATS event: `auth.bundle.exported.{tenantId}.{appId}`
5. Consumers retrieve via presigned URL (time-limited)

### Session Recycling (FR-34)

1. Recycling monitor checks max session age (24h default) and memory watermark (2.5GB)
2. When threshold hit: extract final artifacts, terminate session
3. Controller reconciles: creates replacement Worker pod
4. New session inherits application configuration

### Lifecycle Retention

1. Scheduled cleanup runs periodically:
   - Artifacts: 7 days
   - Interventions: 30 days
   - Sessions: 14 days
   - Applications: 30 days (soft-deleted)
2. Audit events: 90 days (configurable)

## API Surface

### Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/login` | None | Email/password login → JWT |
| POST | `/auth/logout` | JWT | Revoke current token (Redis blacklist) |
| POST | `/auth/bootstrap` | None | Create initial tenant + admin (first run) |
| POST | `/auth/service-token` | None | Bot service auth (client_id + secret) |
| POST | `/auth/agent-token` | None | Agent OAuth 2.0 Client Credentials (HMAC-SHA256) |

### Tenants

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| GET | `/tenants` | JWT | Admin | List tenants |
| POST | `/tenants` | JWT | Admin | Create tenant |
| GET | `/tenants/:id` | JWT | Admin | Get tenant |
| PATCH | `/tenants/:id` | JWT | Admin | Update tenant |

### Users

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| GET | `/users` | JWT | Admin | List users |
| POST | `/users` | JWT | Admin | Create user (password complexity enforced) |
| GET | `/users/:id` | JWT | Admin | Get user |
| PATCH | `/users/:id` | JWT | Admin | Update user |
| DELETE | `/users/:id` | JWT | Admin | Delete user |

### Applications

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| GET | `/apps` | JWT | All | List applications |
| POST | `/apps` | JWT | Admin, Operator | Create app (DTO validated) |
| GET | `/apps/:id` | JWT | All | Get application |
| PATCH | `/apps/:id` | JWT | Admin, Operator | Update app (partial DTO) |
| DELETE | `/apps/:id` | JWT | Admin | Soft delete |

### Sessions

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| GET | `/sessions` | JWT | All | List sessions |
| POST | `/sessions/scale` | JWT | Admin, Operator | Scale desired sessions |

### HITL Operations

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| POST | `/sessions/:id/stream` | JWT | All | Get VNC stream URL (throttled: 3/min) |
| POST | `/sessions/:id/takeover` | JWT | Admin, Operator | Acquire baton (idempotent) |
| POST | `/sessions/:id/release` | JWT | Admin, Operator | Release baton (idempotent) |
| POST | `/sessions/:id/otp` | JWT | Admin, Operator | Submit OTP (idempotent) |
| POST | `/sessions/:id/acknowledge` | JWT | Admin, Operator | Acknowledge failure (idempotent) |

All mutation endpoints accept `Idempotency-Key` header for safe retries.

### Artifacts

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| GET | `/artifacts/:sessionId` | JWT | All | Get presigned download URL |

### System

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health/live` | None | Liveness probe (always 200) |
| GET | `/health/ready` | None | Readiness probe (DB check) |
| GET | `/metrics` | Bearer | Prometheus metrics (prom-client) |
| WS | `/events` | JWT | Real-time WebSocket events |

## Security Model

### Authentication

- **JWT tokens** with `jti` claim (UUID) for per-token revocation
- **Token revocation** via Redis blacklist (key: `jti`, TTL: remaining token lifetime)
- **bcrypt** cost factor 12 for password hashing
- **Password complexity**: 12+ characters, uppercase, lowercase, digit, special character
- **Account lockout**: 5 consecutive failures → 15-minute lock (auto-release)
- **Rate limiting**: Login 5/min per IP, global 60/min per user
- **Logout endpoint**: `POST /auth/logout` blacklists the current token

### Authorization (RBAC)

| Permission | Admin | Operator | Viewer | Agent |
|-----------|-------|----------|--------|-------|
| Manage tenants/users | Yes | No | No | No |
| Create/update apps | Yes | Yes | No | No |
| Scale sessions | Yes | Yes | No | No |
| HITL takeover/OTP/release | Yes | Yes | No | No |
| View stream | Yes | Yes | Yes | No |
| View sessions/apps | Yes | Yes | Yes | No |
| Request credentials | Yes | Yes | No | Yes |

### Data Protection

- **AES-256-GCM** encryption for all artifact bundles (per-tenant key)
- **Redis TTL** for ephemeral data: OTP (60s), stream tokens (600s), artifact tokens (600s)
- **Presigned URLs** for artifact download (time-limited, one-time access)
- **No sensitive data in NATS subjects** (only IDs)

### Network Security

- **Kubernetes NetworkPolicies**: API, Controller, PostgreSQL, Redis, NATS (toggled by `networkPolicies.enabled`)
- **NATS token authentication** (toggled by `nats.auth.enabled`)
- **TLS** via cert-manager (production: `tls.enabled: true`, `letsencrypt-prod` issuer)
- **Egress proxy** with FQDN allowlist for outbound browser traffic
- **Helmet** security headers (HSTS, X-Frame-Options, X-Content-Type-Options, etc.)
- **CORS** with configurable origin (`CORS_ORIGIN` env var)
- **Trust proxy** configurable (`TRUST_PROXY` env var, default: `loopback`)

### Audit Trail

- **Append-only** event log with actor tracking (system vs human)
- **SHA-256 hash chain**: each event includes hash of previous event
- **`pg_advisory_lock(42)`** for chain serialization (prevents race conditions)
- **Daily anchors** for periodic integrity verification
- **90-day retention** (configurable)

## Login DSL

15 supported actions for browser automation:

| Action | Description | Sensitive |
|--------|-------------|-----------|
| `goto` | Navigate to URL | No |
| `fill` | Fill form field | Yes (if credential) |
| `type` | Type text character by character | Yes (if credential) |
| `click` | Click element by selector | No |
| `select` | Select dropdown option | No |
| `wait_for` | Wait for selector to appear | No |
| `wait_for_url` | Wait for URL pattern match | No |
| `frame` | Switch to iframe by selector | No |
| `main_frame` | Switch back to main frame | No |
| `popup` | Handle popup window | No |
| `keyboard` | Send keyboard shortcut | No |
| `evaluate` | Execute JavaScript in page | No |
| `sleep` | Wait for duration | No |
| `screenshot` | Capture screenshot | No |
| `reload` | Reload page | No |

**Variable interpolation**: `${USERNAME}` and `${PASSWORD}` in fill/type values resolved from K8s Secret mounts.

## Health Check System

### Check Types

| Type | Config | Pass Criteria |
|------|--------|--------------|
| `url` | URL + expected status | HTTP response matches `expect_status` |
| `dom` | CSS selector + exists flag | Element presence matches `exists` boolean |
| `network` | URL + status + body | Status matches AND body contains string |

### Evaluation Policy

| Policy | Pass Condition |
|--------|---------------|
| `all` | Every check passes |
| `any` | At least one check passes |
| `quorum` | At least `quorum_n` checks pass |

### Result Classification

| Result | Meaning | Action |
|--------|---------|--------|
| `PASS` | Check succeeded | Continue |
| `TRANSIENT_FAIL` | Temporary failure (network) | Retry with backoff |
| `AUTH_FAIL` | Authentication expired | Escalate to LOGIN_NEEDED |
