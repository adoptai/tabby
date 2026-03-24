# Tabby-ABCD Integration Guide

Complete guide to integrating with Tabby's credential management platform. Two audiences: **agent developers** who consume credentials, and **platform engineers** who set up applications and profiles.

---

## Table of Contents

- [Section 1: The Setup (For Platform Engineers)](#section-1-the-setup-for-platform-engineers)
  - [Step 1: Authenticate](#step-1-authenticate)
  - [Step 2: Create a Tenant](#step-2-create-a-tenant)
  - [Step 3: Register an Agent Client](#step-3-register-an-agent-client)
  - [Step 4: Create the App](#step-4-create-the-app)
  - [Step 5: Create K8s Secret (if using `k8s:secret/`)](#step-5-create-k8s-secret-if-using-k8ssecret)
  - [Step 6: Wait for HEALTHY](#step-6-wait-for-healthy)
  - [Step 7: HITL — Log In via VNC](#step-7-hitl--log-in-via-vnc)
  - [Step 8: Create Profile](#step-8-create-profile)
  - [Step 9: Promote Profile](#step-9-promote-profile)
  - [Step 10: Request Credentials](#step-10-request-credentials)
  - [Step 11: Force Refresh](#step-11-force-refresh)
- [Section 2: Quick Start (For Agent Developers)](#section-2-quick-start-for-agent-developers)
  - [Step 1: Get an Agent JWT](#step-1-get-an-agent-jwt)
  - [Step 2: Request Credentials](#step-2-request-credentials)
  - [Step 3: Use Cookies in API Calls](#step-3-use-cookies-in-api-calls)
  - [Step 4: Refresh Before Expiry](#step-4-refresh-before-expiry)
- [Section 3: Working Examples](#section-3-working-examples)
  - [Example 1: HubSpot Manual HITL](#example-1-hubspot-manual-hitl)
  - [Example 2: Salesforce Human-Assisted (with Multi-Page Extraction)](#example-2-salesforce-human-assisted-with-multi-page-extraction)
  - [Example 3: Workday Human-Assisted](#example-3-workday-human-assisted)
- [Section 4: Credential Volatility Guide](#section-4-credential-volatility-guide)
- [Section 5: Refresh Intervals Explained](#section-5-refresh-intervals-explained)
- [Section 6: force_refresh Deep Dive](#section-6-force_refresh-deep-dive)
- [Section 7: Troubleshooting](#section-7-troubleshooting)
  - [1. Credentials return empty values](#1-credentials-return-empty-values)
  - [2. custom_extractions return empty strings](#2-custom_extractions-return-empty-strings)
  - [3. Session goes UNHEALTHY after login succeeds](#3-session-goes-unhealthy-after-login-succeeds)
  - [4. `screenshot` keepalive does not prevent session timeout](#4-screenshot-keepalive-does-not-prevent-session-timeout)
  - [5. Salesforce `aura_token` is stale](#5-salesforce-aura_token-is-stale)
  - [6. VF tokens all empty (Salesforce)](#6-vf-tokens-all-empty-salesforce)
  - [7. Profile credential_types.custom key mismatch](#7-profile-credential_typescustom-key-mismatch)
  - [8. force_refresh returns stale credentials despite wait_seconds](#8-force_refresh-returns-stale-credentials-despite-wait_seconds)
  - [9. Session stuck in LOGIN_IN_PROGRESS](#9-session-stuck-in-login_in_progress)
  - [10. Workday session times out in < 5 minutes](#10-workday-session-times-out-in--5-minutes)
  - [11. Multiple domains: cookies missing for some domains](#11-multiple-domains-cookies-missing-for-some-domains)
  - [12. `streaming_mode` in browser_policy causes validation error](#12-streaming_mode-in-browser_policy-causes-validation-error)
  - [13. Canary profile not serving credentials](#13-canary-profile-not-serving-credentials)
  - [14. refresh_interval_seconds defaults to 3600](#14-refresh_interval_seconds-defaults-to-3600)
- [Section 8: API Quick Reference](#section-8-api-quick-reference)

---

## Section 1: The Setup (For Platform Engineers)

### Step 1: Authenticate

Get a JWT for admin API calls:

```bash
TOKEN=$(curl -s -X POST http://localhost:${API_PORT:-18080}/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@browser-hitl.local","password":"LocalDev123!@#"}' \
  | jq -r '.token')
```

### Step 2: Create a Tenant

Every app, profile, and agent client belongs to a tenant. Create one first:

```bash
curl -s -X POST http://localhost:${API_PORT:-18080}/admin/tenants \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Company"
  }' | jq .
```

Save the `id` from the response — it is the `tenant_id` used in all subsequent steps.

### Step 3: Register an Agent Client

Register an agent client scoped to the profiles the FDE will consume. **You can do this before the profiles exist** — `allowed_profiles` is just a string array stored for later validation at token issue time.

```bash
curl -s -X POST http://localhost:${API_PORT:-18080}/admin/agent-clients \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "abcd-hubspot-agent",
    "tenant_id": "<tenant-id-from-step-2>",
    "allowed_profiles": ["hubspot-production"]
  }' | jq .
```

The response includes `client_id` and `client_secret`. **The secret is only returned once — store it securely.** Give these to the FDE — they are the credentials for `POST /auth/agent-token`.

> **Prerequisite:** The API pod must have `AGENT_SECRET_HMAC_KEY` set (min 32 chars). Generate one with `openssl rand -hex 32` and add it to your deployment secrets.

### Step 4: Create the App

Pass `tenant_id` in the body to create the app under the FDE's tenant (not the Admin's). This is required for agents to find it.

```bash
curl -s -X POST http://localhost:${API_PORT:-18080}/apps \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '<payload with "tenant_id": "<tenant-id-from-step-2>">' | jq .
```

The app payload is the most complex part. Every field explained:

#### `target_urls` (string[])

All domains where the browser session operates. Include every domain that serves cookies or content you need.

**Workday example:** Workday uses separate domains for identity (`wd5-impl-identity.workday.com`) and the main app (`wd5-impl.workday.com`). Both must be listed so the egress proxy allowlists them.

**Salesforce example:** Lightning (`*.lightning.force.com`), Classic (`*.my.salesforce.com`), and VisualForce (`*.vf.force.com`) are all separate domains. List all three.

#### `login_config.credential_ref` (string)

Two patterns:

- **`k8s:secret/{name}`** — Worker reads `username` and `password` keys from a Kubernetes Secret. The DSL can reference them as `${USERNAME}` and `${PASSWORD}`.
- **`manual:`** — No stored credentials. The human provides everything via VNC during HITL. Use this when credentials cannot be stored in K8s (e.g., SSO, hardware tokens, password managers). The worker skips credential injection entirely.

#### `login_config.steps` (DSLStep[])

The login automation script. Two patterns:

**Pattern A: Manual HITL (recommended for most sites)**

The worker navigates to the login page, then hands off to a human via VNC. Simplest and most reliable.

```json
[
  {"action": "goto", "url": "https://example.com/login"},
  {"action": "wait_for", "selector": "input#username", "timeout_ms": 30000},
  {"action": "request_human_input", "input_type": "confirm", "label": "Log in via VNC, then click Mark as Resolved", "timeout_ms": 300000},
  {"action": "screenshot"}
]
```

The `wait_for` step confirms the login page loaded before requesting human input. The `confirm` input type means the human does everything in VNC and just clicks "Mark as Resolved" in Slack when done. The 300000ms (5 minute) timeout gives ample time.

**Pattern B: Automated with human fallback**

The worker fills credentials and clicks through, requesting human help only for OTP/MFA:

```json
[
  {"action": "goto", "url": "https://example.com/login"},
  {"action": "fill", "selector": "input#username", "value": "${USERNAME}"},
  {"action": "fill", "selector": "input#password", "value": "${PASSWORD}", "sensitive": true},
  {"action": "click", "selector": "button[type=submit]"},
  {"action": "request_human_input", "input_type": "otp", "label": "Enter the OTP code", "timeout_ms": 120000},
  {"action": "screenshot"}
]
```

Use `"sensitive": true` on the password fill step to mask it in logs.

**Advanced: `on_failure` handlers**

Any `wait_for`, `click`, `fill`, `goto` step can have an `on_failure` block:

```json
{
  "action": "wait_for",
  "selector": "#otp-field",
  "timeout_ms": 15000,
  "on_failure": {"action": "skip"}
}
```

Options:
- `{"action": "skip"}` — skip the failed step, continue DSL
- `{"action": "abort"}` — fail immediately
- `{"action": "request_help", "message": "Unexpected page", "input_type": "url", "screenshot": true}` — take screenshot, ask human for help

**Advanced: `evaluate` and `store_as`**

Run JavaScript in the browser and store the result for use in later steps (e.g., extracting a record ID from the URL):

```json
{
  "action": "evaluate",
  "expression": "(function(){ var m = window.location.href.match(/Record\\/([a-zA-Z0-9]+)/); return m ? m[1] : ''; })()",
  "store_as": "record_id"
}
```

The stored value can be used in `extract_urls` templates as `{{record_id}}`.

#### `keepalive_config`

Keeps the browser session alive between credential extractions.

```json
{
  "interval_seconds": 120,
  "actions": [{"action": "goto", "url": "https://example.com/home"}],
  "health_checks": [{"type": "url_check", "url": "https://example.com/home", "expect_status": 200, "timeout_ms": 20000}]
}
```

**Critical: `screenshot` does NOT keep sessions alive.** A screenshot action only captures the current page state. It does NOT make HTTP requests to the target site, so server-side session timers keep ticking down. Always use `goto` (navigates to a URL, triggering a real HTTP request) or `evaluate` with a `fetch()` call.

**`health_checks`:**

- `url_check` — Makes an HTTP request to the URL and checks the status code. Preferred for SPAs (Salesforce Lightning, Workday) because `dom_check` on `body` can return `isVisible()=false` even when logged in.
- `dom_check` — Checks if a CSS selector exists/is visible on the current page. Works for traditional server-rendered apps.

Health check options:
- `timeout_ms` — How long to wait (default 15000ms)
- `auth_redirect_pattern` — Glob pattern for auth redirect URLs. If the browser is redirected to a URL matching this pattern during health check, the session is considered unhealthy (logged out). Example: `"**/login*"`.

#### `export_policy`

Controls what the worker extracts from the browser and how often.

```json
{
  "artifact_types": ["cookies", "headers", "local_storage", "session_storage"],
  "encryption": {"algo": "AES-256-GCM"},
  "ttl_seconds": 3600,
  "refresh_interval_seconds": 120,
  "header_allowlist": ["authorization", "x-csrf-token"],
  "custom_extractions": [...],
  "extract_urls": {...}
}
```

**`artifact_types`** — What to capture. Options: `cookies`, `headers`, `local_storage`, `session_storage`.

**`refresh_interval_seconds`** — How often the worker re-extracts credentials (default 3600 = 1 hour). Set this to match or be slightly less than `keepalive_config.interval_seconds` for volatile credentials. For Salesforce tokens that rotate frequently, 120 seconds works well.

**`header_allowlist`** — Which response headers to capture. Only headers in this list are stored. Common ones: `authorization`, `x-csrf-token`, `x-sfdc-request-id`.

**`custom_extractions`** — Array of site-specific extractions:

```json
[
  {"key": "access_token", "type": "cookie", "cookie_name": "sid"},
  {"key": "aura_token", "type": "js_eval", "expression": "localStorage.getItem('$AuraClientService.token$one:one') || ''"},
  {"key": "vf_vid", "type": "js_eval", "expression": "...", "extract_on_url": "*/apex/sb*"}
]
```

Types:
- `cookie` — Named cookie lookup. Requires `cookie_name`.
- `js_eval` — Runs `page.evaluate(expression)` in the browser. The expression must return a string.

Both support `extract_on_url` — a glob pattern. The extraction only runs when the browser is on a matching URL. Essential for VisualForce tokens that only exist on VF pages.

**`extract_urls`** — Navigate to specific pages before extracting. Used when tokens only exist on certain pages (e.g., Salesforce VisualForce):

```json
{
  "extract_urls": {
    "*/apex/sb*": "https://example.com/apex/sb?id={{quote_id}}"
  }
}
```

The key is a glob pattern that matches the `extract_on_url` filter. The value is the URL to navigate to, with `{{variable}}` placeholders resolved from `store_as` values. Before running extractions with `extract_on_url: "*/apex/sb*"`, the worker navigates to the corresponding URL.

**Note:** `extract_urls` requires `browser_policy.allow_evaluate: true` if the URL template uses `store_as` variables.

#### `browser_policy`

```json
{
  "downloads": false,
  "clipboard": false,
  "file_chooser": false,
  "allow_evaluate": true
}
```

- `downloads` — Allow file downloads in the browser
- `clipboard` — Allow clipboard access
- `file_chooser` — Allow file upload dialogs
- `allow_evaluate` — Allow `page.evaluate()` calls. Required for `evaluate` DSL steps and `js_eval` custom extractions. Set to `true` for Salesforce and other sites needing custom token extraction.

**Note:** `streaming_mode` is not a valid field in `browser_policy`. VNC streaming is always enabled for HITL sessions. Do not include it.

#### `desired_session_count`

Number of concurrent browser sessions. Usually 1. Set higher for load balancing across multiple workers.

#### `notification_config`

```json
{
  "channels": ["slack:#tabby-experiments"]
}
```

Slack channel for HITL notifications. The channel must exist and the Slack bot must be invited to it.

### Step 5: Create K8s Secret (if using `k8s:secret/`)

Skip this step if using `manual:` credential_ref.

```bash
kubectl create secret generic hubspot-creds \
  -n browser-hitl \
  --from-literal=username='user@example.com' \
  --from-literal=password='your-password-here'
```

The secret name must match the `credential_ref` value (e.g., `k8s:secret/hubspot-creds` reads from secret `hubspot-creds`).

### Step 6: Wait for HEALTHY

After creating the app, a session is created and a worker pod starts. Poll until healthy:

```bash
curl -s http://localhost:${API_PORT:-18080}/sessions \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {id, state, health_result_type}'
```

States:
- `STARTING` — Worker pod is launching
- `LOGIN_IN_PROGRESS` — Worker is executing DSL steps
- `LOGIN_NEEDED` — Waiting for human input (HITL)
- `HEALTHY` — Login succeeded, credentials being extracted
- `UNHEALTHY` — Health check failing, may need re-login

### Step 7: HITL — Log In via VNC

When the session reaches `LOGIN_NEEDED`:

1. Get the VNC stream URL:

```bash
SESSION_ID="<session-id>"
curl -s -X POST http://localhost:${API_PORT:-18080}/sessions/$SESSION_ID/stream \
  -H "Authorization: Bearer $TOKEN" | jq -r '.url'
```

2. Open the URL in a browser. You see the remote Chromium desktop.
3. Log in manually — type credentials, complete MFA, handle CAPTCHAs.
4. In Slack, click **"Mark as Resolved"** (or send `RESOLVE <session_id>` via soft bridge).

The worker detects the resolution, runs health checks, and transitions to HEALTHY.

For OTP-type inputs, the Slack modal shows a text field. Type the code and submit. The worker fills it into the browser automatically.

### Step 8: Create Profile

A profile defines what credentials to serve to consumers and their volatility characteristics. Pass `tenant_id` to place it under the FDE's tenant — must match the tenant used for the app.

```bash
curl -s -X POST http://localhost:${API_PORT:-18080}/admin/profiles \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "profile_id": "hubspot-production",
    "version": "1.0.0",
    "app_id": "<app-id-from-step-2>",
    "tenant_id": "<tenant-id-from-step-2>",
    "target_domains": ["app-na2.hubspot.com"],
    "credential_types": {
      "cookies": [
        {"name": "hubspotutk", "domain": ".hubspot.com", "path": "/", "secure": true, "httpOnly": true, "volatility": "STABLE"}
      ],
      "headers": [
        {"name": "authorization", "volatility": "VOLATILE"},
        {"name": "x-csrf-token", "volatility": "VOLATILE"}
      ],
      "csrf": null,
      "custom": [
        {"key": "access_token", "volatility": "SEMI_STABLE"}
      ]
    },
    "login_config": {},
    "extra_config": {
      "ttl_seconds": 3600,
      "refresh_before_seconds": 1800
    }
  }' | jq .
```

**`credential_types`:**

- **`cookies`** — Array of cookie definitions. The `name` field must **exactly match** a cookie name from the browser. Cookies not listed here are not served to consumers.
- **`headers`** — Array of header definitions. The `name` must match a header from `header_allowlist` in the app's export_policy.
- **`csrf`** — CSRF token config. Set to `null` if not needed.
- **`custom`** — Array of custom extraction keys. The `key` must **exactly match** a `key` from `custom_extractions` in the app's export_policy. Only matching keys are served.

**Volatility levels:**

- **`STABLE`** — Rarely changes (e.g., browser fingerprint cookies, device IDs). Can be cached longer.
- **`SEMI_STABLE`** — Changes on re-login but stable within a session (e.g., session cookies, access tokens). Refresh on session rotation.
- **`VOLATILE`** — Changes frequently, sometimes per-request (e.g., CSRF tokens, Salesforce aura tokens). Refresh often.

**`extra_config`:**

- `ttl_seconds` — How long credentials are valid from extraction time. Consumers should discard credentials older than this.
- `refresh_before_seconds` — Consumers should request fresh credentials this many seconds before TTL expires. Example: with `ttl_seconds: 3600` and `refresh_before_seconds: 1800`, refresh after 30 minutes.

### Step 9: Promote Profile

Profiles follow a state machine: `STAGING -> CANARY -> ACTIVE -> RETIRED`.

> **Tenant note:** Admin can promote any profile by UUID regardless of tenant. No `tenant_id` needed on promote/rollback — the UUID is globally unique.

```bash
PROFILE_ID="hubspot-production"

# Promote STAGING -> CANARY
curl -s -X POST http://localhost:${API_PORT:-18080}/admin/profiles/$PROFILE_ID/promote \
  -H "Authorization: Bearer $TOKEN" | jq .
```

In CANARY state, the profile serves credentials but tracks `canary_request_count` and `canary_error_count`. After ~5 successful requests:

```bash
# Promote CANARY -> ACTIVE
curl -s -X POST http://localhost:${API_PORT:-18080}/admin/profiles/$PROFILE_ID/promote \
  -H "Authorization: Bearer $TOKEN" | jq .
```

The profile is now ACTIVE and will be the default for `POST /credentials/request`.

### Step 10: Request Credentials

```bash
curl -s -X POST http://localhost:${API_PORT:-18080}/credentials/request \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile_id": "hubspot-production"}' | jq .
```

Response includes `freshness`:
- `FRESH` — Extracted within the last refresh interval
- `CACHED` — From cache, still within TTL
- `STALE` — Older than TTL but nothing fresher available
- `CANARY` — Served from a canary profile

### Step 11: Force Refresh

When you know credentials are stale (e.g., target API returned 401):

```bash
# Fire-and-forget: tells worker to re-extract, returns immediately with current credentials
curl -s -X POST http://localhost:${API_PORT:-18080}/credentials/request \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "profile_id": "hubspot-production",
    "force_refresh": true
  }' | jq .

# Blocking: waits up to 15 seconds for fresh credentials
curl -s -X POST http://localhost:${API_PORT:-18080}/credentials/request \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "profile_id": "hubspot-production",
    "force_refresh": true,
    "wait_seconds": 15
  }' | jq .
```

With `wait_seconds`, the API uses Redis BLPOP to block until the worker publishes fresh credentials or the timeout expires. Set between 1-30 seconds.

---



## Section 2: Quick Start (For Agent Developers)

You need credentials (cookies, tokens, headers) for a target site. Before you can consume credentials, the following must be in place — coordinate with your platform engineer:

1. **Tenant created** — A tenant must exist in Tabby for your organization. The platform engineer creates this and gives you the `tenant_id`.
2. **App created** — The browser automation app (login DSL, keepalive, export policy) must be created and in `HEALTHY` state. The human login via VNC must have already happened.
3. **Profile created and promoted to ACTIVE** — **You (the FDE) create this yourself** using your tenant's admin token. The profile must live in your tenant — if the platform engineer creates it under their tenant, your agent client won't have access to it. The `profile_id` must match one of the `allowed_profiles` in your agent client.
4. **Agent client provisioned** — The platform engineer registers an agent client scoped to your profiles and gives you a `client_id` and `client_secret`. These are your credentials for getting an agent JWT.

Once all four are in place:

### Step 1: Get an Agent JWT

```bash
TOKEN=$(curl -s -X POST https://tabby-api.example.com/auth/agent-token \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "agent_cl_xxxx",
    "client_secret": "secret_sk_xxxx",
    "grant_type": "client_credentials"
  }' | jq -r '.access_token')

echo $TOKEN
```

The `client_id` and `client_secret` are provisioned by the platform engineer via `POST /admin/agent-clients`. They are **not** the `SERVICE_AUTH_CLIENT_ID/SECRET` env vars — those are for internal service bots. Your agent client credentials are scoped to specific profiles (`allowed_profiles`) and cannot access anything outside that scope.

The response field is `access_token` (OAuth 2.0 format). The returned JWT is used for all subsequent API calls.

### Step 2: Request Credentials

```bash
curl -s -X POST https://tabby-api.example.com/credentials/request \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "profile_id": "hubspot-production"
  }' | jq .
```

Response:

```json
{
  "freshness": "FRESH",
  "extracted_at": "2026-03-23T10:00:00.000Z",
  "credentials": {
    "cookies": [
      {"name": "hubspotutk", "value": "abc123...", "domain": ".hubspot.com", "path": "/", "secure": true, "httpOnly": true}
    ],
    "headers": {
      "authorization": "Bearer eyJ...",
      "x-csrf-token": "abc123"
    },
    "custom": {
      "access_token": "pat-na2-abc123..."
    }
  },
  "refresh_before_seconds": 1800,
  "ttl_seconds": 3600
}
```

### Step 3: Use Cookies in API Calls

Build a `Cookie` header from the returned cookies array:

```bash
# Extract cookies and format as Cookie header
COOKIES=$(echo $CREDS | jq -r '.credentials.cookies | map(.name + "=" + .value) | join("; ")')

curl -s https://app-na2.hubspot.com/api/v1/some-endpoint \
  -H "Cookie: $COOKIES" \
  -H "Authorization: $(echo $CREDS | jq -r '.credentials.headers.authorization')"
```

### Step 4: Refresh Before Expiry

The response includes `extracted_at`, `ttl_seconds`, and `refresh_before_seconds`. Your agent should re-request credentials when:

```
current_time > extracted_at + (ttl_seconds - refresh_before_seconds)
```

Example: if `ttl_seconds` is 3600 and `refresh_before_seconds` is 1800, refresh after 30 minutes.

For urgent refresh (e.g., credentials rejected by target site):

```bash
curl -s -X POST https://tabby-api.example.com/credentials/request \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "profile_id": "hubspot-production",
    "force_refresh": true,
    "wait_seconds": 15
  }' | jq .
```

This tells the worker to re-extract immediately and blocks up to 15 seconds for fresh credentials.

---

## Section 3: Working Examples

### Example 1: HubSpot Manual HITL

The simplest setup. Human logs in entirely via VNC.

**App payload:**

```json
{
  "name": "HubSpot Manual Login",
  "target_urls": ["https://app-na2.hubspot.com"],
  "login_config": {
    "login_url": "https://app-na2.hubspot.com/login",
    "credential_ref": "k8s:secret/hubspot-creds",
    "steps": [
      {"action": "goto", "url": "https://app-na2.hubspot.com/login"},
      {"action": "wait_for", "selector": "[data-test-id=\"email-input-field\"]", "timeout_ms": 30000},
      {"action": "request_human_input", "input_type": "confirm", "label": "Log into HubSpot via VNC stream, then click Mark as Resolved", "timeout_ms": 300000},
      {"action": "screenshot"}
    ]
  },
  "keepalive_config": {
    "interval_seconds": 600,
    "actions": [{"action": "goto", "url": "https://app-na2.hubspot.com/"}],
    "health_checks": [{"type": "url_check", "url": "https://app-na2.hubspot.com/", "expect_status": 200, "timeout_ms": 15000, "auth_redirect_pattern": ".*/login"}]
  },
  "export_policy": {
    "artifact_types": ["cookies", "headers", "local_storage"],
    "encryption": {"algo": "AES-256-GCM"},
    "ttl_seconds": 3600,
    "refresh_interval_seconds": 120,
    "header_allowlist": ["authorization", "x-csrf-token"]
  },
  "notification_config": {"channels": ["slack:#tabby-experiments"]},
  "browser_policy": {"downloads": false, "clipboard": false, "file_chooser": false},
  "desired_session_count": 1
}
```

**K8s secret:**

```bash
kubectl create secret generic hubspot-creds \
  -n browser-hitl \
  --from-literal=username='user@example.com' \
  --from-literal=password='your-password-here'
```

**Profile:**

```json
{
  "profile_id": "hubspot-production",
  "version": "1.0.0",
  "app_id": "<hubspot-app-id>",
  "target_domains": ["app-na2.hubspot.com"],
  "credential_types": {
    "cookies": [
      {"name": "hubspotutk", "domain": ".hubspot.com", "path": "/", "secure": true, "httpOnly": true, "volatility": "STABLE"}
    ],
    "headers": [
      {"name": "authorization", "volatility": "VOLATILE"},
      {"name": "x-csrf-token", "volatility": "VOLATILE"}
    ],
    "csrf": null
  },
  "login_config": {},
  "extra_config": {"ttl_seconds": 3600, "refresh_before_seconds": 1800}
}
```

---

### Example 2: Salesforce Human-Assisted (with Multi-Page Extraction)

Complex setup with automated credential fill, human confirmation, multi-domain extraction, and VisualForce token scraping.

**App payload:**

```json
{
  "name": "Salesforce QAS Sandbox Human-Assisted",
  "target_urls": ["https://aainc--qas.sandbox.my.salesforce.com", "https://aainc--qas.sandbox.lightning.force.com", "https://aainc--qas--sbqq.sandbox.vf.force.com"],
  "login_config": {
    "login_url": "https://test.salesforce.com/",
    "credential_ref": "k8s:secret/salesforce-qas-creds",
    "steps": [
      {"action": "goto", "url": "https://test.salesforce.com/"},
      {"action": "fill", "selector": "input#username", "value": "${USERNAME}"},
      {"action": "fill", "selector": "input#password", "value": "${PASSWORD}", "sensitive": true},
      {"action": "request_human_input", "input_type": "confirm", "label": "Log into Salesforce via VNC stream, then click Mark as Resolved", "timeout_ms": 300000},
      {"action": "screenshot"},
      {"action": "request_human_input", "input_type": "confirm", "label": "Navigate to any Quote page in VNC (URL must contain SBQQ__Quote__c), then click Mark as Resolved", "timeout_ms": 300000},
      {"action": "evaluate", "expression": "(function(){ var m = window.location.href.match(/SBQQ__Quote__c\\/([a-zA-Z0-9]{15,18})/); return m ? m[1] : ''; })()", "store_as": "quote_id"}
    ]
  },
  "keepalive_config": {
    "interval_seconds": 120,
    "actions": [{"action": "evaluate", "expression": "fetch('/lightning/page/home', {credentials: 'include'}).then(r => r.status)"}],
    "health_checks": [{"type": "url_check", "url": "https://aainc--qas.sandbox.lightning.force.com/lightning/page/home", "expect_status": 200, "timeout_ms": 20000}]
  },
  "export_policy": {
    "artifact_types": ["cookies", "headers", "local_storage", "session_storage"],
    "encryption": {"algo": "AES-256-GCM"},
    "ttl_seconds": 3600,
    "refresh_interval_seconds": 120,
    "header_allowlist": ["authorization", "x-csrf-token", "x-sfdc-request-id"],
    "extract_urls": {"*/apex/sb*": "https://aainc--qas--sbqq.sandbox.vf.force.com/apex/sb?id={{quote_id}}"},
    "custom_extractions": [
      {"key": "access_token", "type": "cookie", "cookie_name": "sid"},
      {"key": "aura_token", "type": "js_eval", "expression": "localStorage.getItem('$AuraClientService.token$one:one') || ''"},
      {"key": "aura_context", "type": "js_eval", "expression": "(function(){ var html = document.documentElement.outerHTML; var fwuid = (html.match(/[\"']fwuid[\"']\\s*:\\s*[\"']([A-Za-z0-9_\\-+=/]+)[\"']/) || [])[1] || ''; var appM = (html.match(/[\"']app[\"']\\s*:\\s*[\"']([^\"']+)[\"']/) || [])[1] || 'one:one'; try { return JSON.stringify({mode:'PROD',fwuid:fwuid,app:appM}); } catch(e) { return ''; } })()"},
      {"key": "vf_vid", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { return JSON.parse(m[1]).vf.vid; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_csrf_load", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='load'}).csrf; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_auth_load", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='load'}).authorization; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_csrf_save", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='save'}).csrf; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_auth_save", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='save'}).authorization; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_csrf_read", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='read'}).csrf; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_auth_read", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='read'}).authorization; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_csrf_search", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; var s = ms.find(function(x){return x.name==='search'}); return s ? s.csrf : ''; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_auth_search", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; var s = ms.find(function(x){return x.name==='search'}); return s ? s.authorization : ''; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"}
    ]
  },
  "notification_config": {"channels": ["slack:#tabby-experiments"]},
  "browser_policy": {"downloads": false, "clipboard": false, "file_chooser": false, "allow_evaluate": true},
  "desired_session_count": 1
}
```

**K8s secret:**

```bash
kubectl create secret generic salesforce-qas-creds \
  -n browser-hitl \
  --from-literal=username='user@example.com.qas' \
  --from-literal=password='your-password-here'
```

**Profile:**

```json
{
  "profile_id": "salesforce-moraski",
  "version": "1.0.0",
  "app_id": "<salesforce-app-id>",
  "target_domains": ["aainc--qas.sandbox.my.salesforce.com", "aainc--qas.sandbox.lightning.force.com", "aainc--qas--sbqq.sandbox.vf.force.com"],
  "credential_types": {
    "cookies": [
      {"name": "sid", "domain": ".salesforce.com", "path": "/", "secure": true, "httpOnly": true, "volatility": "SEMI_STABLE"},
      {"name": "oid", "domain": ".salesforce.com", "path": "/", "secure": true, "httpOnly": false, "volatility": "STABLE"}
    ],
    "headers": [
      {"name": "authorization", "volatility": "VOLATILE"},
      {"name": "x-csrf-token", "volatility": "VOLATILE"},
      {"name": "x-sfdc-request-id", "volatility": "VOLATILE"}
    ],
    "csrf": null,
    "custom": [
      {"key": "access_token", "volatility": "SEMI_STABLE"},
      {"key": "aura_token", "volatility": "VOLATILE"},
      {"key": "aura_context", "volatility": "SEMI_STABLE"},
      {"key": "vf_vid", "volatility": "SEMI_STABLE"},
      {"key": "vf_csrf_load", "volatility": "VOLATILE"},
      {"key": "vf_auth_load", "volatility": "VOLATILE"},
      {"key": "vf_csrf_save", "volatility": "VOLATILE"},
      {"key": "vf_auth_save", "volatility": "VOLATILE"},
      {"key": "vf_csrf_read", "volatility": "VOLATILE"},
      {"key": "vf_auth_read", "volatility": "VOLATILE"},
      {"key": "vf_csrf_search", "volatility": "VOLATILE"},
      {"key": "vf_auth_search", "volatility": "VOLATILE"}
    ]
  },
  "login_config": {},
  "extra_config": {"ttl_seconds": 3600, "refresh_before_seconds": 1800}
}
```

**Why this is complex:**

1. Three domains — Lightning, Classic, and VisualForce each have separate cookies and tokens.
2. `store_as: "quote_id"` — The DSL extracts a Salesforce record ID from the URL during login. This is used later by `extract_urls` to navigate to the correct VF page.
3. `extract_urls` — Before running VF extractions, the worker navigates to `https://...vf.force.com/apex/sb?id={{quote_id}}`.
4. `extract_on_url: "*/apex/sb*"` — VF tokens (vid, csrf, auth for each CRUD operation) only exist on VF pages. Without this filter, the extractions would run on the Lightning page and return empty strings.
5. `allow_evaluate: true` — Required because the keepalive uses `evaluate` with `fetch()` and the login uses `evaluate` with `store_as`.

---

### Example 3: Workday Human-Assisted

Workday with `manual:` credential ref (no stored credentials, human does everything via VNC).

**App payload:**

```json
{
  "name": "Workday Human-assisted",
  "target_urls": ["https://wd5-impl-identity.workday.com/wday/authgwy/automationanywhere3/upc/", "https://wd5-impl.workday.com/"],
  "login_config": {
    "login_url": "https://wd5-impl-identity.workday.com/wday/authgwy/automationanywhere3/upc/login",
    "credential_ref": "manual:",
    "steps": [
      {"url": "https://wd5-impl-identity.workday.com/wday/authgwy/automationanywhere3/upc/login", "action": "goto"},
      {"action": "click", "selector": "[data-testid=\"username\"]", "timeout_ms": 30000},
      {"action": "request_human_input", "input_type": "confirm", "label": "Log into Workday via VNC stream, then click Mark as Resolved", "timeout_ms": 300000},
      {"action": "screenshot"}
    ]
  },
  "keepalive_config": {
    "interval_seconds": 120,
    "actions": [{"action": "goto", "url": "https://wd5-impl.workday.com/automationanywhere3/d/home.htmld"}],
    "health_checks": [{"type": "url_check", "url": "https://wd5-impl.workday.com/automationanywhere3/d/home.htmld", "expect_status": 200, "timeout_ms": 20000}]
  },
  "export_policy": {
    "artifact_types": ["cookies", "headers", "local_storage", "session_storage"],
    "encryption": {"algo": "AES-256-GCM", "key_ref": "k8s:secret/tenant-key"},
    "ttl_seconds": 3600,
    "header_allowlist": ["authorization", "x-csrf-token"],
    "refresh_interval_seconds": 120
  },
  "notification_config": {"channels": ["slack:#tabby-experiments"]},
  "browser_policy": {"downloads": false, "clipboard": false, "file_chooser": false},
  "desired_session_count": 1
}
```

**No K8s secret needed** — `manual:` credential ref means the human provides credentials via VNC.

**Profile:**

```json
{
  "profile_id": "workday-moraski",
  "version": "1.0.0",
  "app_id": "<workday-app-id>",
  "target_domains": ["wd5-impl.workday.com"],
  "credential_types": {
    "cookies": [
      {"name": "wd-alt-sessionid", "domain": ".wd5-impl.workday.com", "path": "/", "secure": true, "httpOnly": true, "volatility": "SEMI_STABLE"},
      {"name": "wd-browser-id", "domain": ".wd5-impl.workday.com", "path": "/", "secure": true, "httpOnly": true, "volatility": "STABLE"},
      {"name": "WorkdayLB_PEX_GQL", "domain": "wd5-impl.workday.com", "path": "/", "secure": true, "httpOnly": true, "volatility": "VOLATILE"},
      {"name": "WorkdayLB_SAS", "domain": "wd5-impl.workday.com", "path": "/", "secure": true, "httpOnly": true, "volatility": "VOLATILE"},
      {"name": "WorkdayLB_UI", "domain": "wd5-impl.workday.com", "path": "/", "secure": true, "httpOnly": true, "volatility": "VOLATILE"},
      {"name": "WorkdayLB_UI_Apache", "domain": "wd5-impl.workday.com", "path": "/", "secure": true, "httpOnly": true, "volatility": "VOLATILE"},
      {"name": "WorkdayLB_UIAUTHGWY", "domain": "wd5-impl.workday.com", "path": "/", "secure": true, "httpOnly": true, "volatility": "VOLATILE"}
    ],
    "headers": [],
    "csrf": null
  },
  "login_config": {},
  "extra_config": {"ttl_seconds": 3600, "refresh_before_seconds": 1800}
}
```

**Why `manual:` credential ref:**

Workday uses SSO with hardware tokens or organization-managed identity providers. Storing credentials in a K8s secret is either impossible (hardware token) or a security policy violation. The `manual:` ref tells the worker to skip credential injection entirely. The DSL navigates to the login page, clicks the username field to focus it, then hands off to the human. The `click` step with `timeout_ms: 30000` also serves as a page-load check.

**Why two `target_urls`:**

Workday authentication happens on `wd5-impl-identity.workday.com` but the actual application runs on `wd5-impl.workday.com`. The identity domain sets cookies that are then used by the main domain. Both must be in `target_urls` so the egress proxy allows traffic to both.

**Why `goto` for keepalive:**

The keepalive action navigates to the Workday home page. This makes a real HTTP request that resets the server-side session timer. Using `screenshot` instead would only capture the current state without making any request, and the session would time out.

---

## Section 4: Credential Volatility Guide

Volatility determines how aggressively consumers should refresh credentials and how the platform prioritizes extraction.

| Volatility | Description | Refresh Strategy | Examples |
|---|---|---|---|
| **STABLE** | Rarely changes. Survives re-login. May persist for days/weeks. | Cache aggressively. Refresh only on session rotation. | HubSpot `hubspotutk`, Salesforce `oid`, Workday `wd-browser-id` |
| **SEMI_STABLE** | Set at login, stable within a session. Changes on re-login. | Refresh when session rotates or credentials are rejected. | Salesforce `sid`, Workday `wd-alt-sessionid`, Salesforce `aura_context`, Salesforce `vf_vid` |
| **VOLATILE** | Changes frequently, sometimes per-request. Short-lived. | Always use the freshest available. Request with `force_refresh` if rejected. | Salesforce `aura_token`, all `vf_csrf_*` and `vf_auth_*` tokens, Workday `WorkdayLB_*` cookies, CSRF tokens, Authorization headers |

### Site-specific patterns

**HubSpot:**
- Cookies: mostly STABLE (tracking cookies persist across sessions)
- Headers: VOLATILE (authorization and CSRF rotate frequently)

**Salesforce:**
- `sid` cookie: SEMI_STABLE — session ID, stable until logout/timeout
- `oid` cookie: STABLE — org ID, never changes for a given org
- `aura_token`: VOLATILE — Salesforce rotates this aggressively
- `aura_context`: SEMI_STABLE — contains `fwuid` which changes on Salesforce releases but is stable day-to-day
- VF tokens (`vf_csrf_*`, `vf_auth_*`): VOLATILE — these are per-page CSRF/auth tokens that rotate on each page load
- `vf_vid`: SEMI_STABLE — VisualForce page version ID, stable within a deployment

**Workday:**
- `wd-browser-id`: STABLE — browser fingerprint, persists indefinitely
- `wd-alt-sessionid`: SEMI_STABLE — session cookie, stable until logout
- `WorkdayLB_*` cookies: VOLATILE — load balancer affinity cookies, rotate frequently

---

## Section 5: Refresh Intervals Explained

Four different time-based settings control credential freshness. They operate at different layers.

### Worker-side (app config)

**`export_policy.refresh_interval_seconds`** (default: 3600)

How often the worker re-extracts credentials from the browser. The worker runs on a timer: every `refresh_interval_seconds`, it captures cookies, runs `custom_extractions`, and stores the result.

Set this low (60-120s) for sites with volatile tokens (Salesforce). Set higher (600-3600s) for stable sites (simple cookie-based apps).

**`keepalive_config.interval_seconds`**

How often the worker performs keepalive actions (navigate, screenshot) and health checks. This prevents the target site from timing out the session.

Typical: 60-120s for aggressive session timeouts (Workday, Salesforce), 300-600s for relaxed timeouts (HubSpot).

**Relationship:** Set `refresh_interval_seconds <= interval_seconds`. Extracting credentials right after a keepalive ensures the freshest possible tokens. If `refresh_interval_seconds` is much larger than `interval_seconds`, you may serve stale tokens between extractions.

### Consumer-side (profile config)

**`extra_config.ttl_seconds`**

Maximum lifetime of credentials from extraction time. After this period, credentials should be considered expired. Returned in the `POST /credentials/request` response.

Typical: 3600 (1 hour). Match this to the target site's session timeout.

**`extra_config.refresh_before_seconds`**

How many seconds before TTL expiry the consumer should request fresh credentials. Returned in the `POST /credentials/request` response.

Formula: `refresh_at = extracted_at + (ttl_seconds - refresh_before_seconds)`

Example: `ttl_seconds: 3600`, `refresh_before_seconds: 1800` means refresh after 30 minutes.

### Putting it together

```
Worker extracts every 120s (refresh_interval_seconds)
Worker keepalive every 120s (interval_seconds)
Consumer uses credentials for up to 3600s (ttl_seconds)
Consumer refreshes at 1800s mark (refresh_before_seconds)
```

The consumer re-requests credentials every 30 minutes. Each request gets the latest extraction (at most 120 seconds old). The target site session stays alive via keepalive every 120 seconds.

---

## Section 6: force_refresh Deep Dive

`POST /credentials/request` supports `force_refresh` and `wait_seconds` for on-demand credential refresh.

### Without `wait_seconds` (fire-and-forget)

```json
{"profile_id": "my-profile", "force_refresh": true}
```

Behavior:
1. API publishes a refresh command to the worker via Redis.
2. API immediately returns the current (possibly stale) credentials.
3. Worker receives the command and starts re-extracting.
4. Next `POST /credentials/request` (without force_refresh) will get the fresh credentials.

Use case: You detected a 401 from the target API and want to trigger a refresh, but you can retry your request later.

### With `wait_seconds` (blocking)

```json
{"profile_id": "my-profile", "force_refresh": true, "wait_seconds": 15}
```

Behavior:
1. API publishes a refresh command to the worker via Redis.
2. API calls Redis `BLPOP` on a result key, blocking up to `wait_seconds`.
3. Worker re-extracts credentials and publishes the result to the same key.
4. API receives the fresh credentials and returns them to the caller.
5. If the worker does not respond within `wait_seconds`, API returns the current cached credentials.

Valid range: 1-30 seconds. Higher values increase the chance of getting fresh credentials but also increase API response time.

Use case: You need fresh credentials NOW and can tolerate a longer API call. Typical in retry loops after a 401.

### Freshness values

| Freshness | Meaning |
|---|---|
| `FRESH` | Credentials extracted within the last `refresh_interval_seconds` |
| `CACHED` | From cache, still within `ttl_seconds` |
| `STALE` | Older than `ttl_seconds`, nothing fresher available |
| `CANARY` | Served from a CANARY-state profile |
| `FORCE_REFRESHED` | Returned after a successful `force_refresh` + `wait_seconds` |

### Recommended pattern for agents

```
1. Request credentials (normal)
2. Make API call to target site
3. If 401/403:
   a. Request credentials with force_refresh: true, wait_seconds: 10
   b. Retry API call with new credentials
   c. If still 401/403, alert -- session may need re-login
```

---

## Section 7: Troubleshooting

### 1. Credentials return empty values

**Symptom:** `POST /credentials/request` returns an empty `credentials` object or individual fields are empty strings.

**Cause:** `TENANT_ENCRYPTION_KEY` is not set on the API pod. The worker encrypts credentials with AES-256-GCM using this key. The API decrypts them. If the API pod is missing the key, decryption fails silently and returns empty values.

**Fix:** Ensure `TENANT_ENCRYPTION_KEY` is set in `values-local.yaml` under `secrets.tenantEncryptionKey` (or via `--set secrets.tenantEncryptionKey=...`). Both the worker AND API pods must have the same key.

### 2. custom_extractions return empty strings

**Symptom:** `custom` fields in the credential response are all empty strings, but cookies and headers work fine.

**Causes:**
- `browser_policy.allow_evaluate` is not set to `true`. Required for `js_eval` extractions.
- `extract_on_url` filter does not match the current page. The worker only runs filtered extractions when the browser URL matches the glob. Check that `extract_urls` is configured to navigate to the correct page first.
- The JavaScript expression has a runtime error. Test it in the browser DevTools console first.

**Fix:** Set `allow_evaluate: true` in browser_policy. Verify `extract_urls` and `extract_on_url` patterns match. Test expressions in DevTools.

### 3. Session goes UNHEALTHY after login succeeds

**Symptom:** Human logs in, session briefly shows HEALTHY, then transitions to UNHEALTHY.

**Causes:**
- `dom_check` on `body` returns `isVisible()=false` for SPAs (Salesforce Lightning, Workday). Switch to `url_check`.
- `keepalive_config.actions` only has `screenshot`. The session times out on the server side because no HTTP requests are made. Add a `goto` action.
- Health check `timeout_ms` too low. Some SPAs take 10-15 seconds to render. Increase to 20000ms.

**Fix:** Use `url_check` instead of `dom_check`. Add `goto` to keepalive actions. Increase timeout.

### 4. `screenshot` keepalive does not prevent session timeout

**Symptom:** The browser shows the target app is logged out despite frequent keepalive runs.

**Cause:** `screenshot` only captures the current page pixels. It does NOT make an HTTP request to the target site. The server-side session timer expires because no activity is detected.

**Fix:** Replace `{"action": "screenshot"}` with `{"action": "goto", "url": "https://example.com/home"}` in keepalive actions. The `goto` triggers a real navigation and HTTP request.

### 5. Salesforce `aura_token` is stale

**Symptom:** API calls using the `aura_token` return `CSRF` or `TOKEN_EXPIRED` errors from Salesforce.

**Cause:** `refresh_interval_seconds` is set too high. Salesforce rotates aura tokens aggressively.

**Fix:** Set `refresh_interval_seconds: 120` (or lower) in the app's export_policy. This ensures the worker re-extracts tokens every 2 minutes.

### 6. VF tokens all empty (Salesforce)

**Symptom:** All `vf_*` custom extractions return empty strings, but `access_token` and `aura_token` work.

**Causes:**
- `extract_urls` not configured. The worker never navigates to the VF page.
- `store_as` value not captured. The `evaluate` step that extracts `quote_id` failed (no Quote page was open when the DSL ran).
- `extract_on_url` glob does not match the navigated URL.

**Fix:** Ensure the login DSL includes a `request_human_input` step asking the human to navigate to a Quote page, followed by `evaluate` with `store_as: "quote_id"`. Verify `extract_urls` template resolves to a valid URL.

### 7. Profile credential_types.custom key mismatch

**Symptom:** Profile serves cookies and headers correctly, but `custom` fields are missing from the response.

**Cause:** The `key` in `credential_types.custom` does not exactly match the `key` in `custom_extractions`. Keys are case-sensitive.

**Fix:** Ensure exact match. Example: if extraction key is `vf_csrf_load`, the profile custom entry must also be `{"key": "vf_csrf_load", ...}`.

### 8. force_refresh returns stale credentials despite wait_seconds

**Symptom:** `force_refresh: true, wait_seconds: 15` returns credentials with old `extracted_at` timestamp.

**Causes:**
- Worker is not running or is in an error state. Check session state.
- Worker is busy with a keepalive cycle and cannot respond within the timeout.
- Redis connectivity issues between API and worker.

**Fix:** Check session state with `GET /sessions`. If UNHEALTHY, the worker may need to re-login first. Increase `wait_seconds` to 30 if the worker is slow.

### 9. Session stuck in LOGIN_IN_PROGRESS

**Symptom:** Session shows `LOGIN_IN_PROGRESS` indefinitely, no Slack notification appears.

**Causes:**
- Controller cannot reach NATS. The `hitl.started` event is not published.
- Slack bot not running or not connected to NATS.
- The DSL step did not reach `request_human_input` -- a previous step is blocking (e.g., `wait_for` with a selector that does not exist).

**Fix:** Check controller logs for NATS errors. Restart controller if needed. Check worker logs for DSL step execution. Verify selectors in DevTools.

### 10. Workday session times out in < 5 minutes

**Symptom:** Workday session goes UNHEALTHY within minutes despite `interval_seconds: 120`.

**Cause:** Workday has an aggressive idle timeout (~5 minutes for some tenants). The keepalive interval must be shorter than the timeout.

**Fix:** Reduce `interval_seconds` to 60 or even 30. Use `goto` with the home page URL to generate real HTTP traffic.

### 11. Multiple domains: cookies missing for some domains

**Symptom:** Credentials contain cookies for the main domain but not for subdomains or alternate domains.

**Cause:** Not all domains are listed in `target_urls`. The egress proxy blocks traffic to unlisted domains, so the browser never sets cookies for them.

**Fix:** Add all relevant domains to `target_urls`. For Salesforce, include `.my.salesforce.com`, `.lightning.force.com`, and `.vf.force.com` variants.

### 12. `streaming_mode` in browser_policy causes validation error

**Symptom:** App creation fails or `streaming_mode` has no effect.

**Cause:** `streaming_mode` is not a valid field in `browser_policy`. VNC streaming is always enabled for HITL sessions.

**Fix:** Remove `streaming_mode` from `browser_policy`.

### 13. Canary profile not serving credentials

**Symptom:** After promoting to CANARY, `POST /credentials/request` still returns credentials from the old ACTIVE profile.

**Cause:** `resolveActiveProfile()` prefers ACTIVE over CANARY. Canary only serves when no ACTIVE profile exists for the requested `profile_id`, or when the request specifically targets the canary.

**Fix:** This is expected behavior. Promote the canary to ACTIVE once validated: `POST /admin/profiles/:id/promote`.

### 14. refresh_interval_seconds defaults to 3600

**Symptom:** Volatile credentials (CSRF tokens, auth headers) are stale for up to an hour between extractions.

**Cause:** If `refresh_interval_seconds` is not set in `export_policy`, it defaults to 3600 (1 hour). For volatile tokens, this is far too slow.

**Fix:** Explicitly set `refresh_interval_seconds` in the app's `export_policy`. Use 60-120 for sites with volatile tokens.

---

## Section 8: API Quick Reference

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `POST` | `/login` | Get admin JWT | None (email + password in body) |
| `POST` | `/auth/agent-token` | Get agent JWT | None (client_id + client_secret in body) |
| `POST` | `/apps` | Create application (optional `tenant_id` body field — Admin only, defaults to caller tenant) | Admin JWT |
| `GET` | `/apps` | List applications (optional `?tenant_id=` — Admin only) | Admin JWT |
| `GET` | `/apps/:id` | Get application details (Admin bypasses tenant filter by UUID) | Admin JWT |
| `PUT` | `/apps/:id` | Update application (Admin bypasses tenant filter by UUID) | Admin JWT |
| `DELETE` | `/apps/:id` | Delete application (Admin bypasses tenant filter by UUID) | Admin JWT |
| `GET` | `/sessions` | List sessions | Admin JWT |
| `GET` | `/sessions/:id` | Get session details | Admin JWT |
| `POST` | `/sessions/:id/stream` | Get VNC stream URL | Admin JWT |
| `POST` | `/sessions/:id/takeover` | Acquire baton (human control) | Admin JWT |
| `POST` | `/sessions/:id/release` | Release baton (back to automation) | Admin JWT |
| `POST` | `/sessions/:id/input` | Submit human input (type, value, step_index) | Admin JWT |
| `POST` | `/sessions/:id/acknowledge` | Acknowledge failure, retry | Admin JWT |
| `POST` | `/admin/profiles` | Create profile (optional `tenant_id` body field — Admin only, defaults to caller tenant) | Admin JWT |
| `GET` | `/admin/profiles` | List profiles (optional `?tenant_id=` — Admin only) | Admin JWT |
| `GET` | `/admin/profiles/:id` | Get profile details (Admin bypasses tenant filter by UUID) | Admin JWT |
| `POST` | `/admin/profiles/:id/promote` | Promote profile (Admin bypasses tenant filter by UUID) | Admin JWT |
| `POST` | `/credentials/request` | Request credentials (supports `force_refresh`, `wait_seconds`) | Agent JWT or Admin JWT |
| `GET` | `/health/live` | Liveness check | None |
| `GET` | `/health/ready` | Readiness check | None |

### Credential request body options

```json
{
  "profile_id": "required-profile-id",
  "force_refresh": false,
  "wait_seconds": 0
}
```

- `profile_id` (required) -- Which profile's credentials to return
- `force_refresh` (optional, default false) -- Trigger immediate re-extraction by the worker
- `wait_seconds` (optional, default 0, range 1-30) -- Block until fresh credentials arrive or timeout. Only meaningful with `force_refresh: true`. Without `wait_seconds`, force_refresh is fire-and-forget.
