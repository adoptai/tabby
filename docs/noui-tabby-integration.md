# NoUI + Tabby Integration Guide

How NoUI can use Tabby to record browser workflows, capture HAR/DOM, and generate templates.

---

## Overview

Tabby auto-provisions a browser session per user from a template. NoUI can:

1. Create a minimal template with `execute_enabled: true` → user gets a live browser session with VNC viewer
2. Open the noVNC viewer → user navigates, logs in, performs the workflow
3. Use `/execute/browser` endpoints to capture HAR, screenshots, DOM while the user works
4. Generate the final template (DSL + extraction config) from the recording
5. Update the same template in-place → Tabby propagates changes to all linked apps

---

## Step-by-Step Flow

### 1. Create a minimal app template

**Endpoint:** `PUT /admin/app-templates` or `POST /admin/app-templates`

The template needs:

- `streaming_mode: "vnc"` in `browser_policy` (so the user gets a full noVNC viewer)
- `execute_enabled: true` (so NoUI can use `/execute/browser` endpoints)
- Minimal login DSL (just navigate to the target site + request human input)

**Before creating the template, the tenant must exist in Tabby.** Create it if it doesn't:

```bash
# Create tenant — the ID must match the platform's organization ID
curl -s https://TABBY_URL/tenants \
  -H "Authorization: Bearer $TABBY_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Customer Name",
    "id": "PLATFORM_ORG_ID",
    "max_sessions": 100
  }'
```

- `id` — **must match** the platform org ID exactly. This is how Tabby routes users to the right tenant.
- `max_sessions` — maximum concurrent browser sessions (pods) allowed for this tenant. Set based on expected concurrency. Each user using NoUI will consume one session while active.

> With `allow_auto_provision: true` on the IDP, tenants are created automatically on first JWT. Manual creation is only needed to control `max_sessions` or set a specific name.

Then create the template:

```json
{
  "tenant_id": "PLATFORM_ORG_ID",
  "name": "NoUI Recording - Salesforce",
  "profile_name_pattern": "noui-salesforce",
  "login_config": {
    "login_url": "https://login.salesforce.com",
    "credential_ref": "manual:",
    "steps": [
      {"action": "goto", "url": "https://login.salesforce.com"},
      {"label": "Navigate and log in, then click Mark as Resolved when done", "action": "request_human_input", "input_type": "confirm", "timeout_ms": 600000}
    ]
  },
  "keepalive_config": {
    "interval_seconds": 120,
    "actions": [{"action": "evaluate", "expression": "document.title"}],
    "health_checks": [{"type": "url_check", "url": "https://login.salesforce.com", "expect_status": 200, "timeout_ms": 15000}]
  },
  "export_policy": {
    "artifact_types": ["cookies"],
    "encryption": {"algo": "AES-256-GCM"},
    "ttl_seconds": 3600,
    "refresh_interval_seconds": 3600
  },
  "browser_policy": {
    "downloads": false,
    "clipboard": false,
    "file_chooser": false,
    "allow_evaluate": true,
    "streaming_mode": "vnc"
  },
  "notification_config": {},
  "credential_ref_default": "manual:",
  "idle_shutdown_seconds": 3600
}
```

### 2. Trigger auto-provisioning

**Endpoint:** `POST /credentials/request`

**Auth:** Tabby JWT from token-exchange (platform JWT → `POST /auth/token-exchange` with `subject_token_type: "oidc_jwt"`)

```bash
# 1. Exchange platform JWT for Tabby JWT
TABBY_TOKEN=$(curl -s https://TABBY_URL/auth/token-exchange \
  -H 'Content-Type: application/json' \
  -d '{"subject_token": "PLATFORM_JWT", "subject_token_type": "oidc_jwt"}' \
  | jq -r '.access_token')

# 2. Request credentials (triggers auto-provisioning)
curl -s https://TABBY_URL/credentials/request \
  -H "Authorization: Bearer $TABBY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"profile_id": "noui-salesforce"}'
```

**What happens internally** (`apps/api/src/modules/credentials/credentials.service.ts` line 243):

1. No profile exists for this user → auto-provision kicks in
2. Finds the template by `profile_name_pattern = "noui-salesforce"`
3. Creates: Application (with `template_id`, `execute_enabled` inherited) → Service Profile → Session
4. Controller sees `desired_session_count = 1` → creates worker pod (VNC mode)
5. Returns 404 (session not HEALTHY yet — worker is starting)

### 3. Get the VNC URL

**Endpoint:** `GET /agent/session-status/{profile_id}`

```bash
curl -s https://TABBY_URL/agent/session-status/noui-salesforce \
  -H "Authorization: Bearer $TABBY_TOKEN" | jq '.vnc_stream.url'
```

Returns the full noVNC viewer URL. Open it in the user's browser. The user navigates, logs in, and performs the workflow they want to record.

### 4. Capture with execute endpoints

While the user is in the browser, NoUI can call these endpoints to capture data.

**Auth:** Same Tabby JWT. Role must be Admin, Operator, or Agent with `noui-salesforce` in `allowed_profiles`.

#### Start HAR capture

```bash
curl -s https://TABBY_URL/execute/browser \
  -H "Authorization: Bearer $TABBY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"profile_id": "noui-salesforce", "command": "har_start"}'
```

#### Take screenshots

```bash
curl -s https://TABBY_URL/execute/browser \
  -H "Authorization: Bearer $TABBY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"profile_id": "noui-salesforce", "command": "screenshot"}' \
  | jq '.base64'
```

#### Get page summary (DOM structure)

```bash
curl -s https://TABBY_URL/execute/browser \
  -H "Authorization: Bearer $TABBY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"profile_id": "noui-salesforce", "command": "get_page_summary"}' \
  | jq '.links, .buttons, .inputs'
```

#### Stop HAR capture and get results

```bash
curl -s https://TABBY_URL/execute/browser \
  -H "Authorization: Bearer $TABBY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"profile_id": "noui-salesforce", "command": "har_stop"}' \
  | jq '.entries | length'
```

Returns full HAR 1.2 JSON with all captured request/response pairs.

### 5. Generate the final template

NoUI processes the HAR + DOM + screenshots to generate:

- Login DSL steps (goto, fill, click, wait_for)
- Export policy (target_domains, custom_extractions)
- Credential types mapping

This is NoUI's core logic — not a Tabby responsibility.

### 6. Update the template in-place

**Endpoint:** `PUT /admin/app-templates/{id}`

```bash
curl -s https://TABBY_URL/admin/app-templates/TEMPLATE_ID \
  -X PUT \
  -H "Authorization: Bearer $TABBY_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "login_config": { ... generated DSL ... },
    "export_policy": { ... generated extraction config ... },
    "browser_policy": {
      "streaming_mode": "cdp",
      "allow_evaluate": true,
      "downloads": false,
      "clipboard": false,
      "file_chooser": false
    },
    "keepalive_config": { ... },
    ...
  }'
```

**What happens internally** (`apps/api/src/modules/app-templates/app-templates.service.ts` line 63-81):

1. Template is updated with the new config
2. `propagateToLinkedApps()` is called automatically
3. Finds all apps with `template_id = this template's ID`
4. Updates each app's `browser_policy`, `login_config`, `keepalive_config`, `export_policy`, `notification_config`, `execute_enabled`
5. On next reconcile cycle, the controller picks up the changes

**Propagated fields** (line 84-87):

```typescript
['browser_policy', 'login_config', 'keepalive_config',
 'export_policy', 'notification_config', 'execute_enabled']
```

After the update:

- The template now uses CDP instead of VNC (lighter for production)
- All existing user apps inherited the new config
- New users auto-provision with the updated template
- The `execute_enabled` flag is preserved (or can be changed)

---

## Available Execute Commands

All via `POST /execute/browser` with `profile_id` + `command` + optional `params`:


| Command             | Params                    | Returns                                                  |
| ------------------- | ------------------------- | -------------------------------------------------------- |
| `navigate`          | `{url}`                   | `{url, title}`                                           |
| `click_element`     | `{selector}`              | `{success}`                                              |
| `click_by_text`     | `{text, exact?}`          | `{success}`                                              |
| `click_at`          | `{x, y}`                  | `{success}`                                              |
| `type_text`         | `{selector, text}`        | `{success}`                                              |
| `type_into_label`   | `{label, text}`           | `{success}`                                              |
| `press_key`         | `{key}`                   | `{success}`                                              |
| `get_page_summary`  | —                         | `{title, url, links[], buttons[], inputs[], headings[]}` |
| `get_page_info`     | —                         | `{url, title}`                                           |
| `screenshot`        | —                         | `{base64, mimeType}`                                     |
| `wait_for_selector` | `{selector, timeout_ms?}` | `{success}`                                              |
| `scroll_page`       | `{deltaX?, deltaY?}`      | `{success}`                                              |
| `har_start`         | —                         | `{status: "started"}`                                    |
| `har_stop`          | —                         | HAR 1.2 JSON                                             |
| `har_status`        | —                         | `{active, entry_count}`                                  |


Also available: `POST /execute/fetch` — runs `fetch()` inside the browser page context, inheriting cookies/TLS.

---

## Key References


| What                        | Where                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| App template CRUD           | `apps/api/src/modules/app-templates/app-templates.controller.ts`                            |
| Template propagation        | `apps/api/src/modules/app-templates/app-templates.service.ts:89` (`propagateToLinkedApps`)  |
| Auto-provisioning           | `apps/api/src/modules/credentials/credentials.service.ts:277` (`autoProvisionFromTemplate`) |
| Execute browser handler     | `apps/worker/src/execute-browser-handler.ts`                                                |
| Execute fetch handler       | `apps/worker/src/execute-handler.ts`                                                        |
| Execute service (API proxy) | `apps/api/src/modules/execute/execute.service.ts`                                           |
| Streaming modes             | `packages/shared/src/constants.ts` — `StreamingMode.VNC` / `StreamingMode.CDP`              |


---

## Listing and Editing Existing Templates

NoUI can list all templates for a tenant to let users edit existing configurations:

**List templates:** `GET /admin/app-templates?tenant_id={ORG_ID}`

```bash
curl -s https://TABBY_URL/admin/app-templates?tenant_id=PLATFORM_ORG_ID \
  -H "Authorization: Bearer $TABBY_ADMIN_TOKEN" | jq '.[].name, .[].id'
```

**Get template details:** `GET /admin/app-templates/{id}`

**Update template:** `PUT /admin/app-templates/{id}` — updates the template AND propagates changes to all linked apps automatically.

This enables a flow where NoUI can show the user a list of their existing templates (Salesforce, Workday, etc.), let them re-record or edit the config, and the update propagates to all users in the org.

### Template Update Propagation — What Happens

When a template is updated via `PUT /admin/app-templates/{id}`:

1. Template is saved with the new config
2. `propagateToLinkedApps()` runs — finds all applications with `template_id = this template`
3. Updates each app's: `browser_policy`, `login_config`, `keepalive_config`, `export_policy`, `notification_config`, `execute_enabled`
4. **Currently active sessions keep running with the old config** until they're recycled (idle shutdown or max age)
5. New sessions created after the update use the updated config

**Known gap — profile not updated on template change:**

The propagation updates the **application** entity but does NOT update the **service profile**. The profile holds its own copy of `login_config`, `credential_types`, and `target_domains`. This is a known gap that will be fixed — a PR is coming to make `propagateToLinkedApps` also update (or create a new version of) linked profiles.

- Fields on the **app** (`browser_policy`, `export_policy`, `execute_enabled`, `keepalive_config`, `notification_config`) → propagated ✅
- Fields on the **profile** (`login_config`, `credential_types`, `target_domains`) → NOT propagated ❌

**Temporary workaround for local development:** delete the user's session and app via the API. The next `POST /credentials/request` re-provisions from the updated template with the correct profile data. This is acceptable for dev/testing but not a production solution.

New users who haven't used the template yet always get the latest data — no issue there.

---

## Experimental Features (Not Production-Ready)

### Custom HITL Inputs (OTP, Password, Username)

Tabby has early infrastructure for requesting specific inputs from the user during HITL — not just "confirm" (Mark as Resolved), but actual typed values like OTP codes, passwords, or usernames via the `request_human_input` DSL step with `input_type: "otp"`, `"password"`, `"email"`, etc.

This feature exists in the codebase (DSL step types, Slack modal rendering, Redis relay) but **implementation was paused** to prioritize the core credential extraction delivery. It is not validated end-to-end and should not be relied upon for production flows.

Once the core gaps are addressed (template→profile propagation, platform viewer), proper support for custom HITL inputs will be added.

---

## Additional Context

For full Tabby architecture, platform integration details, and a complete Salesforce template payload example, check:

- `**#ai-tabby` Slack channel** — `tabby-platform-handoff.md` and `SALESFORCE_TEMPLATE_PAYLOAD.md` are pinned/shared there
- `**docs/tabby-platform-handoff.md`** — explains how the platform calls Tabby, all entry points, Token Manager, Playground Profile
- `**docs/SALESFORCE_TEMPLATE_PAYLOAD.md**` — full Salesforce + Workday + 6Sense template payloads with extraction config, step by step

---

## Notes

- **One template per application** — don't create a generic "NoUI" template for all sites. Each target site (Salesforce, Workday, etc.) gets its own template with its own extraction config.
- **User isolation is automatic** — each user gets their own app + profile + session via auto-provisioning. No shared sessions.
- **Template update propagates** — updating the template updates ALL linked apps. No need to recreate user sessions.
- **Streaming mode** — VNC is the default and works with execute endpoints. CDP is available as a lighter alternative but not required.
- `**execute_enabled` must be true** — set in the template's top-level fields. Propagates to apps. Without it, `/execute/`* endpoints return 404 on the worker.
- **Rate limits** — `/execute/fetch`: 60/min per profile. `/execute/browser`: 120/min per profile. HAR has no separate limit.

