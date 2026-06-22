# App Template & Application Fields Reference

## Template → Application Relationship

Templates are blueprints. When `POST /credentials/request` arrives for an unknown `profile_id`, the system finds a template with matching `profile_name_pattern`, creates an Application + ServiceProfile + Session from it.

**PROPAGATED_FIELDS** — when a template is updated, these fields are pushed to ALL linked apps:

```
browser_policy, login_config, keepalive_config, export_policy, notification_config, execute_enabled
```

Fields NOT in this list are either cloned once at provision time or read from the template at runtime.

---

## AppTemplateEntity

Source: `apps/api/src/entities/app-template.entity.ts`

| Field | Type | Default | Propagated? | Description |
|---|---|---|---|---|
| `id` | uuid | auto | — | Template identifier |
| `tenant_id` | varchar | required | — | Scopes template to one tenant |
| `name` | varchar | required | No | Human label. Unique per tenant. Used in auto-provisioned app name: `"{name} — {userId}"` |
| `profile_name_pattern` | varchar | required | N/A (template-only) | Must match `profile_id` in `POST /credentials/request` to trigger auto-provisioning |
| `login_config` | jsonb | required | **Yes** | Login DSL, URL, credential ref. See LoginConfig below |
| `keepalive_config` | jsonb | required | **Yes** | Keepalive interval, actions, health checks. See KeepaliveConfig below |
| `export_policy` | jsonb | required | **Yes** | What to extract, TTL, headers, custom extractions. See ExportPolicy below |
| `browser_policy` | jsonb | `{"clipboard":false,"downloads":false,"file_chooser":false}` | **Yes** | Browser permissions, streaming mode |
| `notification_config` | jsonb | `{}` | **Yes** | HITL notification channels |
| `execute_enabled` | boolean | `false` | **Yes** | Gates NoUI execute endpoints (fetch/browser commands in worker) |
| `credential_ref_default` | varchar | `'manual:'` | No | Convenience default, actual ref lives in `login_config.credential_ref` |
| `extra_egress_allowlist` | jsonb[] | `[]` | No (cloned at provision) | Suffix-pattern domains for egress NetworkPolicy (e.g. `.salesforce.com`) |
| `idle_shutdown_seconds` | integer | `null` | No (read at runtime) | Per-template idle timeout. Controller reads via `app.template_id` FK. `@Min(60)`. Falls back to `IDLE_SHUTDOWN_SECONDS` env if null |
| `created_at` | timestamptz | auto | — | — |
| `updated_at` | timestamptz | auto | — | — |

### Why some fields are not propagated

| Field | Reason |
|---|---|
| `name` | Each app has its own name. Overwriting would break identification |
| `profile_name_pattern` | Routing key. Apps don't have this field |
| `credential_ref_default` | Actual ref is inside `login_config.credential_ref` which IS propagated |
| `extra_egress_allowlist` | Changing after provision could silently drop domains the app needs |
| `idle_shutdown_seconds` | Read directly from template at runtime — no copy needed |

---

## ApplicationEntity

Source: `apps/api/src/entities/application.entity.ts`

| Field | Type | Default | Source | Description |
|---|---|---|---|---|
| `id` | uuid | auto | — | App identifier |
| `tenant_id` | varchar | required | From template or create call | All sessions/profiles inherit this |
| `name` | varchar | required | `"{template.name} — {userId}"` or manual | Display label, no uniqueness constraint |
| `target_urls` | jsonb (string[]) | required | Built from `login_config.login_url` + `export_policy.target_domains` | Egress NetworkPolicy domains. Must be non-empty HTTPS URLs |
| `extra_egress_allowlist` | jsonb (string[]) | `[]` | Cloned from template | Suffix-pattern egress domains merged with `target_urls` |
| `login_config` | jsonb | required | Propagated from template | Login DSL |
| `keepalive_config` | jsonb | required | Propagated from template | Keepalive config |
| `export_policy` | jsonb | required | Propagated from template | Export/extraction config |
| `browser_policy` | jsonb | `{"downloads":false,"clipboard":false,"file_chooser":false}` | Propagated from template | Browser permissions |
| `notification_config` | jsonb | `{channels:[]}` | Propagated from template | HITL notification targets |
| `execute_enabled` | boolean | `false` | Propagated from template | NoUI execute endpoints |
| `desired_session_count` | integer | `1` (but set to `0` at provision, then scaled to `1`) | Per-app operational state | Controller creates/destroys sessions to match this |
| `owner_user_id` | varchar | `null` | Set post-provision for per-user apps | Session scoping. Admin sees all; Operator sees only their own |
| `template_id` | uuid | `null` | Set post-provision | Back-reference to parent template. Used for `idle_shutdown_seconds` lookup and propagation |
| `credential_last_validated_at` | timestamptz | `null` | Manual UI action | Credential rotation tracking (UI-only) |
| `credential_rotation_reminder_days` | integer | `90` | Manual config | Days before rotation reminder (UI-only) |
| `last_reconciled_at` | timestamptz | `null` | Controller stamps each tick | Ordering key for `FOR UPDATE SKIP LOCKED` — stale apps processed first |
| `created_at` | timestamptz | auto | — | — |
| `updated_at` | timestamptz | auto | — | — |

### Fields on app but NOT on template

| Field | Why |
|---|---|
| `target_urls` | Built from template's `login_url` + `target_domains` at provision time |
| `desired_session_count` | Per-app runtime state |
| `owner_user_id` | Per-user scoping, set post-provision |
| `template_id` | Back-reference |
| `credential_last_validated_at` | Per-app credential tracking |
| `credential_rotation_reminder_days` | Per-app UI config |
| `last_reconciled_at` | Controller operational state |

---

## JSONB Config Objects

### LoginConfig

| Field | Type | Required | Default | Description | Consumed by |
|---|---|---|---|---|---|
| `login_url` | string | yes | — | Starting URL for login | Worker `goto`; controller indirectly; auto-provision builds `target_urls` |
| `credential_ref` | string | yes | — | `k8s:secret/{name}` (mounts K8s secret with USERNAME/PASSWORD) or `manual:` (no credential injection, human provides everything via HITL) | Controller mounts K8s secret into pod |
| `steps` | DslStep[] | yes | — | Login automation sequence. Must have at least one `goto` | Worker `LoginDslRunner` |
| `screenshot_policy.capture_on_error` | boolean | no | `true` | Take screenshot when a step fails | Worker |
| `screenshot_policy.redact_sensitive` | boolean | no | `true` | Redact screenshots from sensitive steps | Worker |
| `seed_cookies` | Cookie[] | no | — | Pre-injected cookies for recording mode sessions only | Worker (recording mode only) |

### DSL Step Types

| Action | Key fields | Notes |
|---|---|---|
| `goto` | `url` or `url_expression` | Starting navigation. `url_expression` is JS evaluated at runtime |
| `fill` | `selector`, `value` | Fill input. Supports `${USERNAME}`, `${PASSWORD}` placeholders |
| `click` | `selector`, `first` (boolean) | `first: true` uses `locator.first()` for multiple matches |
| `wait_for` | `selector`, `first` | Wait for element to appear |
| `wait_for_url` | `pattern` | Wait for URL to match regex/glob |
| `evaluate` | `expression`, `store_as` | Run JS in page. `store_as` saves result for `extract_urls` templates |
| `request_human_input` | `input_type`, `label`, `field_selector` | Triggers HITL. Types: `otp`, `email`, `password`, `captcha`, `verification_code`, `url`, `confirm` |
| `screenshot` | — | Capture screenshot (does NOT keep session alive) |
| `keyboard` | `key` | Press key (e.g. `'Enter'`) |
| `sleep` | `ms` | Pause execution |
| `select` | `selector`, `value` | Select dropdown option |
| `frame` / `main_frame` / `popup` | `selector` (frame only) | Switch browser context |
| `reload` | — | Reload page |

**Common step fields (all types):**

| Field | Default | Description |
|---|---|---|
| `timeout_ms` | `30000` | Per-step timeout |
| `retry_count` | `1` | Attempts before failure |
| `retry_backoff` | `'fixed'` | `'fixed'` or `'exponential'` |
| `retry_delay_ms` | `1000` | Delay between retries |
| `retry_max_delay_ms` | `30000` | Cap for exponential backoff |
| `sensitive` | `false` | Suppresses logging for this step |
| `on_failure` | — | `skip` (continue), `abort` (fail), or `request_help` (screenshot + ask human). Only on `wait_for`, `wait_for_url`, `click`, `fill`, `goto` |

### KeepaliveConfig

| Field | Type | Required | Validation | Default | Description |
|---|---|---|---|---|---|
| `interval_seconds` | number | yes | `>= 60` | — | Keepalive tick interval |
| `actions` | DslStep[] | yes | may be empty | — | DSL steps per tick (e.g. navigate to refresh auth) |
| `health_checks` | HealthCheck[] | yes | non-empty | — | Checks evaluated after actions |
| `policy` | string | no | `'all'`, `'any'`, `'quorum'` | `'all'` | How many checks must pass |
| `quorum_n` | number | conditional | required when `policy='quorum'`, `>= 1` | — | Min passing checks for quorum |

**Health check types:**

| Type | Fields | PASS condition |
|---|---|---|
| `url_check` | `url`, `expect_status` | Status matches. 401/403 or redirect to auth URL → `AUTH_FAIL` |
| `dom_check` | `selector`, `exists` | Element visible (or not visible if `exists: false`). Timeout → `AUTH_FAIL` |
| `network_check` | `url`, `expect_status`, `body_contains` | Status matches AND body contains string |

### ExportPolicy

**Core fields:**

| Field | Type | Required | Validation | Default | Description |
|---|---|---|---|---|---|
| `artifact_types` | string[] | yes | non-empty | — | What to capture: `cookies`, `headers`, `csrf_token`, `local_storage`, `session_storage` |
| `encryption.algo` | string | yes | `'AES-256-GCM'` | — | Encryption algorithm |
| `encryption.key_ref` | string | yes | — | — | Encryption key reference |
| `ttl_seconds` | number | yes | `>= 300` | — | Artifact bundle TTL. Worker sets `expires_at = upload + ttl_seconds` |
| `refresh_interval_seconds` | number | no | — | `3600` | How often worker re-extracts during keepalive |

**Header capture:**

| Field | Type | Description |
|---|---|---|
| `header_allowlist` | string[] | Response header names to capture. Requires `'headers'` in `artifact_types` |
| `request_header_allowlist` | string[] | Outbound request header names to capture (e.g. bearer JWTs). `Cookie` is rejected |

Both filtered through `target_urls` globs.

**Custom extractions:**

| Field | Type | Description |
|---|---|---|
| `custom_extractions[].key` | string | Lookup key in decrypted bundle's `custom` map |
| `custom_extractions[].type` | `'js_eval'` or `'cookie'` | Extraction method |
| `custom_extractions[].expression` | string | JS expression for `js_eval` type |
| `custom_extractions[].cookie_name` | string | Cookie name for `cookie` type |
| `custom_extractions[].extract_on_url` | string | Glob filter — only extract when page URL matches |
| `extract_urls` | Record<string, string> | Glob-to-URL map. Worker navigates to URLs in new tab before filtered extractions. Supports `{{variable}}` from `store_as` |

**Profile/credential type mapping:**

| Field | Type | Description |
|---|---|---|
| `credential_types` | object | Maps credential categories to consumer definitions. Propagated to `ServiceProfile.credential_types` |
| `credential_types.cookies` | `'ALL'` or array | Cookie selection. `'ALL'` returns all cookies. Array specifies `{name, domain, path, volatility}` |
| `credential_types.headers` | `'ALL'` or array | Header selection |
| `credential_types.csrf` | `{header_name, volatility}` | CSRF token mapping |
| `credential_types.custom` | array | `{key, volatility}` — `key` must match a `custom_extractions[].key` |
| `target_domains` | string[] | Domains propagated to profile's `target_domains`. Used to build `target_urls` at provision |

### BrowserPolicy

| Field | Type | Default | Description | Consumed by |
|---|---|---|---|---|
| `downloads` | boolean | `false` | Allow browser file downloads | Worker browser setup |
| `clipboard` | boolean | `false` | Allow clipboard access | Worker browser setup |
| `file_chooser` | boolean | `false` | Allow file picker dialogs | Worker browser setup |
| `streaming_mode` | `'vnc'` or `'cdp'` | `'vnc'` | VNC: Xvfb + noVNC sidecar. CDP: headless + CDP relay port 9223 | Controller `resolveStreamingMode` |
| `recording_mode` | `'login'` or `'workflow'` | undefined | Recording mode: HAR + DOM capture, keepalive suppressed, all egress allowed | Controller + Worker |

### NotificationConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `channels` | string[] | `[]` | HITL notification targets. Format: `{provider}:{reference}`. Providers: `slack`, `teams`, `agent`. Empty = agent-poll only (silent) |
| `escalation.after_minutes` | number | — | Minutes before escalating |
| `escalation.notify` | string[] | — | Escalation targets (same format as `channels`) |

---

## Auto-Provisioning Flow

When `POST /credentials/request` arrives for unknown `profile_id`:

1. `templateRepo.findOne({ profile_name_pattern: profileId })` — find template
2. `AppsService.create()` — create app with all config from template. `desired_session_count: 0`
3. `appRepo.update(app.id, { owner_user_id, template_id })` — link to template + user
4. `ProfilesService.create()` — create profile with `login_config`, `credential_types` (from `export_policy`), `target_domains`
5. `profileRepo.update(profile.id, { owner_user_id, version_state: ACTIVE })` — skip canary
6. `sessionsService.scale(app.id, 1)` — controller creates pod on next reconcile tick

Concurrent provisioning race: duplicate key `23505` → wait 200ms → retry lookup.

---

## Template Update Propagation

When a template is updated (PUT/PATCH):

1. Template saved to DB
2. All apps with `template_id = template.id` queried (chunks of 50)
3. 6 `PROPAGATED_FIELDS` written to each app
4. For each app, ACTIVE service profiles checked:
   - If `profile.login_config`, `credential_types`, or `target_domains` differ from template
   - Old profile **retired**, new ACTIVE version created (minor version bump: `1.0.0 → 1.1.0`)
   - Change logged and audited

---

## Session Lifetime Variables

| Variable | Type | Default | Scope | Consumed by |
|---|---|---|---|---|
| `MAX_SESSION_AGE_HOURS` | env var | `24` | All sessions — hard max regardless of activity | Controller `checkRecycling` + Worker `RecyclingMonitor` |
| `IDLE_SHUTDOWN_SECONDS` | env var | `0` (disabled) | Global fallback for sessions with `owner_user_id` | Controller `checkRecycling` |
| `template.idle_shutdown_seconds` | DB (app_templates) | `null` | Per-template override, **precedence over env var** | Controller reads via `app.template_id` FK |

**Precedence:** `template.idle_shutdown_seconds` → `IDLE_SHUTDOWN_SECONDS` (env) → `0` (disabled)

**Activity timestamps:**
- `last_activity_at` — written by credential requests + execute calls (primary signal)
- `last_credential_request_at` — written by credential requests only (fallback)
- Idle time = `now - max(last_activity_at, last_credential_request_at, started_at)`

---

## Controller Entity Differences

The controller has minimal entity definitions:

- `AppTemplateEntity` (controller): only `id` + `idle_shutdown_seconds`. All other fields read from the Application entity.
- `ApplicationEntity` (controller): identical to API entity.

---

## Template API Constraints

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /admin/app-templates` | Any role | Non-Admin creates in own tenant only |
| `GET /admin/app-templates` | Any role | Admin can cross-tenant with `?tenant_id=` |
| `PUT/PATCH /admin/app-templates/:id` | Admin or Editor | Triggers propagation to linked apps |
| `DELETE /admin/app-templates/:id` | Admin or Editor | Hard delete. Does NOT cascade to linked apps |

DTO validations: `name` and `profile_name_pattern` require `@MinLength(1)`. `idle_shutdown_seconds` requires `@IsInt() @Min(60)`. JSONB config objects are validated as `@IsObject()` only at the template level — deep validation happens in `AppsService.validateConfigs` when an app is created.

`content_hash` in template responses: SHA-256 of `{name, profile_name_pattern, login_config, keepalive_config, export_policy, browser_policy, notification_config, credential_ref_default, execute_enabled, idle_shutdown_seconds}`. Used by consumers to detect changes without JSONB comparison.
