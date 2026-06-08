# Tabby AA Testing Checklist

Short operational checklist to get Tabby ready for AA testing.

---

## 1. Enable Tabby Feature Flag

**Endpoint:** `POST https://<CUSTOMER_BACKEND_API_URL>/v1/org/features`

This must be the customer's **backend API URL** (e.g., `https://api.adopt.ai/v1/org/features` for prod).

**Payload:**

```json
{
    "feature_name": "tabby",
    "is_enabled": true,
    "org_id": "483d421e-12a7-4616-bbf5-86716cc995a9"
}
```

**Auth:** Admin JWT in `Authorization: Bearer` header.

**Verification:** Wait a few seconds after enabling, then **hard refresh** the platform UI (`Ctrl+Shift+R`). If "Tabby Credentials" appears in the Settings (click on your "photo") sidebar, the flag is active.

**Also check:** In the action's Deployment Rules UI, verify "Use Tabby for Credential Resolution" is toggled ON for the actions that should use Tabby. (I think that On prem deployments don't have access to Deployment Rules)

---

## 2. Register Tabby Callback URL in Frontegg

The Tabby VNC auth flow redirects through Frontegg. The callback URL must be registered or VNC login will fail.

```bash
# 1. Get Frontegg vendor token
VENDOR_TOKEN=$(curl -s -X POST https://api.frontegg.com/auth/vendor/ \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"ae925ccb-94e9-4967-8438-914e89651c32","secret":"3f7d54b8-0dbd-4bfa-a12b-e5559f6b5e71"}' \
  | jq -r '.token')

# 2. Register the Tabby callback URL
curl -s -X POST https://api.frontegg.com/oauth/resources/configurations/v1/redirect-uri \
  -H "Authorization: Bearer $VENDOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"redirectUri":"https://<TABBY_URL>/auth/oauth/callback"}'
```

Replace `<TABBY_URL>` with the actual AA Tabby deployment URL (no trailing slash).

---

## 3. Update Playground Profiles

Two profiles need updating:

- **Workday Tabby**
- **SFDC Tabby Test Adopt** (can be renamed to remove "test")

Update both with:


| Field         | Value                                                                 |
| ------------- | --------------------------------------------------------------------- |
| **Tabby URL** | `https://<AA_TABBY_URL>` (no trailing slash `/`in the end)            |
| **IDP ID**    | The UUID from the IDP registration in Tabby (Sukh saved this earlier) |


If the IDP ID is lost, fetch it: (Tabby Admin Token can be obtained login using the /login route)

```bash
curl -s https://<TABBY_URL>/admin/identity-providers \
  -H "Authorization: Bearer $TABBY_ADMIN_TOKEN" | jq '.[].id'
```

---

## 4. Cluster Capacity

Before testing, confirm the cluster has enough resources to schedule Tabby worker pods. Each session spawns a Chromium pod. If the cluster can't schedule pods, the flow will look broken even though config is correct.

---

## 5. Testing

After steps 1-4 are done, Tabby should be ready to test via MCP or Copilot.

Ridhi can share the Salesforce/Workday credentials and help with the actual testing flow.

---

## 6. Debugging — Where to Look

### Request flow

```
MCP / Copilot / Chrome Extension
  → Platform backend (adoptwebui)
      → Tabby API (/auth/token-exchange, /credentials/request, /agent/session-status)
        → Tabby Controller (creates worker pods)
          → Worker pod (Chromium + VNC)
```

### Platform backend logs

Look for these log patterns in the **adoptwebui backend** logs:


| Log pattern                                                      | What it means                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `[TABBY_TOKEN_CACHE] stored=True`                                | Token exchange succeeded, Tabby JWT cached                               |
| `[TABBY_BATCH] org=... requested=N resolved=N`                   | Token resolution started, N tokens being resolved                        |
| `HTTP Request: POST .../credentials/request "HTTP/1.1 404"`      | Session doesn't exist yet — auto-provisioning will kick in               |
| `HTTP Request: POST .../credentials/request "HTTP/1.1 200"`      | Credentials resolved successfully                                        |
| `Waiting for session to be ready (attempt N/50, state=STARTING)` | Pod is being created, polling for readiness                              |
| `HTTP Request: GET .../agent/session-status/... "HTTP/1.1 200"`  | Session status check succeeded                                           |
| `HTTP Request: POST .../short-link "HTTP/1.1 200"`               | VNC short-link generated (MCP path)                                      |
| `TABBY_URL env var not set`                                      | Platform doesn't know the Tabby URL — check Playground Profile           |
| `No Tabby profile found`                                         | No profile with Tabby configured for this org — check Playground Profile |


### Tabby-side logs


| Where                    | What to check                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Tabby API pod**        | Token exchange errors, credential request errors, session provisioning                                                    |
| **Tabby Controller pod** | Pod creation failures, reconciliation errors, state transitions (`STARTING → LOGIN_NEEDED → LOGIN_IN_PROGRESS → HEALTHY`) |
| **Worker pod**           | Chromium launch errors, DSL execution failures, extraction errors                                                         |


### Common issues


| Symptom                                                                                                                                              | Likely cause                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| No Tabby logs at all in platform                                                                                                                     | Feature flag not enabled, or deployment rules `use_tabby` not set |
| `401 No registered IdP for issuer` in Tabby logs                                                                                                     | IDP `issuer_url` doesn't match the JWT's `iss` claim              |
| VNC link opens but shows login wall -> you can use the email from the user as fallback(who trigger the action)                                       | Frontegg callback URL not registered (Step 2)                     |
| `warming_up` response, no VNC linkIf this happen because the worker took too much time to go up, try to execute the action again with the worker up | Worker pod still scheduling — check cluster capacity              |
| Credentials return empty                                                                                                                             | `TENANT_ENCRYPTION_KEY` mismatch between API and Worker pods      |
| MCP tool doesn't show `[Requires login]` label                                                                                                       | Deployment rule `use_tabby` not set, or MCP cache (wait 10 min)   |


