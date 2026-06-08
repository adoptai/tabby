# Updating AA Tabby App Templates

## Background

During the initial Tabby setup for Automation Anywhere, the Salesforce and Workday app templates were registered using test/internal URLs to validate the end-to-end integration. Before building your real solution on top of Tabby, these templates must be updated with your production Salesforce and Workday URLs, domains, and tenant values.

> **Please wait for Adopt confirmation before updating these templates.** We are finalizing a small fix to ensure that template updates propagate correctly to all derived applications and service profiles. Once confirmed, updating a template will automatically push changes to all applications created from it.

---

## Authentication

### Placeholders

```
TABBY_URL=<TABBY_URL>
TABBY_ADMIN_EMAIL=<TABBY_ADMIN_EMAIL>
TABBY_ADMIN_PASSWORD=<TABBY_ADMIN_PASSWORD>
TABBY_AUTH_TOKEN=<TABBY_AUTH_TOKEN>
```

The bootstrap admin credentials are stored in the deployment values/secrets — Sukh can provide them.

### Swagger UI

Open `<TABBY_URL>/api/docs`, click **Authorize**, and paste the auth token.

### Login via curl

```bash
curl -X POST <TABBY_URL>/login \
  -H 'Content-Type: application/json' \
  -d '{"email": "<TABBY_ADMIN_EMAIL>", "password": "<TABBY_ADMIN_PASSWORD>"}'
```

Response:

```json
{"token": "eyJ...", "expires_at": "..."}
```

Use the returned `token` as `Authorization: Bearer <TABBY_AUTH_TOKEN>` in all subsequent requests.

---

## List App Templates

```bash
curl -X GET '<TABBY_URL>/admin/app-templates?tenant_id=705a8fc0-179a-439d-bbd3-b8708e0106a1' \
  -H 'Authorization: Bearer <TABBY_AUTH_TOKEN>'
```

Current AA templates:


| Name                   | Profile Pattern    |
| ---------------------- | ------------------ |
| Salesforce QAS Sandbox | `salesforce-aa`    |
| Workday Human-assisted | `workday-aa-adopt` |


---

## Update a Template

**Route:** `PUT /admin/app-templates/:id`

The template ID goes in the URL path, **not** in the request body.

### Steps

1. **GET** the template by ID to retrieve the full current payload.
2. **Copy** the response body.
3. **Remove these server-managed fields** (they must not be sent back):
  - `id`
  - `tenant_id`
  - `created_at`
  - `updated_at`
4. **Update** the fields listed in the sections below.
5. **PUT** the modified payload:

```bash
curl -X PUT <TABBY_URL>/admin/app-templates/<TEMPLATE_ID> \
  -H 'Authorization: Bearer <TABBY_AUTH_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '@updated-template.json'
```

---

## Salesforce — Fields to Update

Replace all occurrences of the test Salesforce instance with your real values:


| Field / Location                                  | What to change                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `login_config.login_url`                          | Your Salesforce login URL                                                                                                |
| `login_config.steps[].url` (goto step)            | Same login URL                                                                                                           |
| `keepalive_config.health_checks[].url`            | Your instance's `/lightning/page/home` URL                                                                               |
| `keepalive_config.actions[].expression`           | Update fetch path if your instance differs                                                                               |
| `export_policy.target_domains`                    | Your Salesforce domains (e.g., `yourorg.my.salesforce.com`, `yourorg.lightning.force.com`, `yourorg--sbqq.vf.force.com`) |
| `export_policy.extract_urls`                      | Update the VF page URL with your instance                                                                                |
| `export_policy.credential_types.cookies[].domain` | Update if your cookie domain differs from `.salesforce.com`                                                              |


All placeholders matching `YOUR_INSTANCE` in the current template must be replaced with your actual Salesforce org identifier.

### Fragile Selector Warning

The current Salesforce template includes `fill` steps targeting `input#username` and `input#password`. These selectors were based on the environment available during setup and **may not work** in your production Salesforce org. If these steps fail, the session will get stuck before the human operator can log in via VNC.

**Recommended:** simplify the login steps to navigate to the login page and immediately request human input. Remove any `click` or `fill` steps targeting Salesforce form selectors.

### Simplified Salesforce Login Steps

> **Note:** This only shows the `login_config` section. Include the rest of the template payload (`keepalive_config`, `export_policy`, `browser_policy`, etc.) in the PUT request — otherwise those fields will be overwritten with defaults.

```jsonc
{
  "name": "...",
  "profile_name_pattern": "...",
  // ... keep all other fields from the original template ...

  "login_config": {
    "login_url": "https://YOUR_SALESFORCE_LOGIN_URL/",
    "credential_ref": "manual:",
    "steps": [
      {
        "action": "goto",
        "url": "https://YOUR_SALESFORCE_LOGIN_URL/"
      },
      {
        "label": "Log into Salesforce via VNC stream, then click Mark as Resolved",
        "action": "request_human_input",
        "input_type": "confirm",
        "timeout_ms": 1200000
      },
      {
        "label": "Navigate to any quote page in VNC. The quote must have products configured, then click Mark as Resolved",
        "action": "request_human_input",
        "input_type": "confirm",
        "timeout_ms": 1200000
      },
      {
        "action": "evaluate",
        "expression": "(function(){ var m = window.location.href.match(/SBQQ__Quote__c\\/([a-zA-Z0-9]{15,18})/); return m ? m[1] : ''; })()",
        "store_as": "quote_id"
      }
    ]
  },

  // ... keepalive_config, export_policy, browser_policy, etc. ...
}
```

---

## Workday — Fields to Update


| Placeholder               | Description                      | Example Locations                                                                                                                      |
| ------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKDAY_IDENTITY_DOMAIN` | Your Workday identity/SSO domain | `login_config.login_url`, `login_config.steps[].url`, `export_policy.target_domains`                                                   |
| `WORKDAY_MAIN_DOMAIN`     | Your Workday application domain  | `keepalive_config.actions[].url`, `keepalive_config.health_checks[].url`, `export_policy.target_domains`, `export_policy.extract_urls` |
| `TENANT`                  | Your Workday tenant ID           | All URLs containing `/TENANT/`                                                                                                         |


### Fragile Selector Warning

The current Workday template includes a `click` step targeting `[data-testid="username"]`. This selector was based on the environment available during setup and **may not work** in your production Workday. If this step fails, the session will get stuck before the human operator can log in via VNC.

**Recommended:** simplify the login steps to go directly to the login page and immediately request human input. Remove any `click` or `fill` steps targeting Workday form selectors.

### Simplified Workday Login Steps

> **Note:** This only shows the `login_config` section. Include the rest of the template payload (`keepalive_config`, `export_policy`, `browser_policy`, etc.) in the PUT request — otherwise those fields will be overwritten with defaults.

```jsonc
{
  "name": "...",
  "profile_name_pattern": "...",
  // ... keep all other fields from the original template ...

  "login_config": {
    "login_url": "https://WORKDAY_IDENTITY_DOMAIN/wday/authgwy/TENANT/upc/login",
    "credential_ref": "manual:",
    "steps": [
      {
        "action": "goto",
        "url": "https://WORKDAY_IDENTITY_DOMAIN/wday/authgwy/TENANT/upc/login"
      },
      {
        "label": "Log into Workday via VNC stream, then click Mark as Resolved",
        "action": "request_human_input",
        "input_type": "confirm",
        "timeout_ms": 1200000
      }
    ]
  },

  // ... keepalive_config, export_policy, browser_policy, etc. ...
}
```

This approach lets the human operator handle the full login flow via VNC without relying on any page-specific selectors.

---

## How Propagation Works (After Fix)

When you update a template via `PUT /admin/app-templates/:id`, Tabby automatically:

1. Updates the following fields on **all applications** derived from that template:
  - `login_config`, `keepalive_config`, `export_policy`, `browser_policy`, `notification_config`, `execute_enabled`
2. For each application's **active service profiles**, compares `login_config`, `credential_types`, and `target_domains`. If any changed:
  - Retires the old profile
  - Creates a new profile version with the updated config

**Not propagated** (change these directly on individual applications if needed): `name`, `profile_name_pattern`, `credential_ref_default`, `idle_shutdown_seconds`.

---

## Validation Checklist

After updating each template (once Adopt confirms propagation is ready):

- `GET /admin/app-templates/:id` — confirm the template reflects your new URLs/domains
- Check derived applications — verify `login_config`, `export_policy`, `keepalive_config` were updated
- Check service profiles — verify new profile versions were created with updated `target_domains` and `credential_types`
- Create a test session from the updated application and confirm:
  - Login page loads correctly
  - VNC stream works
  - Human input flow completes
  - Credential extraction returns values from the correct domains

