# Configurable Login & Post-Login Automation

## Problem

Salesforce and Workday templates required users to perform multiple manual steps via VNC:

1. Log in (username + password + OTP)
2. Navigate to specific pages (e.g., Quotes list in Salesforce)
3. Open a specific record (e.g., a Quote)
4. Wait for tokens to be generated
5. Click "Mark as Resolved"

This was error-prone, slow, and required users to stay in the VNC session for the entire process. Steps like filling username/password via DSL were fragile because they depended on specific selectors that varied between client environments and Salesforce versions.

## What Changed

### 1. Removed fragile username/password fill steps

Templates with `credential_ref: "manual:"` no longer include `fill` steps for username/password. When `manual:` is set, there are no stored credentials to inject — the human provides everything via VNC. The fill steps were failing unpredictably depending on the login page version.

The login flow is now:

```
goto (login URL) → request_human_input (user logs in via VNC) → automation resumes
```

### 2. Login validation after human resolve

After the user clicks "Mark as Resolved", the DSL does **not** blindly assume login succeeded. A `wait_for_url` step validates that the browser landed on an expected authenticated URL pattern.

If validation fails, `on_failure: request_help` triggers a **new HITL intervention** asking the user to complete login properly.

This is configured entirely in the template — no hardcoded logic in the worker.

### 3. Post-login automation (Salesforce Quotes)

After login validation, the DSL automatically:

1. Navigates to the Quotes list via `goto` with `url_expression` (domain-agnostic)
2. Clicks the first available Quote using `click` with `first: true` (new feature)
3. Extracts `quote_id` from the URL via `evaluate` + `store_as`

Each step has `on_failure: request_help` as fallback — if any automation step fails, a single HITL intervention asks the user to resolve the remaining flow manually.

### 4. New DSL feature: `click` with `first: true`

The `click` step now supports an optional `first` boolean field. When `true`, the DSL runner calls `locator(selector).first().click()` instead of `locator(selector).click()`.

This is critical for Salesforce Lightning (and similar React/Web Component SPAs) where:

- CSS selectors match multiple elements through Shadow DOM
- You want the first match from a list (e.g., first Quote link)
- Playwright's strict mode would throw on multiple matches

### 5. Fixed `goto` validator for `url_expression`

The DSL validator previously rejected `goto` steps that used `url_expression` without `url`. This bug prevented domain-agnostic navigation patterns like:

```json
{ "action": "goto", "url_expression": "window.location.origin + '/path'" }
```

The validator now accepts either `url` or `url_expression`.

## How Login Validation Works

Login validation uses existing DSL primitives — no new config structure was needed:{  
  "action": "wait_for_url",  
  "pattern": "**/lightning/**",  
  "timeout_ms": 30000,  
  "retry_count": 0,  
  "on_failure": {  
    "action": "request_help",  
    "message": "Login not detected. Please complete login and click Mark as Resolved.",  
    "input_type": "confirm",  
    "screenshot": true  
  }  
}

**Multiple URL patterns**: Use multiple `wait_for_url` steps with `on_failure: skip` for alternatives, followed by a final validation step. Or use a glob pattern that covers all variants (e.g., `**/lightning/`** matches `/lightning/page/home`, `/lightning/o/...`, etc.).

**Timeout considerations**: The `timeout_ms` on `wait_for_url` should be generous (30s+) because:

- Traffic goes through egress proxy which adds latency
- Salesforce Lightning SPA can take 10-15s to fully redirect after login
- `wait_for_url` resolves immediately when the pattern matches — it only waits the full timeout if it never matches

## How Post-Login Automation Works

All post-login navigation is configured in the template's `login_config.steps` array, after the HITL login step:

```json
[
  { "action": "goto", "url": "https://test.salesforce.com/" },
  { "action": "request_human_input", "input_type": "confirm", "label": "Log in...", "timeout_ms": 300000 },
  { "action": "wait_for_url", "pattern": "...", "on_failure": { "action": "request_help", ... } },
  { "action": "goto", "url_expression": "...", "on_failure": { "action": "request_help", ... } },
  { "action": "click", "selector": "...", "first": true, "on_failure": { "action": "request_help", ... } },
  { "action": "evaluate", "store_as": "quote_id", "expression": "..." }
]
```

The worker executes these sequentially. Any step can fail and trigger HITL fallback.

## How HITL Fallback Works

Every critical automation step includes `on_failure: request_help`:

```json
{
  "on_failure": {
    "action": "request_help",
    "message": "Automation failed. Open a valid Quote via VNC and click Mark as Resolved.",
    "input_type": "confirm",
    "timeout_ms": 600000
  }
}
```

The `on_failure.timeout_ms` controls how long the worker waits for the human to respond (default: 600000ms / 10 minutes). This is **independent** of the step's own `timeout_ms` — the step timeout controls how long the action (goto, click, etc.) has to complete, while the on_failure timeout controls how long to wait for human intervention after the action fails.

When a step fails:

1. All retries are exhausted (`retry_count`)
2. `on_failure` handler triggers
3. Worker writes `pending_input_request` to the session
4. Worker signals `AUTH_FAIL` to the controller
5. Controller transitions to `LOGIN_NEEDED` and creates an intervention
6. Slack/Teams bot posts the message with VNC link
7. User resolves manually via VNC
8. User clicks "Mark as Resolved"
9. Worker receives the response and continues from the next step

**One fallback for the remaining flow**: When a post-login step fails, the HITL message asks the user to complete the entire remaining flow (not just one step). After resolution, the DSL continues with subsequent steps that may succeed or also have their own fallbacks.

## New Fields

### `ClickStep.first` / `WaitForStep.first` (optional boolean)

```typescript
interface ClickStep extends BaseDslStep {
  action: 'click';
  selector: string;
  first?: boolean;  // Default: false (Playwright strict mode)
}

interface WaitForStep extends BaseDslStep {
  action: 'wait_for';
  selector: string;
  first?: boolean;  // Default: false (Playwright strict mode)
}
```

When `true`: uses `locator(selector).first()` instead of `locator(selector)` — avoids Playwright strict mode errors when multiple elements match.

### `FailureHandler.timeout_ms` (optional number)

```typescript
type FailureHandler = {
  action: 'request_help';
  message: string;
  input_type?: HumanInputType;
  timeout_ms?: number;  // Default: 600000 (10 minutes)
};
```

Controls how long the worker waits for human response after a step fails. Independent of the step's action timeout.

### `GotoStep.url_expression` (existing, now properly validated)

No new field — `url_expression` was already implemented in the runner but the validator rejected it without `url`. Now fixed.

## Template Compatibility

- **No new required fields** — all additions are optional
- **Existing templates** continue working unchanged
- `**first`** defaults to `false` — existing click steps behave identically
- `**url_expression`** was already supported in the runner — only the validator was blocking it
- **No migration needed** — these are JSON config fields, not database schema changes
- **No changes to**: session lifecycle, state machine, keepalive, credential extraction, HITL infrastructure, or template propagation

## Files Changed

### packages/shared/src/dsl.types.ts

- Added `first?: boolean` to `ClickStep` and `WaitForStep`
- Added `timeout_ms?: number` to `FailureHandler` (for `request_help`)

### packages/shared/src/dsl.validator.ts

- Fixed `goto` validation to accept `url_expression` without `url`

### apps/worker/src/login-dsl-runner.ts

- `click` and `wait_for` steps use `locator.first()` when `step.first === true`
- `on_failure: request_help` uses its own `timeout_ms` (default 10min) instead of the step's action timeout

### Test files

- `apps/worker/src/login-dsl-runner.spec.ts` — 10 new tests
- `packages/shared/src/dsl.validator.spec.ts` — 4 new tests

## Tests Added


| Test                                                       | What it covers                     |
| ---------------------------------------------------------- | ---------------------------------- |
| `click with first: true using locator.first()`             | First match selection              |
| `does not call first() when first is not set`              | Backward compatibility             |
| `goto with url_expression`                                 | Domain-agnostic navigation         |
| `rejects goto url_expression when allow_evaluate disabled` | Policy enforcement                 |
| `request_help HITL flow`                                   | on_failure triggers intervention   |
| `skip on on_failure: skip`                                 | Step skip + continuation           |
| `abort on on_failure: abort`                               | Step abort                         |
| `wait_for_url matches (login validated)`                   | Login validation success           |
| `wait_for_url fails (login not validated)`                 | Login validation → HITL re-request |
| `variable interpolation in goto`                           | store_as → {{var}} in goto URL     |
| `goto with url_expression valid`                           | Validator accepts url_expression   |
| `goto without url or url_expression`                       | Validator rejects                  |
| `goto with non-string url_expression`                      | Validator rejects                  |
| `click with first: true valid`                             | Validator accepts                  |


## Known Limitations

1. `**first: true` selects the first DOM-order match** — If the list is sorted differently server-side, the first visible quote may not be the "best" one. For the Salesforce use case this is fine (any quote triggers token generation).
2. `**url_expression` requires `allow_evaluate: true`** in `browser_policy`. Without it, the step throws. This is by design — arbitrary JS evaluation must be explicitly enabled per app.
3. **Salesforce Shadow DOM** — CSS selectors like `th[data-label="Quote Number"] a` do **not** work because Lightning uses nested Shadow DOM. Playwright's `locator()` auto-pierces shadow roots, so text-based selectors like `a:has-text("Q-")` work correctly.
4. **Proxy latency** — Timeouts must account for egress proxy latency. The `EXTRACT_TAB_TIMEOUT_MS` env var already handles this for extractions. Login validation timeouts should be at least 30s for proxied environments.
5. **No conditional execution** — The DSL has no if/else. Login validation is modeled as "try → fail → HITL fallback" rather than "check condition → branch". This works but means every validation requires a timeout wait on failure.

## Updated Template Payloads

Full template payloads based on the current AA production templates. Only `login_config.steps` change — `keepalive_config`, `export_policy`, and `browser_policy` remain identical.

### Salesforce Sandbox — Full Template

**Changes from current:**

- Removed: `fill` steps for `input#username` and `input#password` (empty values, fragile selectors)
- Removed: Second `request_human_input` ("Navigate to any quote page") — automation handles this now
- Added: `wait_for_url` login validation with HITL re-request on failure
- Added: `goto` with `url_expression` for domain-agnostic Quotes list navigation
- Added: `wait_for` + `click` with `first: true` to open first Quote automatically
- Added: `wait_for_url` to confirm Quote page loaded
- Kept: `evaluate` + `store_as` for `quote_id` extraction (unchanged)

```json
{
  "id": "389eb98e-303d-4049-8aa0-e61506dbb196",
  "tenant_id": "483d421e-12a7-4616-bbf5-86716cc995a9",
  "name": "Salesforce Sandbox",
  "profile_name_pattern": "salesforce-aa-adopt",
  "login_config": {
    "login_url": "https://test.salesforce.com/",
    "credential_ref": "manual:",
    "steps": [
      {
        "action": "goto",
        "url": "https://test.salesforce.com/"
      },
      {
        "action": "request_human_input",
        "input_type": "confirm",
        "label": "Log into Salesforce and complete any MFA/OTP verification, then click Mark as Resolved.",
        "timeout_ms": 1200000
      },
      {
        "action": "wait_for_url",
        "pattern": "**/lightning/**",
        "timeout_ms": 30000,
        "retry_count": 0,
        "on_failure": {
          "action": "request_help",
          "message": "Login could not be verified. Please complete the Salesforce login and navigate to the home page, then click Mark as Resolved.",
          "input_type": "confirm",
          "timeout_ms": 600000
        }
      },
      {
        "action": "goto",
        "url_expression": "window.location.origin + '/lightning/o/SBQQ__Quote__c/list'",
        "timeout_ms": 30000,
        "on_failure": {
          "action": "request_help",
          "message": "Could not navigate to Quotes. Please open any Quote page in the VNC viewer and click Mark as Resolved.",
          "input_type": "confirm",
          "timeout_ms": 600000
        }
      },
      {
        "action": "wait_for",
        "selector": "a:has-text('Q-')",
        "first": true,
        "timeout_ms": 30000,
        "retry_count": 0,
        "on_failure": {
          "action": "request_help",
          "message": "No Quotes found in the list. Please open any Quote page in the VNC viewer and click Mark as Resolved.",
          "input_type": "confirm",
          "timeout_ms": 600000
        }
      },
      {
        "action": "click",
        "selector": "a:has-text('Q-')",
        "first": true,
        "timeout_ms": 30000,
        "retry_count": 1,
        "on_failure": {
          "action": "request_help",
          "message": "Could not open a Quote. Please open any Quote page in the VNC viewer and click Mark as Resolved.",
          "input_type": "confirm",
          "timeout_ms": 600000
        }
      },
      {
        "action": "wait_for_url",
        "pattern": "**/SBQQ__Quote__c/*/view",
        "timeout_ms": 30000,
        "retry_count": 0,
        "on_failure": {
          "action": "request_help",
          "message": "Quote page did not load. Please open any Quote page in the VNC viewer and click Mark as Resolved.",
          "input_type": "confirm",
          "timeout_ms": 600000
        }
      },
      {
        "action": "evaluate",
        "store_as": "quote_id",
        "expression": "(function(){ var m = window.location.href.match(/SBQQ__Quote__c\\/([a-zA-Z0-9]{15,18})/); return m ? m[1] : ''; })()"
      }
    ]
  },
  "keepalive_config": {
    "interval_seconds": 120,
    "actions": [
      {
        "action": "evaluate",
        "expression": "fetch('/lightning/page/home', {credentials: 'include'}).then(r => r.status)"
      }
    ],
    "health_checks": [
      {
        "type": "url_check",
        "url": "https://aainc--qas.sandbox.lightning.force.com/lightning/page/home",
        "timeout_ms": 20000,
        "expect_status": 200
      }
    ]
  },
  "export_policy": {
    "encryption": { "algo": "AES-256-GCM" },
    "ttl_seconds": 3600,
    "refresh_interval_seconds": 120,
    "artifact_types": ["cookies", "headers", "local_storage", "session_storage"],
    "target_domains": [
      "aainc--qas.sandbox.my.salesforce.com",
      "aainc--qas.sandbox.lightning.force.com",
      "aainc--qas--sbqq.sandbox.vf.force.com"
    ],
    "header_allowlist": ["authorization", "x-csrf-token", "x-sfdc-request-id"],
    "extract_urls": {
      "*/apex/sb*": "https://aainc--qas--sbqq.sandbox.vf.force.com/apex/sb?id={{quote_id}}"
    },
    "credential_types": {
      "cookies": [
        { "name": "sid", "path": "/", "domain": ".salesforce.com", "secure": true, "httpOnly": true, "volatility": "SEMI_STABLE" },
        { "name": "oid", "path": "/", "domain": ".salesforce.com", "secure": true, "httpOnly": false, "volatility": "STABLE" }
      ],
      "headers": [
        { "name": "authorization", "volatility": "VOLATILE" },
        { "name": "x-csrf-token", "volatility": "VOLATILE" },
        { "name": "x-sfdc-request-id", "volatility": "VOLATILE" }
      ],
      "custom": [
        { "key": "access_token", "volatility": "SEMI_STABLE" },
        { "key": "aura_token", "volatility": "VOLATILE" },
        { "key": "aura_context", "volatility": "SEMI_STABLE" },
        { "key": "vf_vid", "volatility": "SEMI_STABLE" },
        { "key": "vf_csrf_load", "volatility": "VOLATILE" },
        { "key": "vf_auth_load", "volatility": "VOLATILE" },
        { "key": "vf_csrf_save", "volatility": "VOLATILE" },
        { "key": "vf_auth_save", "volatility": "VOLATILE" },
        { "key": "vf_csrf_read", "volatility": "VOLATILE" },
        { "key": "vf_auth_read", "volatility": "VOLATILE" },
        { "key": "vf_csrf_search", "volatility": "VOLATILE" },
        { "key": "vf_auth_search", "volatility": "VOLATILE" },
        { "key": "vf_cookie", "volatility": "VOLATILE" },
        { "key": "Cookie", "volatility": "VOLATILE" }
      ]
    },
    "custom_extractions": [
      { "key": "access_token", "type": "cookie", "cookie_name": "sid", "description": "Salesforce session ID" },
      { "key": "aura_token", "type": "js_eval", "expression": "localStorage.getItem('$AuraClientService.token$one:one') || ''", "description": "Lightning Aura JWT" },
      { "key": "aura_context", "type": "js_eval", "expression": "(function(){ var html = document.documentElement.outerHTML; var fwuid = (html.match(/[\"']fwuid[\"']\\s*:\\s*[\"']([A-Za-z0-9_\\-+=/]+)[\"']/) || [])[1] || ''; var appM = (html.match(/[\"']app[\"']\\s*:\\s*[\"']([^\"']+)[\"']/) || [])[1] || 'one:one'; try { return JSON.stringify({mode:'PROD',fwuid:fwuid,app:appM}); } catch(e) { return ''; } })()" },
      { "key": "vf_vid", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { return JSON.parse(m[1]).vf.vid; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*" },
      { "key": "vf_csrf_load", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='load'}).csrf; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*" },
      { "key": "vf_auth_load", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='load'}).authorization; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*" },
      { "key": "vf_csrf_save", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='save'}).csrf; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*" },
      { "key": "vf_auth_save", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='save'}).authorization; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*" },
      { "key": "vf_csrf_read", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='read'}).csrf; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*" },
      { "key": "vf_auth_read", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='read'}).authorization; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*" },
      { "key": "vf_csrf_search", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; var s = ms.find(function(x){return x.name==='search'}); return s ? s.csrf : ''; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*" },
      { "key": "vf_auth_search", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; var s = ms.find(function(x){return x.name==='search'}); return s ? s.authorization : ''; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*" },
      { "key": "vf_cookie", "type": "js_eval", "expression": "document.cookie", "extract_on_url": "*/apex/sb*" },
      { "key": "Cookie", "type": "js_eval", "expression": "document.cookie" }
    ]
  },
  "browser_policy": {
    "clipboard": false,
    "downloads": false,
    "file_chooser": false,
    "allow_evaluate": true
  },
  "notification_config": {},
  "credential_ref_default": "manual:",
  "idle_shutdown_seconds": 3600
}
```

**Salesforce changes summary:**

- Removed: `fill input#username` (empty value, fragile), `fill input#password` (empty value, fragile)
- Removed: Second HITL ("Navigate to any quote page") — automation handles this
- Added: Login validation (`wait_for_url **/lightning/`**)
- Added: Auto-navigate to Quotes list (`goto url_expression`)
- Added: Auto-click first Quote (`click a:has-text('Q-')` with `first: true`)
- Added: Quote page confirmation (`wait_for_url **/SBQQ__Quote__c/*/view`)
- All automation steps have `on_failure: request_help` fallback
- `keepalive_config`, `export_policy`, `browser_policy` unchanged
- HITL timeout kept at 1200000ms (20min) matching existing template

### Workday — Full Template

**Changes from current:**

- Removed: `click [data-testid="username"]` (fragile selector, unnecessary before HITL)
- Added: `wait_for_url` login validation with HITL re-request on failure

```json
{
  "id": "5a44bdf6-0761-4261-93e4-2f75336f9bf9",
  "tenant_id": "483d421e-12a7-4616-bbf5-86716cc995a9",
  "name": "Workday",
  "profile_name_pattern": "workday-aa-adopt",
  "login_config": {
    "login_url": "https://wd5-impl-identity.workday.com/wday/authgwy/automationanywhere3/upc/login",
    "credential_ref": "manual:",
    "steps": [
      {
        "action": "goto",
        "url": "https://wd5-impl-identity.workday.com/wday/authgwy/automationanywhere3/upc/login"
      },
      {
        "action": "request_human_input",
        "input_type": "confirm",
        "label": "Log into Workday via VNC stream, then click Mark as Resolved.",
        "timeout_ms": 1200000
      },
      {
        "action": "wait_for_url",
        "pattern": "**/home.htmld**",
        "timeout_ms": 30000,
        "retry_count": 0,
        "on_failure": {
          "action": "request_help",
          "message": "Login could not be verified. Please complete the Workday login and navigate to the home page, then click Mark as Resolved.",
          "input_type": "confirm",
          "timeout_ms": 600000
        }
      }
    ]
  },
  "keepalive_config": {
    "interval_seconds": 120,
    "actions": [
      {
        "action": "goto",
        "url": "https://wd5-impl-identity.workday.com/automationanywhere3/d/home.htmld"
      }
    ],
    "health_checks": [
      {
        "type": "url_check",
        "url": "https://wd5-impl-identity.workday.com/automationanywhere3/d/home.htmld",
        "timeout_ms": 20000,
        "expect_status": 200
      }
    ]
  },
  "export_policy": {
    "encryption": { "algo": "AES-256-GCM" },
    "ttl_seconds": 3600,
    "refresh_interval_seconds": 120,
    "artifact_types": ["cookies", "headers", "local_storage", "session_storage"],
    "target_domains": [
      "wd5-impl-identity.workday.com",
      "wd5-impl.workday.com"
    ],
    "header_allowlist": ["authorization", "x-csrf-token"],
    "extract_urls": {
      "*/automationanywhere3/*": "https://wd5-impl-identity.workday.com/automationanywhere3/d/home.htmld"
    },
    "credential_types": {
      "cookies": "ALL",
      "headers": [
        { "name": "authorization", "volatility": "VOLATILE" },
        { "name": "x-csrf-token", "volatility": "VOLATILE" }
      ],
      "local_storage": "ALL",
      "session_storage": "ALL"
    },
    "custom_extractions": [
      {
        "key": "wd_all_cookies",
        "type": "js_eval",
        "expression": "document.cookie",
        "extract_on_url": "*/automationanywhere3/*"
      }
    ]
  },
  "browser_policy": {
    "clipboard": false,
    "downloads": false,
    "file_chooser": false
  },
  "notification_config": {},
  "credential_ref_default": "manual:",
  "idle_shutdown_seconds": 3600
}
```

**Workday changes summary:**

- Removed: `click [data-testid="username"]` (fragile, user does this via VNC)
- Added: Login validation (`wait_for_url **/home.htmld`**)
- `keepalive_config`, `export_policy`, `browser_policy` unchanged
- No post-login automation needed (Workday doesn't have a Quotes equivalent)

