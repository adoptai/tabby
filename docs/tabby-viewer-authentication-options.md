# Tabby Viewer Authentication — Architecture Analysis & Options

## 1. Executive Summary

The client perceives two redundant login steps when using Tabby via MCP:

1. **Viewer login** — opening the viewer link requires authenticating in the platform (Frontegg), because MCP users have a machine token but no browser session.
2. **Target app login** — inside the remote Chromium, the user must log into Salesforce/Workday from scratch (custom domain, username, password, OTP).

These are **fundamentally different problems** with different solutions.

**Viewer login (problem 1):** The user authenticates via MCP using `client_id`/`client_secret`, which gives them a valid platform token. But the viewer link opens in a browser where they have no Frontegg session — so the platform redirects them to login. This is not a bug: the platform cannot trust that the person clicking the link is the same person who holds the machine token. The Frontegg login is the identity proof. This is inherent to any OAuth system — even Grafana would require a browser login if you tried to open it from a context with no SSO cookie.

**Target app login (problem 2):** Each worker pod starts with a completely clean browser — no cookies, no localStorage, no session state. The login DSL runs from scratch every time. The industry-standard solution is `storageState` persistence (Playwright built-in): serialize cookies + localStorage after one successful login, replay them on subsequent sessions. Salesforce also has `frontdoor.jsp` which can create a browser session from an OAuth access token.

**Token exchange (RFC 8693):** The token exchange is architecturally correct and invisible to the user. It is not the cause of any friction. Even if Tabby had a full frontend with its own OAuth flow, the underlying flow would be the same — just hidden behind a browser redirect instead of a server-side API call.

**Recommended approach:**
- **Short term:** Accept that MCP users will see one Frontegg login when opening the viewer (this is the identity proof). Focus on `storageState` persistence and Salesforce `frontdoor.jsp` to reduce target app re-login.
- **Medium term:** `storageState` seeding from extracted artifacts + health-check-first startup to skip login DSL when cookies are still valid.
- **Long term:** PVC-backed browser profiles + warm session pool for near-zero friction.

---

## 2. Current Flow — End to End

### The MCP path (the actual client scenario)

| # | What happens | Where | Token/Auth | Who validates |
|---|---|---|---|---|
| 1 | MCP calls platform with `requires_tabby: true` | `conversation.py:create_direct_signal_message()` (line 622) | Machine token (client_id/secret → Frontegg JWT) | Platform (JWTBearer) |
| 2 | Platform exchanges Frontegg JWT → Tabby JWT | `tabby_resolution_service.py:_get_tabby_token()` (line 433) → `POST /auth/token-exchange` | Input: Frontegg machine JWT (RS256). Output: Tabby `federated` JWT (HS256) | Tabby validates via JWKS |
| 3 | Platform requests credentials | `POST /credentials/request` | Tabby federated JWT | Tabby `JwtAuthGuard` |
| 4 | Session not healthy → HITL needed | `tabby_resolution_service.py` (line 752) | — | — |
| 5 | Platform resolves human user from machine token | `_resolve_human_user_id()` reads `createdByUserId` from Frontegg machine JWT | — | — |
| 6 | Platform creates one-time grant | `vnc_grant` UUID in Redis (600s TTL) with `user_id`, `session_id`, `stream_token` | — | — |
| 7 | Platform builds viewer URL | `{frontend_base_url}/tabby-viewer/{sessionId}?grant={grantId}` | — | — |
| 8 | MCP shapes response for LLM | `python-mcp:_shape_tabby_hitl()` — prefers platform URL, adds `?from=mcp` | — | — |
| 9 | LLM tells user to open the link | User sees: "Open the viewer: https://app.adopt.ai/tabby-viewer/..." | — | — |
| 10 | **User opens link in browser — NO Frontegg session** | `TabbyViewerPage.jsx` calls `POST /v1/tabby-viewer/validate-grant` | **401 — no Frontegg cookie** | Platform |
| 11 | **Redirect to Frontegg login** | `loginWithRedirect()` (cloud) or `/token-login` (on-prem/CE) | — | Frontegg |
| 12 | User logs into Frontegg | Standard Frontegg login flow | — | Frontegg |
| 13 | Redirect back to viewer with grant | `/tabby-viewer/{sessionId}?grant={grantId}` | Valid Frontegg session | Platform |
| 14 | Grant validated, viewer session created | `validate_grant` matches `user_id` against Frontegg user, deletes grant, sets `tabby_viewer_session` cookie (1h) | — | Platform |
| 15 | VNC/CDP WebSocket proxied | `wss://{platform}/v1/tabby-viewer/ws/{sessionId}` → `{TABBY_URL}/vnc-ws` | Platform cookie → Tabby stream token | Platform proxy |
| 16 | **User sees remote Chromium — must log into Salesforce** | Cold browser: custom domain → username → password → OTP | Target app credentials | Salesforce |
| 17 | Worker extracts credentials after login | `artifact-extractor.ts` → encrypted → MinIO | `TENANT_ENCRYPTION_KEY` | — |
| 18 | Platform retrieves credentials | `POST /credentials/request` | Tabby federated JWT (cached 3500s) | Tabby API |

### Key observations

1. **Step 10-12 is the "first login"** — the Frontegg login. This happens because MCP users have no browser session. The platform correctly requires identity proof before granting access to a live browser session.

2. **Step 16 is the "second login"** — the target app login. This happens because the remote Chromium starts completely clean. There is no mechanism to carry over the user's local browser session to the remote pod.

3. **The token exchange (step 2) is invisible** — the user never sees it. It's a server-side API call cached for 3500s. It is not a source of friction.

---

## 3. Why Token Exchange Exists

### What enters and exits

| | Input token | Output token |
|---|---|---|
| **Issuer** | External IdP (Frontegg: `https://{tenant}.frontegg.com`) | Tabby (`JWT_SIGNING_KEY`, HS256) |
| **Audience** | Platform application (`audience` on `identity_providers` table) | Tabby API (implicit) |
| **Subject** | External user ID (from configurable `user_id_claim`) | `federated:{ownerUserId}` |
| **Signing** | RS256/ES256 (IdP private key) | HS256 (`JWT_SIGNING_KEY`) |
| **TTL** | Set by IdP (typically 1h for Frontegg) | 300-3600s (requested, max 3600) |
| **Claims preserved** | `owner_user_id`, `tenant_id`, `email` | + `role` (mapped), `idp_id`, `token_type=federated`, `allowed_profiles` |

### Why Tabby doesn't just accept the platform JWT directly

1. **Audience isolation (RFC 8693 §2.1).** The Frontegg JWT is issued for the platform, not for Tabby. A JWT leaked from any platform component would grant Tabby access. The exchange creates a scoped credential.

2. **Claims mapping.** Tabby needs `tenant_id` and `owner_user_id` in specific positions. Different IdPs (Frontegg, Okta, Azure AD) use different claim names. The `tenant_id_claim`/`user_id_claim` config handles this.

3. **Role mapping.** Tabby has its own role model (Admin/Editor/Operator/Viewer/Agent). External roles are mapped via `role_claim` + `admin_role_values`/`editor_role_values`/`admin_domains`.

4. **Deployment independence.** Tabby operates standalone, with Frontegg, with Okta, with Azure AD, or with any OIDC-compliant IdP. Direct JWT acceptance would hard-couple Tabby to one IdP's format.

5. **Token lifecycle.** Tabby can revoke its own tokens via Redis blacklist. External tokens cannot be revoked from within Tabby — `JwtStrategy` skips the blacklist check for external JWTs (`jti=null`).

6. **`allowed_profiles` scoping.** Agent tokens carry `allowed_profiles` to restrict which Tabby profiles an API client can access. External JWTs don't carry this claim.

### Is this the correct pattern?

**Yes.** This follows RFC 8693 (OAuth 2.0 Token Exchange). The specification exists precisely for this scenario: a client holds a token from one security domain and needs to obtain a token for a different security domain.

Even if Tabby had a full frontend with an Authorization Code flow (like Grafana), the underlying mechanism would be the same — the IdP would issue a code, Tabby would exchange it for tokens, and Tabby would create its own session. The only difference is that Grafana hides this behind browser redirects, while Tabby does it via a server-side API call. The result is identical.

**The person who questioned why Tabby has an "independent login with its own identity" is describing standard OAuth Resource Server architecture.** Every service that accepts external authentication (Grafana, Jira, Slack, GitHub) has its own identity plane. The exchange is how identity flows between domains.

### Could the exchange be eliminated?

Technically yes — `JwtStrategy` already validates external IdP JWTs directly when `iss` matches a configured IdP. But this loses:
- Token revocation capability
- `allowed_profiles` scoping
- Short-lived tokens (external JWTs are typically 1h)
- Role mapping flexibility

**The exchange is not the problem.** It's invisible, cached (3500s), and provides real security benefits.

---

## 4. Comparison with Grafana / Standard OAuth

### What Grafana does

1. User visits Grafana URL in browser
2. No Grafana session → redirects to IdP (Okta, Azure AD, Frontegg)
3. If IdP SSO cookie exists → automatic authentication (no login screen)
4. If no SSO cookie → IdP shows login page
5. IdP redirects back to Grafana with authorization code
6. Grafana exchanges code for tokens server-side
7. Grafana creates its own session cookie

**Grafana also performs a token exchange** — it just does it via the Authorization Code flow. The "seamless" experience happens because the IdP SSO cookie is present in the user's browser.

### Why Tabby feels different

| Aspect | Grafana | Tabby (via MCP) |
|---|---|---|
| How user arrives | Types URL in browser (has IdP cookie) | Clicks link from MCP output (no platform cookie) |
| Token exchange | Authorization Code flow (browser redirect) | Server-side `POST /auth/token-exchange` (API call) |
| User sees login? | Only if no IdP SSO cookie | Always — MCP user has no browser session |
| Could be seamless? | Yes, if SSO cookie present | Only if user were already logged into the platform in the same browser |

**The difference is not architectural — it's about context.** Grafana users navigate to it from a browser where they already have an IdP session. MCP users receive a link in a context (CLI, chat, API response) that has no browser session. Any OAuth-protected application would require login in this scenario.

### What a Tabby frontend would change

If Tabby had its own frontend with a proper Authorization Code flow:
- User opens Tabby URL → redirects to IdP → logs in → redirects back → session created
- This is **the exact same number of logins** as the current flow
- The only difference: the redirect happens at Tabby's URL instead of the platform's URL
- If the user had an IdP SSO cookie, they'd skip the login — but MCP users don't have one

**A Tabby frontend would not solve the problem.** The Frontegg login the client sees is the identity proof. It would just move to a different URL.

---

## 5. Options to Eliminate/Reduce Viewer Login

### The core constraint

MCP users authenticate via `client_id`/`client_secret`. This gives them a machine token — it does NOT create a browser session. When they click the viewer link, the browser has no authentication context. The platform must verify that the person clicking the link is the authorized user.

### Option A — Accept the Frontegg login as the identity proof

**This is the current behavior and it is correct.** The Frontegg login is not redundant — it proves that the person opening the browser session is the person authorized to access it. Without it, anyone with the URL could access the live remote browser.

After the first login:
- The Frontegg session cookie persists (typically 24h)
- Subsequent viewer links in the same browser open without login
- The friction is only on the first link per browser session

**Improvement:** Document this clearly for the client. The first login is a security requirement, not a bug. Subsequent links are seamless.

### Option B — Self-authenticating viewer link (signed URL)

Replace the `vnc_grant` UUID with a cryptographically signed, short-lived URL that carries authentication without requiring a Frontegg session.

**How it would work:**
1. Platform generates a signed URL: `/tabby-viewer/{sessionId}?token={signed_jwt}`
2. The signed JWT contains: `user_id`, `org_id`, `session_id`, `exp` (5-10 min)
3. Viewer backend validates the signature directly — no Frontegg session needed
4. Sets `tabby_viewer_session` cookie on success

**Security trade-offs:**
- The URL itself becomes a bearer credential — anyone with the URL can access the session during TTL
- One-time use (delete after validation) mitigates replay but not real-time sharing
- URL could leak via clipboard, chat logs, browser history, referrer headers
- No proof that the person clicking is the authorized user

**Risk assessment:** Medium. The current grant mechanism already has similar properties (UUID is a bearer credential), but it additionally requires Frontegg user match. Removing the user match weakens the security model.

**Effort:** Low — modify `validate_grant` to accept a signed JWT alternative and skip Frontegg auth.

**Recommendation:** Viable for environments where the URL delivery channel is trusted (e.g., encrypted chat, enterprise MCP). Not recommended as the default — should be opt-in per tenant.

### Option C — Platform pre-authenticates the viewer session

**How it would work:**
1. When the platform builds the HITL response, it also creates the `tabby_viewer_session` server-side
2. Returns the viewer URL with a one-time session-bootstrap token
3. The viewer page exchanges the bootstrap token for the session cookie without Frontegg
4. The trust anchor shifts from "Frontegg verifies the user" to "the platform already verified the user via the machine token"

**Security model change:** Instead of proving identity at the browser (Frontegg login), identity was already proven at the API level (machine token → `_resolve_human_user_id()` → `createdByUserId`). The bootstrap token bridges this.

**Risk:** The `createdByUserId` in the machine token identifies who created the API key, not necessarily who is using it right now. If the API key is shared within a team, any team member could open the link. This is acceptable if the client treats API keys as personal credentials.

**Effort:** Medium — new endpoint, token format, viewer-side handling.

### Option D — Extend grant to carry embedded authentication

Combine the grant UUID with a short-lived JWT that the viewer can validate without calling Frontegg:

1. Grant stored in Redis (as today) but also includes a signed `viewer_auth_token`
2. `validate-grant` accepts either Frontegg session OR the embedded JWT
3. The embedded JWT is single-use (deleted from Redis on first validation)

**This is essentially Option B with the existing grant infrastructure.**

**Effort:** Low-medium.

### Recommendation for viewer login

**The Frontegg login is the correct behavior** for the general case. For MCP-specific scenarios where the delivery channel is trusted:
- Implement Option B or D as an opt-in feature (`allow_direct_viewer_access` on tenant config)
- Document that the first viewer access per browser session requires Frontegg login
- After that, subsequent links are seamless (Frontegg cookie persists)

---

## 6. Options to Reduce Login Inside Remote Chromium

This is the more impactful problem. The client doesn't want to go through the full Salesforce login flow (custom domain → username → password → OTP) every time.

### Current state

- Worker calls `browser.newContext()` with no `userDataDir` — completely clean browser every time
- `chromium.launch()` uses `CHROMIUM_FLAGS` with no `--user-data-dir`
- Pod volumes: only `emptyDir: {}` at `/tmp` — nothing persists
- `restartPolicy: Never` — crashed pods are replaced, not restarted
- Full login DSL runs on every new session
- `seed_cookies` exists for recording mode only (not general sessions)
- Idle shutdown scales `desired_session_count` to 0 after inactivity

### Option 6.1 — `storageState` persistence (industry standard)

**This is what Browserbase, Browserless, Skyvern, and every production browser automation platform does.**

Playwright has built-in support for serializing and replaying browser state:

```typescript
// After successful login — save state
const state = await context.storageState();
// Save to MinIO/Redis keyed by {tenantId}:{appId}:{userId}

// On next session — restore state
const context = await browser.newContext({ storageState: savedState });
```

`storageState` captures: all cookies (including HttpOnly), localStorage, and sessionStorage. It's a JSON file that can be stored encrypted in MinIO (where Tabby already stores artifact bundles).

**Changes needed:**
- Worker: after successful login + health check, call `context.storageState()` and upload to MinIO
- Worker: on startup, fetch the latest storageState for this app/user combo
- Worker: inject via `browser.newContext({ storageState })` before first navigation
- Worker: run health predicates first — if PASS, skip login DSL entirely
- Worker: if health check fails after state injection (expired cookies), fall back to full login DSL
- Worker: on fallback login, re-save fresh storageState

**Partial infrastructure exists:** `seed_cookies` in `login_config` already uses `context.addCookies()` for recording sessions. `storageState` is more comprehensive (includes localStorage/sessionStorage).

**What it solves:**
- Returning users skip the full login flow if cookies are still valid
- Works across pod restarts (state stored externally)
- Handles "remember this device" MFA cookies — complete MFA once, device trust cookie is part of storageState

**What it doesn't solve:**
- First login still requires HITL
- Expired sessions (depends on target app cookie TTL — Salesforce: ~12h, Workday: 30-60min)
- IP-binding: some orgs configure Salesforce to bind sessions to originating IP. If pod IP changes, session is invalidated

**MFA implications:** If the user completes MFA with "Remember this device" checked, the device trust cookie is captured in storageState and replayed. This means MFA is only required once — subsequent sessions use the trusted device cookie. This is the most impactful improvement for the client's workflow.

**Effort:** Medium (1-2 weeks). Core infrastructure exists (MinIO encrypted storage, cookie injection).

**Security:** Low additional risk — cookies are already extracted and stored encrypted. storageState reuse doesn't create new exposure.

### Option 6.2 — Salesforce `frontdoor.jsp` (Salesforce-specific)

Salesforce has a documented mechanism to create a browser session from an OAuth access token:

```
GET https://{instance}.salesforce.com/secur/frontdoor.jsp?sid={access_token}&retURL=/
```

The newer **Single Access API** generates a one-time-use frontdoor URL with 1-minute TTL (avoids raw token in URL).

**Requirements:**
- Connected App in Salesforce with `web` or `full` scope
- OAuth refresh token for the target user (stored by the client or the platform)
- The `instance_url` from the token response (must match the Salesforce org's instance)

**MFA behavior:** `frontdoor.jsp` creates a standard session. If the org enforces "High Assurance Session Required at Login" at the Profile level, Salesforce will prompt for MFA after the redirect. If MFA is delegated to SSO (IdP handles it), or if the session level requirement is not at-login, frontdoor skips it.

**How it fits into Tabby:**
1. Client provisions a Connected App and provides refresh tokens to the platform
2. Platform stores refresh tokens (encrypted) per user/org
3. When creating a Tabby session, platform passes the access token to Tabby
4. Tabby worker navigates to `frontdoor.jsp?sid=...` instead of running login DSL
5. Health check runs — if PASS, session is ready

**Effort:** Medium — requires client-side Connected App setup, refresh token storage, and a new DSL step type (`salesforce_frontdoor` or similar).

**Limitation:** Salesforce-specific. No equivalent exists for Workday.

### Option 6.3 — PVC-backed browser profiles

Mount a PersistentVolumeClaim to the worker pod with the Chromium user data directory.

**Changes:**
- Worker: `chromium.launchPersistentContext('/data/profile')` instead of `browser.newContext()`
- Controller/Helm: add PVC per user/app combo, mount into worker pod
- Health-check-first startup: if profile has valid cookies, skip login DSL

**Advantages over storageState:**
- Preserves everything: cookies, localStorage, sessionStorage, IndexedDB, service workers, cache
- More resilient to target apps that use complex state (not just cookies)
- Survives pod restarts without external state management

**Disadvantages:**
- PVC lifecycle management (creation, cleanup on app deletion, storage costs)
- Can't share profiles across nodes without ReadWriteMany storage class
- Locks the session to one pod at a time

**Effort:** Medium-high (2-3 weeks).

### Option 6.4 — Warm session pool

Keep authenticated sessions running before the user needs them.

**How it would work:**
- Platform tells Tabby to maintain warm sessions per user/app combo
- Sessions run through the full login DSL (including HITL if needed) proactively
- When credentials are requested, the session is already healthy
- Keepalive DSL maintains target app session validity

**`prewarm_tabby_sessions()` already exists** in the platform but only provisions (scales `desired_session_count` to 1) — doesn't complete the login.

**Effort:** High (4+ weeks). Requires idle-shutdown exemptions, resource budgeting, and potentially demand prediction.

**Cost:** Chromium pods running 24/7 per user/app combo.

### Option 6.5 — Extend session lifetime (configuration only)

- Increase `idle_shutdown_seconds` per app template (keep sessions alive longer)
- Increase `MAX_SESSION_AGE_HOURS` (default 24h → 48-72h)
- Configure keepalive DSL to perform real interactions that refresh target app sessions (not just screenshots)
- Use `refresh_interval_seconds: 120` for volatile tokens

**Effort:** Low (configuration change, no code).

**Impact:** Reduces frequency of re-login but doesn't eliminate cold starts.

### Option 6.6 — Credential auto-fill (existing mechanism)

Already implemented via `k8s:secret/{name}` credential type:
- Worker mounts K8s Secret with `username`/`password` files
- DSL uses `${USERNAME}` and `${PASSWORD}` placeholders in `fill` steps
- Login runs automatically without HITL for username/password

**Limitation:** MFA/OTP/CAPTCHA still requires HITL.

**Combined with storageState:** Auto-fill handles username/password, storageState "remember this device" cookie handles MFA after first completion. The user only does full HITL once — subsequent sessions are fully automated.

### Comparison matrix

| Option | Eliminates first login? | Eliminates re-login? | Handles MFA? | Effort | Risk |
|---|---|---|---|---|---|
| 6.1 storageState | No | Yes (if cookies valid) | Yes ("remember device" cookie) | Medium | Low |
| 6.2 frontdoor.jsp | No (requires OAuth setup) | Yes (Salesforce only) | Depends on org config | Medium | Low |
| 6.3 PVC profiles | No | Yes (more durable) | Yes | Medium-high | Medium |
| 6.4 Warm pool | Yes (session pre-warmed) | Yes | Yes (if pre-warmed with HITL) | High | Medium |
| 6.5 Extend lifetime | No | Reduces frequency | No | Low | Low |
| 6.6 Auto-fill | Partially (user/pass only) | Yes (user/pass only) | No | Low | Low |

### Recommended combination

**6.1 (storageState) + 6.6 (auto-fill) + 6.5 (extended lifetime):**
- Auto-fill handles username/password automatically
- StorageState captures "remember this device" cookie after first MFA
- Extended session lifetime reduces cold starts
- Result: user does full HITL once. Subsequent sessions either restore state automatically or auto-fill credentials. MFA prompt appears only when the device trust cookie expires (typically 30-90 days depending on target app).

---

## 7. Scenario Analysis

### 7.1 MCP user opens viewer link (the actual client scenario)

**Flow:** MCP token → platform builds viewer URL → user clicks → **Frontegg login required** → viewer opens → **target app login required**

**Viewer login:** Required. MCP has no browser session. After first login, Frontegg cookie persists for subsequent links.

**Target app login:** Required on cold start. With storageState persistence, only required when cookies expire.

### 7.2 User already logged into platform opens viewer

**Viewer login:** Not required. Grant validates against existing Frontegg session.

**Target app login:** Same as 7.1.

### 7.3 Link opened in different browser / incognito

**Viewer login:** Always required (different cookie context).

**Target app login:** Same as 7.1.

### 7.4 Software/webview opens viewer link

**Viewer login:** Required unless the software embeds a Frontegg-authenticated webview.

**Solution:** Option B (signed URL) allows bypassing Frontegg for trusted delivery channels.

### 7.5 Cloud vs. on-prem

**Cloud:** Platform-hosted viewer proxies all traffic. Tabby URL is internal.

**On-prem:** If Tabby runs standalone (no platform frontend), users hit Tabby's OAuth gate directly. This requires an OAuth IdP configured in Tabby's `identity_providers` table. If the client's IdP (Okta, Azure AD) is configured, and the user has an SSO session in the same browser, the viewer login is seamless.

### 7.6 Service account / machine-to-machine

**No viewer involved.** Service accounts call `POST /auth/service-token` → `POST /credentials/request`. No HITL, no viewer. The double-login issue doesn't apply.

---

## 8. Security Guarantees

### Non-negotiable

| Guarantee | Current mechanism | Can it be changed? |
|---|---|---|
| Viewer access requires identity proof | Frontegg login + grant validation | Can shift to signed URL (weaker) |
| Session ownership | `owner_user_id` match | No — fundamental |
| Organization scoping | `tenant_id` in all JWTs | No — fundamental |
| URL leak protection | One-time grant + user match | Weakened if signed URL used |
| Token expiration | Grant: 600s, viewer session: 1h | Can extend |
| Tenant isolation | JWT-scoped, validated on all API calls | No — fundamental |

### Current limitations (changeable)

| Limitation | Status | Solution |
|---|---|---|
| 600s grant TTL | Arbitrary | Extend to 1800s |
| No browser state persistence | Design choice | storageState / PVC |
| MCP user always sees Frontegg login | By design (no browser session) | Signed URL (trade-off) or accept |
| Short-link uses `Math.random` | Known issue | CSPRNG (pending) |
| Cold start = full login | By design | storageState + auto-fill |

---

## 9. Solutions Summary

### 9.1 Quick wins (days)

**Goal:** Reduce friction without architecture changes.

| Change | Impact | Effort |
|---|---|---|
| Extend `vnc_grant` TTL from 600s to 1800s | Prevents grant expiry between MCP response and user click | Hours |
| Configure `idle_shutdown_seconds` to 4-8h for high-value apps | Keeps sessions alive longer, reducing cold starts | Configuration |
| Set `refresh_interval_seconds: 120` for volatile-token apps | Keeps extracted credentials fresh | Configuration |
| Ensure credential auto-fill (`k8s:secret`) is configured | Automates username/password entry | Configuration |
| Document the auth flow for client | Sets expectations about first-login requirement | Hours |

**Eliminates viewer login?** No — MCP users still need one Frontegg login per browser session.
**Eliminates target app login?** No — but auto-fill reduces HITL to MFA-only.

### 9.2 Intermediate solution (1-3 weeks)

**Goal:** Dramatically reduce target app re-login frequency.

**Changes (in addition to 9.1):**
- Implement `storageState` persistence in the worker (serialize after login, restore on startup)
- Health-check-first startup: run health predicates before login DSL; skip DSL if cookies are valid
- Login-page detection: if restored state leads to login page, fall back to full DSL
- Store storageState in MinIO (encrypted, same infrastructure as artifact bundles)

**Eliminates viewer login?** No — same as 9.1.
**Eliminates target app login?** Yes, on subsequent sessions (if cookies + "remember device" cookie are valid). First login still requires HITL.
**MFA impact:** After first MFA completion with "remember this device", the device trust cookie is captured and replayed. MFA prompt doesn't appear again until the trust expires (30-90 days per target app policy).

### 9.3 Advanced solution (4-8 weeks)

**Goal:** Near-zero friction for returning users.

**Changes (in addition to 9.2):**
- PVC-backed browser profiles (Chromium user data directory survives pod restarts)
- Warm session pool (pre-provisioned, pre-authenticated sessions)
- Salesforce `frontdoor.jsp` integration (token → browser session, skipping DSL entirely)
- Optional: signed viewer URLs for MCP (eliminates Frontegg login for trusted channels)

**Eliminates viewer login?** Optionally (signed URL, trade-off).
**Eliminates target app login?** Mostly — PVC profiles + warm pool means first login only. frontdoor.jsp eliminates it for Salesforce when OAuth tokens are available.

### Comparison

| Dimension | Quick wins | Intermediate | Advanced |
|---|---|---|---|
| Effort | Days | 1-3 weeks | 4-8 weeks |
| Viewer login | Still required (MCP) | Still required | Optional (signed URL) |
| Target app first login | Required | Required | Required (or frontdoor) |
| Target app re-login | Every cold start | Skipped if cookies valid | Rarely (PVC + warm pool) |
| MFA frequency | Every session | Once per trust period | Once per trust period |
| Architecture changes | None | Worker startup logic | Worker, controller, Helm |
| Client changes needed | None | None | Connected App (Salesforce) |

---

## 10. Responsibilities

### Adopt

- storageState persistence (worker, MinIO storage, health-check-first startup)
- Session lifetime tuning (per-template configuration)
- Credential auto-fill configuration guidance
- Optional: signed viewer URLs for MCP scenarios
- Optional: Salesforce frontdoor.jsp integration
- Documentation for client IT teams

### Client

- Accept that first viewer access requires platform login (identity proof)
- Provision K8s Secrets for credential auto-fill
- Accept that MFA policies are set by the target app (Salesforce, Workday)
- If frontdoor.jsp: provision Connected App and provide OAuth refresh tokens
- If SSO: configure IdP federation with both the platform and target apps

### Shared

- IdP configuration for Tabby (audience, claims, role mapping)
- Session lifetime tuning (security vs. convenience trade-off)
- Target app cookie lifetime testing (how long does storageState remain valid?)

---

## 11. Recommendation

1. **Immediately:** Configure auto-fill, extend idle shutdown, extend grant TTL. Document the auth flow for the client. These are zero-risk configuration changes.

2. **Next sprint:** Implement `storageState` persistence. This is the highest-impact change for the client's workflow. After one successful login (with MFA), subsequent sessions restore the browser state automatically. Combined with auto-fill, the user only does HITL for the first session ever.

3. **When validated:** Evaluate Salesforce `frontdoor.jsp` if the client has OAuth refresh tokens available. This can eliminate even the first login for Salesforce.

4. **Do not remove the token exchange.** It's invisible, correct (RFC 8693), and provides real security benefits.

5. **Do not implement signed viewer URLs yet.** The Frontegg login is a one-time cost per browser session and provides genuine security. If the client pushes hard, offer it as an opt-in feature with documented trade-offs.

---

## 12. Talking Points for Meetings

### Why there are two logins

> There are two distinct security boundaries. The first login proves your identity to access the remote browser viewer — this is our security boundary, and we can't let anyone with a link access a live browser session containing corporate credentials. The second login authenticates to the target application inside the remote browser — that's Salesforce/Workday's security boundary, and we're working to minimize how often it appears.

### About the viewer login specifically (MCP scenario)

> When you use MCP, you authenticate via API credentials — but that's a machine-to-machine token. When the viewer link opens in your browser, we need to verify that the person clicking the link is actually you, not someone who intercepted the URL. That's what the platform login does. It's the same reason Grafana requires a login when you open its URL — the browser needs its own authentication context, separate from any API token.
>
> After you log in once, subsequent viewer links in the same browser session are seamless — no re-login needed. The friction is a one-time cost per browser session.

### About the target app login

> Today, each browser session starts completely clean — no saved passwords, no cookies, no session data. This is a deliberate security choice, but we recognize it creates friction.
>
> We're implementing browser state persistence: after you log into Salesforce once (including MFA), we'll save the browser state and restore it on subsequent sessions. If you checked "Remember this device" during MFA, that trust carries over too. The result: you do the full login flow once, and after that, subsequent sessions are automatic.

### About the token exchange question

> The token exchange follows RFC 8693 — it's the standard mechanism for passing identity between security domains. Every integrated service (Grafana, Jira, Slack) does this internally. In our case, it's a server-side API call that takes ~50ms and is cached for an hour. The user never sees it. It's not the source of any login friction.
>
> We could technically accept the platform JWT directly, but that would remove our ability to revoke access, scope permissions, and map roles independently. The exchange is architecturally correct and zero-cost to the user.

### What we can improve quickly vs. what takes time

> **Quick (days):** Auto-fill credentials, extend session lifetimes, extend link validity. These are configuration changes.
>
> **Medium (weeks):** Browser state persistence — save cookies and session data after login, restore on next session. This eliminates re-login for returning users including MFA (if "remember device" is used).
>
> **Long-term (months):** Pre-warmed sessions, Salesforce-specific OAuth integration, persistent browser profiles. These require architectural changes.

### What we can't and shouldn't change

> We cannot remove viewer authentication without an equivalent security mechanism. A leaked URL must not grant access to a live browser session. We can make it smoother (persistent session, signed URLs), but not absent.
>
> We cannot bypass the target application's MFA policy. If Salesforce requires MFA, that's their security configuration. What we can do is remember the MFA completion so it doesn't repeat.

---

## 13. Open Questions

1. **Has the client tried opening a second viewer link after the first Frontegg login?** The Frontegg session should persist — subsequent links should be seamless.

2. **What is the Salesforce session cookie TTL for this client's org?** This determines how effective storageState persistence will be.

3. **Does this client's Salesforce org enforce IP-bound sessions?** If yes, storageState won't work if pod IPs change.

4. **Does the client's Salesforce org have "High Assurance Session Required at Login"?** This determines whether frontdoor.jsp will bypass MFA.

5. **Does the client have OAuth refresh tokens for their Salesforce users?** Required for frontdoor.jsp integration.

6. **Is the client using "Remember this device" when completing MFA?** If not, they should — storageState will capture the device trust cookie.

7. **What is the acceptable session lifetime for warm pools?** Chromium pods running 24/7 have resource costs.

8. **Is this a cloud or on-prem deployment?** On-prem may not have the platform-hosted viewer.

---

## 14. Relevant Files and Routes

### Tabby (NestJS monorepo)

| File | Purpose |
|---|---|
| `apps/api/src/modules/auth/auth.controller.ts` | Token exchange, OAuth login/callback, service/agent token |
| `apps/api/src/modules/auth/token-exchange.service.ts` | OIDC JWT and agent assertion exchange |
| `apps/api/src/modules/auth/jwt.strategy.ts` | JWT validation — JWKS dispatch, external IdP routing |
| `apps/api/src/modules/auth/external-jwks.service.ts` | JWKS fetching, caching, key-to-PEM |
| `apps/api/src/modules/auth/oauth-provider.service.ts` | Browser OAuth, PKCE, code exchange |
| `apps/api/src/modules/streaming/streaming.controller.ts` | VNC/CDP viewer pages, auth gates, HITL endpoints (2022 lines) |
| `apps/api/src/modules/streaming/stream-token.service.ts` | Stream token generation/validation, short-link Redis |
| `apps/api/src/modules/streaming/vnc-ws-proxy.service.ts` | VNC WebSocket proxy with cookie enforcement |
| `apps/api/src/modules/streaming/cdp-ws-proxy.service.ts` | CDP WebSocket proxy with command allowlist |
| `apps/api/src/modules/credentials/credentials.service.ts` | Credential resolution with owner_user_id scoping |
| `apps/api/src/modules/sessions/sessions.controller.ts` | Session listing with role-based scoping |
| `apps/worker/src/main.ts` | Worker startup, browser launch, DSL execution, keepalive |
| `apps/worker/src/artifact-extractor.ts` | Cookie/header/custom extraction + AES-256-GCM encryption |
| `apps/worker/src/login-dsl-runner.ts` | Login DSL execution, `request_human_input` |
| `apps/worker/src/credential-resolver.ts` | K8s Secret credential loading |
| `apps/worker/src/keepalive-runner.ts` | Keepalive loop, re-extraction trigger, recycling monitor |
| `apps/controller/src/reconcile.service.ts` | Session lifecycle, idle shutdown, pod management |
| `apps/controller/src/pod-manager.service.ts` | Worker pod creation (volumes, env, services) |

### Platform (adoptwebui)

| File | Purpose |
|---|---|
| `backend/app/services/tabby_resolution_service.py` | Token exchange, credential resolution, HITL response, grant generation, `_resolve_human_user_id()` |
| `backend/app/routes/tabby_viewer.py` | Grant validation (`validate_grant`), viewer session cookie, WS proxy |
| `frontend/src/pages/tabbyViewer/TabbyViewerPage.jsx` | Viewer UI: grant exchange, 401→Frontegg redirect, VNC/CDP rendering |
| `frontend/src/pages/tokenLogin/TokenLoginPage.jsx` | On-prem/CE token login (extension-based) |
| `frontend/src/utils/tokenAuthUtils.js` | `isControlPlaneEnabled()`, `applyTokenSession()` |
| `backend/app/routes/conversation.py` | `create_direct_signal_message` — MCP entry point (line 622) |
| `backend/app/routes/end_user_conversation.py` | End-user conversation entry point |
| `backend/app/routes/action.py` | Action dispatch entry point |
| `backend/app/services/org_tabby_config_service.py` | Encrypted agent credentials for internal harness |

### python-mcp

| File | Purpose |
|---|---|
| `src/core/adopt_agent.py` | `_shape_tabby_hitl()` — prefers platform URL, adds `?from=mcp`, 25s delay |

### Documentation

| File | Purpose |
|---|---|
| `docs/tabby-platform-handoff.md` | Platform integration reference (entry points, Token Manager) |
| `docs/TECHNICAL_ARCHITECTURE_DESIGN.md` | Full architecture with Mermaid diagrams |
| `docs/FUNCTIONAL_OVERVIEW.md` | API surface, security model, DSL reference |
| `docs/ARCHITECTURE_DECISIONS.md` | 21 ADRs |
