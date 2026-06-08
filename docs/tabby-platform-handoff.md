# Tabby Platform Handoff

Internal document. Explains how Tabby works from the platform perspective, what must be configured, and how each execution path uses it.

---

## 1. Overview

### What Tabby Is

Tabby is a browser infrastructure service that provides authenticated browser sessions for credential extraction. It runs Chromium instances inside Kubernetes pods, manages human-in-the-loop (HITL) flows for manual login, and extracts credentials/tokens/cookies that the platform's actions need.

### What Tabby Is Not

Tabby is not a general-purpose browser automation engine. It does not execute arbitrary workflows, scrape websites, or process documents. Its primary validated use case is **credential extraction for platform actions**.

### Current Proven Use Case

Actions on the Adopt platform need browser-authenticated credentials to interact with SaaS applications (Salesforce, Workday, etc.). Previously, the Chrome Extension extracted these. Tabby replaces that flow server-side:

1. Platform detects an action needs browser credentials (via deployment rules + Token Manager)
2. Tabby provides a Chromium browser session
3. User logs in via VNC when needed (HITL)
4. Tabby extracts the configured credentials (cookies, tokens, headers, custom JS extractions)
5. Platform action executes with the resolved credentials

---

## 2. Current State-of-the-Art

### Validated and Production-Ready

- **Browser session management** — one Chromium pod per user session, automatic provisioning from templates
- **VNC/noVNC streaming** — user sees the browser via WebSocket-proxied noVNC viewer, can type/click/login manually
- **Human-in-the-loop (HITL)** — VNC link delivered via Copilot, MCP, Slack, or Teams. User logs in, clicks "Mark as Resolved"
- **Credential extraction** — cookies (all or named), response headers, request headers, localStorage, sessionStorage
- **Custom extraction** — JS expressions run inside the browser page context (e.g., Salesforce Aura tokens, CSRF tokens from `RemotingProviderImpl`)
- **Page-scoped extraction** — `extract_on_url` glob filters extraction to specific pages (e.g., VisualForce pages only)
- **Idle shutdown** — configurable inactivity timeout reclaims worker pods
- **Token caching** — federated Tabby tokens cached in Redis (~59 min), avoiding repeated token exchange
- **Multi-tenant isolation** — sessions scoped by tenant_id + owner_user_id

### Exploratory / Needs Validation

- **CDP streaming** — implemented as alternative to VNC (lighter, no Xvfb). Fully built (relay server, allowlisted CDP protocol filter, canvas-based viewer). Not the default mode; requires explicit `browser_policy.streaming_mode: "cdp"`. Production validation limited.
- **Execute endpoints** (`POST /execute/fetch`, `POST /execute/browser`) — added for NoUI/browser-use-style work. Gated behind `execute_enabled` on the Application entity. Supports navigate, click, type, screenshot, HAR capture. Does **not** support downloads, file export, or raw JS evaluation via API. These endpoints exist but have not been presented as a supported production flow for credential extraction customers.
- **Browser-task execution** (e.g., "open a bank website, download a file, send it somewhere") — Tabby provides the browser infrastructure, but there is no end-to-end path for downloading files from the worker pod and delivering them to a caller. `browser_policy.downloads` is `false` by default and even if enabled, no file retrieval API exists.

---

## 3. Platform Prerequisites

### Feature Flag

The `tabby` feature flag must be enabled for the organization via `POST /v1/org/features`.

**Where it's checked:** `tabby_resolution_service.py` line 104 calls `OrgFeatureMapperService.get_enabled_features_for_org(org_id)` and returns early if `"tabby"` is not in the list.

**Frontend:** `isTabbyFeatureEnabled()` in `frontend/src/utils/userUtils.js` line 103 gates all Tabby UI (Token Manager TABBY type, deployment rule toggle, Playground Profile fields).

### Deployment Rules

Actions that should use Tabby must have `use_tabby = true` in `db_org_action_rules` (SingleStore).

**Where it's checked:** `tabby_resolution_service.py` line 71-81 queries `ActionDeploymentRules` when `action_id` is provided and `force_tabby` is not set.

**Frontend:** `DeploymentRules.jsx` line 1085 renders the "Use Tabby" toggle, gated by `isTabbyFeatureEnabled()`.

**MCP note:** The MCP reads `requires_tabby` from `GET /v1/actions/action-integration-tools` (which batch-queries `ActionDeploymentRules`). This is cached for 10 minutes. The MCP then sends `requires_tabby: true` in the `direct-signal` body, which sets `force_tabby=True` — bypassing the DB lookup.

### Token Manager

Token Manager entries with `storage_type: "TABBY"` define what credentials the platform needs from Tabby.

Each entry has:

- `name` — the token name used in security_headers (e.g., `sfdc_cookie`, `aura_token`)
- `storage_type` — must be `TABBY`
- `tabby_profile_id` — the Tabby service profile name (must match the `profile_name_pattern` from the app template)
- `credential_path` — where in the extracted artifact to find the value (e.g., `custom.Cookie`, `cookies.ALL`, `custom.aura_token`)

**Where it's used:** `tabby_resolution_service.py` line 138-151 batch-loads `TokenConfig` rows with `storage_type=TABBY` matching the `security_headers` values.

### Playground Profile

The Playground Profile connects the platform to a specific Tabby deployment.

Current fields:

- `tabby_url` — the Tabby API URL (e.g., `https://tabby-api.customer.com`)
- `tabby_idp_id` — the IDP UUID registered in Tabby (from Step 2 of setup guide)
- `security_headers` — JSON mapping of header names to Token Manager names

**Where it's used:** `tabby_resolution_service.py` line 87-95 loads the default profile with `use_tabby == True` (or `tabby_url != None` on older branches).

> **Future direction:** The Playground Profile is being simplified. `tabby_url` will become an environment variable (`TABBY_URL`), and `tabby_idp_id` will be replaced by a simple `use_tabby: boolean` toggle.

### Data Migration Considerations

When migrating actions from one environment to another, ensure:

- The `tabby` feature flag is enabled in the target org
- `ActionDeploymentRules.use_tabby` is set for migrated actions
- Token Manager entries exist with matching `tabby_profile_id` values
- The Playground Profile has the correct Tabby URL and IDP ID for the target environment

---

## 4. Tabby-Side Prerequisites

### Tenant / Org ID

The Tabby tenant ID must match the platform's organization ID. When using `allow_auto_provision: true` on the IDP registration, tenants are created automatically from the JWT's `tenant_id_claim`.

### Application Template

Defines how Tabby opens a browser session for a specific application. Contains:

- Login DSL steps (navigate, fill, click, request_human_input)
- Keepalive configuration
- Export policy (what to extract, from which domains)
- Custom extractions (JS expressions for site-specific tokens)
- Browser policy (downloads, clipboard, streaming mode)

**The `profile_name_pattern` must match what the Token Manager's `tabby_profile_id` references.** This is the link between platform and Tabby.

For provisioning, two routes exist:

- `POST /admin/app-templates` — creates a template for an org. When a user from that org requests credentials, Tabby auto-provisions an app + profile + session from the template. One template serves all users in the org.
- `POST /applications` — creates an application directly for a specific user. Use this only when a single user needs a custom configuration different from the template.

> Template payload examples are provided in the doc `SALESFORCE_TEMPLATE_PAYLOAD.md` (check point 1.4).

---

## 5. Configuration Model

### Old Model (Chrome Extension)

```
Platform Token Manager → defines what credentials are needed
Playground Profile → defines security_headers mapping
Chrome Extension → extracts credentials from the user's browser
Action executes with resolved credentials
```

### Current Model (Tabby)

```
Platform Token Manager → defines what credentials are needed (storage_type: TABBY)
Playground Profile → defines Tabby URL + IDP ID + security_headers mapping
Tabby Application Template → defines how to open browser + what to extract
Tabby provides browser/session → user logs in via VNC → Tabby extracts credentials
Action executes with resolved credentials
```

The key difference: one additional configuration step (Tabby application template) that tells Tabby how to handle the specific application. Everything else in the platform stays the same.

---

## 6. Entry Points and Execution Flows

### Copilot / Chrome Extension

**Routes:** `POST /v1/conversations/{id}/messages` (L271), `POST /v1/conversations/{id}/signal/` (L530), `POST /v1/conversations/{id}/reasoning` (L757), `POST /v1/end-user/conversations/{id}/signal` (L391), `POST /v1/end-user/conversations/{id}/reasoning` (L543)

**Flow:**

1. User sends prompt
2. `resolve_tabby_tokens_or_hitl()` called with `security_headers` and `action_id`
3. Checks `ActionDeploymentRules.use_tabby` in SingleStore
4. If `use_tabby=True`: token exchange → `POST /credentials/request` → resolve or HITL
5. If session HEALTHY: resolved headers returned → action dispatched to Temporal
6. If session not ready: polls up to 150s → `TabbySessionNotHealthyError` → returns `tabby_hitl_required`
7. Frontend renders `TabbyHitlCard` with VNC link
8. User logs in via VNC → clicks "Mark as Resolved"
9. Frontend calls `POST /end-user/conversations/tabby-resolve-hitl`
10. User retries → session HEALTHY → credentials resolve instantly

**Known issue:** Tabby resolution runs BEFORE workflow/Temporal selects the action. May trigger HITL for non-Tabby actions. See section 9.

### Test Action

**Route:** `POST /v1/actions/execute` (L167)

Same as Copilot — calls `resolve_tabby_tokens_or_hitl()` with action_id.

### MCP

**Route:** `POST /v1/conversations/direct-signal/` (L635)

**Flow:**

1. MCP receives tool invocation
2. python-mcp reads `requires_tabby` from cached `action-integration-tools`
3. Sends `direct-signal` with `requires_tabby: true` in body
4. `force_tabby=True` → skips deployment rules DB lookup
5. Same resolution: token exchange → credentials/request → poll if needed
6. If HITL: returns `tabby_hitl_required` with VNC link
7. LLM instructs user to open link → user resolves → LLM retries

**Why MCP doesn't have the Copilot bug:** MCP sends a specific `action_id` — the tool maps 1:1 to an action. No "prompt routing" step. `requires_tabby` is pre-computed.

---

## 7. Detailed Platform Flow

### Resolution Service Functions


| Function                              | File:Line                         | Purpose                                                                     |
| ------------------------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `resolve_tabby_tokens_or_hitl()`      | `tabby_resolution_service.py:516` | Entry point. Returns `(resolved_headers, None)` or `(None, hitl_response)`  |
| `resolve_tabby_tokens()`              | `:38`                             | Core logic: rules → profile → feature gate → token exchange → batch resolve |
| `_get_tabby_token()`                  | `:220`                            | Auth: Redis cache → OIDC exchange → agent assertion fallback                |
| `_post_credentials_with_auth_retry()` | `:312`                            | `POST /credentials/request` with 401 retry                                  |
| `_get_session_status()`               | `:369`                            | `GET /agent/session-status/:profile_id`                                     |
| `build_hitl_response()`               | `:470`                            | Build `tabby_hitl_required` JSON                                            |
| `resolve_tabby_hitl()`                | `:548`                            | Submit resolve input, poll for HEALTHY                                      |


### Tabby API Calls


| Endpoint                               | When                          | Purpose                             |
| -------------------------------------- | ----------------------------- | ----------------------------------- |
| `GET /health/live`                     | Before resolution             | Verify Tabby reachable              |
| `POST /auth/token-exchange`            | Once per user (~59 min cache) | Exchange platform JWT for Tabby JWT |
| `POST /credentials/request`            | Per token resolution          | Get extracted credentials           |
| `GET /agent/session-status/:profileId` | When credentials 404          | Poll session state + VNC URL        |
| `POST /sessions/:id/short-link`        | MCP path only                 | Generate compact VNC link           |
| `POST /sessions/:id/input`             | On HITL resolve               | Submit human input                  |


---

## 8. CDP/VNC Support

### VNC (Default)

Worker runs headed Chromium with Xvfb + noVNC sidecar. Full keyboard/mouse via VNC protocol.

### CDP (Alternative)

Worker runs headless Chromium. CDP relay filters protocol commands (allowlist: screencast, input events, insertText). Canvas-based viewer renders JPEG frames. Lighter than VNC (no Xvfb). Requires `browser_policy.streaming_mode: "cdp"`.

### Execute Endpoints (NoUI)

Gated behind `execute_enabled` on Application. Two endpoints:

- `POST /execute/fetch` — `page.evaluate(fetch(...))` inside the browser
- `POST /execute/browser` — Playwright commands (navigate, click, type, screenshot, HAR)

**Missing for full browser-task execution:** no raw JS evaluation via API, no file download/export path, no multi-tab. These are additive features, not part of credential extraction.

---

## 9. Known Bugs / Limitations

### Eager Tabby Resolution (Copilot/CE)

Tabby resolution runs before workflow action selection. May trigger HITL for non-Tabby actions.

**Affects:** Copilot, Chrome Extension.
**Does not affect:** MCP (uses explicit action_id via `direct-signal`).
**Fix:** Move resolution into Temporal workflow after action selection (roadmap).

### MCP Cache (10 min)

`requires_tabby` from `action-integration-tools` is cached 10 minutes. Changes to deployment rules take up to 10 minutes to propagate.

### Profile Name Pattern Must Match

`profile_name_pattern` in Tabby template must exactly match `tabby_profile_id` in Token Manager. Mismatch = empty credentials.

---

## 10. Roadmap / Future Work

- **Move Tabby resolution into Temporal workflows** — resolve after action selection, not before. Eliminates the eager-trigger bug.
- **Platform-hosted VNC/CDP viewer** — route streaming through the platform. Tabby becomes intra-cluster only.
- **Simplified Playground Profile** — `TABBY_URL` env var + `use_tabby` toggle replaces per-profile fields.
- **Pipeline support** — extend Tabby to pipeline execution paths. Currently supports actions and MCP only.
- **Template builder UI** — visual tool for creating Tabby app templates.
- **Warm session pools** — pre-warmed sessions to eliminate cold-start latency.
- **CDP production validation** — formal testing of CDP as production streaming mode.

---

## 11. How to Onboard a New Action to Tabby

1. Enable `tabby` feature flag for the org
2. Set `use_tabby: true` in deployment rules for the action
3. Create Token Manager entries (`storage_type: TABBY`, matching `tabby_profile_id` and `credential_path`)
4. Configure Playground Profile (Tabby URL, IDP ID, security_headers)
5. Create Tabby app template (login DSL, extraction config, `profile_name_pattern` matching Token Manager)
6. Verify tenant ID matches platform org ID
7. Test via MCP (tools should show `[Requires login]` label) or Copilot

---

## 12. Open Questions

- **Browser downloads** — infrastructure exists but no retrieval API
- **CDP execution maturity** — built but not production-validated at scale
- **Non-credential use cases** — may need new platform/workflow integration
- **Pipeline integration** — needs implementation for pipeline execution paths

---

## 13. File/Function Reference

### Platform Backend


| File                                               | Key Functions                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `backend/app/services/tabby_resolution_service.py` | `resolve_tabby_tokens()`, `resolve_tabby_tokens_or_hitl()`, `resolve_tabby_hitl()`, `build_hitl_response()`                       |
| `backend/app/routes/conversation.py`               | `create_message` (L271), `create_signal_message` (L530), `create_reasoning_message` (L757), `create_direct_signal_message` (L635) |
| `backend/app/routes/end_user_conversation.py`      | `create_signal_message` (L391), `create_reasoning_message` (L543)                                                                 |
| `backend/app/routes/action.py`                     | `execute_action` (L167)                                                                                                           |
| `backend/app/routes/action_integration_tool.py`    | `list_mcp_enabled_actions` (L83)                                                                                                  |
| `backend/app/models/token_config.py`               | `tabby_profile_id`, `credential_path`                                                                                             |
| `backend/app/models/playground_profile.py`         | `tabby_url`, `tabby_idp_id`                                                                                                       |
| `backend/app/models/action_deployment_rules.py`    | `use_tabby`                                                                                                                       |


### Frontend


| File                                                          | What it does              |
| ------------------------------------------------------------- | ------------------------- |
| `frontend/src/utils/userUtils.js`                             | `isTabbyFeatureEnabled()` |
| `frontend/src/components/.../MessageItem.jsx`                 | `TabbyHitlCard`           |
| `frontend/src/components/TestMode/TestModeContainer.jsx`      | Test mode HITL            |
| `frontend/src/components/deploymentRules/DeploymentRules.jsx` | "Use Tabby" toggle        |
| `frontend/src/components/PlaygroundProfile/ProfileDrawer.jsx` | Tabby URL + IDP ID        |
| `frontend/src/components/settings/TokenConfigEditor.jsx`      | TABBY storage type config |


### MCP


| File                                        | What it does                            |
| ------------------------------------------- | --------------------------------------- |
| `python-mcp/src/core/adopt_agent.py`        | `direct_signal()` with `requires_tabby` |
| `python-mcp/src/tool_routing_middleware.py` | `[Requires login]` label                |


