# Authentication & Role-Based Access Control

Tabby supports multiple authentication methods, each producing a JWT with a specific **role** that determines what the caller can do.

## Authentication Methods

### 1. Direct Login (`POST /login`)

Email/password login for human users registered in Tabby's internal user table. The role is read from the user record (set at creation time via `POST /users`).

The bootstrap admin (configured via `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` env vars) is created on first startup with role **Admin**.

```bash
curl -X POST /login \
  -d '{"email": "admin@example.com", "password": "..."}'
# Returns: { "token": "eyJ...", "expires_at": "..." }
```

### 2. Service Token (`POST /auth/service-token`)

Machine-to-machine authentication using a shared `client_id` / `client_secret` pair (configured via `SERVICE_AUTH_CLIENT_ID` and `SERVICE_AUTH_CLIENT_SECRET` env vars).

Role defaults to **Operator** (configurable via `SERVICE_AUTH_DEFAULT_ROLE` env var). The caller can request a specific role if it's in `SERVICE_AUTH_ALLOWED_ROLES`.

```bash
curl -X POST /auth/service-token \
  -d '{"client_id": "my-bot", "client_secret": "...", "tenant_id": "..."}'
```

### 3. Agent Token (`POST /auth/agent-token`)

OAuth 2.0 Client Credentials flow for AI agents. Uses agent client credentials registered via `POST /admin/agent-clients`. Always produces role **Agent** with scoped `allowed_profiles`.

```bash
curl -X POST /auth/agent-token \
  -d '{"grant_type": "client_credentials", "client_id": "agent_...", "client_secret": "secret_..."}'
```

### 4. Token Exchange (`POST /auth/token-exchange`)

RFC 8693-inspired exchange that converts an external JWT into a Tabby-scoped JWT. Two modes:

**`oidc_jwt`** — Exchange an external IdP JWT (e.g., Okta, Azure AD, Frontegg) for a Tabby JWT. The role is determined by the IdP's role mapping configuration (see [Identity Provider Configuration](#identity-provider-configuration) below).

```bash
curl -X POST /auth/token-exchange \
  -d '{"subject_token": "<external-jwt>", "subject_token_type": "oidc_jwt"}'
```

**`agent_assertion`** — An agent exchanges its agent token on behalf of a specific user. Produces a user-scoped JWT with `owner_user_id` set to the target user. Role inherits from the agent token (Agent).

```bash
curl -X POST /auth/token-exchange \
  -d '{"subject_token": "<agent-jwt>", "subject_token_type": "agent_assertion", "target_user_id": "user@example.com"}'
```

### 5. Browser OAuth Flow (`GET /auth/oauth/{idpId}/login`)

Redirect-based OAuth 2.0 Authorization Code + PKCE flow for browser sessions. Used by the admin UI and VNC viewer. Role determined by the same IdP role mapping as token exchange.

## Roles

Five roles, from most to least privileged:

| Role | Intended for | How to get it |
|---|---|---|
| **Admin** | Tabby operators, direct login | `POST /login`, `admin_domains` match, or `admin_role_values` match |
| **Editor** | Platform admins (via external IdP) | Token exchange with `editor_role_values` match |
| **Operator** | Service bots, integrations | Service token (default role) |
| **Viewer** | Read-only users | Token exchange default role, or set on user creation |
| **Agent** | AI agents with profile-scoped access | Agent token, agent_assertion exchange |

## Permissions by Role

### System Management

| Action | Admin | Editor | Operator | Viewer | Agent |
|---|---|---|---|---|---|
| List/view tenants | ✅ all | own only | ❌ | ❌ | ❌ |
| Create tenant | ✅ any | own only | ❌ | ❌ | ❌ |
| Update/delete tenant | ✅ | ❌ | ❌ | ❌ | ❌ |
| Manage users | ✅ | ❌ | ❌ | ❌ | ❌ |
| Manage identity providers | ✅ | ❌ | ❌ | ❌ | ❌ |
| Manage agent clients | ✅ | ❌ | ❌ | ❌ | ❌ |

### App Templates

| Action | Admin | Editor | Operator | Viewer | Agent |
|---|---|---|---|---|---|
| Create | ✅ any tenant | ✅ own tenant | ✅ own tenant | read only | ❌ |
| Read | ✅ any tenant | ✅ own tenant | ✅ own tenant | ✅ own tenant | ❌ |
| Update (PUT/PATCH) | ✅ any tenant | ✅ own tenant | ❌ | ❌ | ❌ |
| Delete | ✅ any tenant | ✅ own tenant | ❌ | ❌ | ❌ |

### Applications

| Action | Admin | Editor | Operator | Viewer | Agent |
|---|---|---|---|---|---|
| Create | ✅ any tenant | ✅ own tenant | ✅ own tenant | ❌ | ❌ |
| Read | ✅ any tenant | ✅ own tenant | ✅ own tenant | ✅ own tenant | ❌ |
| Update | ✅ any tenant | ✅ own tenant | ✅ own tenant | ❌ | ❌ |
| Deactivate (scale to 0) | ✅ | ✅ own tenant | ❌ | ❌ | ❌ |
| Destroy (hard delete) | ✅ | ✅ own tenant | ❌ | ❌ | ❌ |

### Service Profiles

| Action | Admin | Editor | Operator | Viewer | Agent |
|---|---|---|---|---|---|
| Create | ✅ | ✅ own tenant | ❌ | ❌ | ❌ |
| Read | ✅ any tenant | ✅ own tenant | ✅ own tenant | ✅ own tenant | ❌ |
| Promote/Rollback | ✅ | ✅ own tenant | ❌ | ❌ | ❌ |
| Delete | ✅ | ✅ own tenant | ❌ | ❌ | ❌ |

### Sessions & HITL

| Action | Admin | Editor | Operator | Viewer | Agent |
|---|---|---|---|---|---|
| List sessions | all in tenant | all in tenant | own only | own only | own only |
| Scale sessions | ✅ | ✅ | ✅ | ❌ | ❌ |
| VNC stream | ✅ | ✅ | ✅ | ✅ | ✅ |
| Takeover/Release baton | ✅ | ✅ | ✅ | ❌ | ❌ |
| Submit input (OTP, etc.) | ✅ | ✅ | ✅ | ❌ | ✅ |
| Acknowledge failure | ✅ | ✅ | ✅ | ❌ | ❌ |

### Credentials & Execute

| Action | Admin | Editor | Operator | Viewer | Agent |
|---|---|---|---|---|---|
| Request credentials | ✅ | ✅ | ✅ | ❌ | ✅ (profile-scoped) |
| Execute fetch | ✅ | ✅ | ✅ | ❌ | ✅ (profile-scoped) |
| Execute browser | ✅ | ✅ | ✅ | ❌ | ✅ (profile-scoped) |

> **Note:** Agent role is scoped to `allowed_profiles` configured on the agent client. Requests to profiles not in the allowlist are rejected with 403.

### Key Distinction: Admin vs Editor

- **Admin** can operate across tenants (pass `tenant_id` to create resources in any tenant, query any tenant's data, see all templates/profiles regardless of tenant).
- **Editor** is always scoped to their own tenant. They have full CRUD within that tenant but cannot see or modify resources belonging to other tenants. This makes Editor suitable for platform integrations that manage a single tenant's configuration.

## Identity Provider Configuration

Identity providers (IdPs) control how external JWTs are mapped to Tabby roles during token exchange and browser OAuth flows.

### Creating an IdP

```bash
curl -X POST /admin/identity-providers \
  -H "Authorization: Bearer <admin-token>" \
  -d '{
    "name": "Corporate Okta",
    "provider_type": "oidc",
    "issuer_url": "https://mycompany.okta.com",
    "jwks_uri": "https://mycompany.okta.com/oauth2/v1/keys",
    "tenant_id_claim": "org_id",
    "allow_auto_provision": true,
    "default_role": "Viewer",
    "role_claim": "groups",
    "admin_role_values": ["TabbyAdmins"],
    "editor_role_values": ["TabbyEditors", "PlatformAdmins"],
    "admin_domains": ["mycompany.com"]
  }'
```

### IdP Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ | Display name |
| `provider_type` | `oidc` | ✅ | Currently only OIDC is supported |
| `issuer_url` | string | ✅ | IdP issuer URL (used for JWT `iss` validation) |
| `jwks_uri` | string | ✅ | URL to fetch public keys for JWT signature verification |
| `audience` | string | | Expected `aud` claim in the JWT (optional, not validated post-verification) |
| `tenant_id_claim` | string | | JWT claim containing the tenant/org ID (e.g., `"tenantId"`, `"org_id"`) |
| `user_id_claim` | string | | JWT claim for user ID (default: `"sub"`) |
| `email_claim` | string | | JWT claim for email (default: `"email"`) |
| `name_claim` | string | | JWT claim for display name (default: `"name"`) |
| `allow_auto_provision` | boolean | | If `true`, tenants and users are auto-created on first token exchange (default: `false`) |
| `default_role` | string | | Role assigned when no mapping matches (default: `"Operator"`) |
| `enabled` | boolean | | Whether this IdP is active (default: `true`) |

### Role Mapping Fields

These fields control how the external JWT's claims are mapped to Tabby roles:

| Field | Type | Description |
|---|---|---|
| `role_claim` | string | Name of the JWT claim containing role/group information (e.g., `"roles"`, `"groups"`, `"realm_access.roles"`) |
| `admin_role_values` | string[] | Values in the role claim that grant **Admin** role |
| `editor_role_values` | string[] | Values in the role claim that grant **Editor** role |
| `admin_domains` | string[] | Email domains that grant **Admin** role (fallback when role claim doesn't match) |

### Role Resolution Order

When a token is exchanged via `POST /auth/token-exchange` (oidc_jwt) or the browser OAuth flow, the role is resolved in this order:

1. **Role claim → Admin**: If `role_claim` is configured AND the JWT's claim array contains any value from `admin_role_values` → **Admin**
2. **Role claim → Editor**: If the claim array contains any value from `editor_role_values` → **Editor**
3. **Admin domains → Admin**: If the user's email domain matches any entry in `admin_domains` → **Admin**
4. **Default**: `default_role` (or `"Operator"` if not set)

The first match wins. Steps are skipped if the relevant field is not configured (null/empty).

### Configuration Examples

#### Okta with Groups

```json
{
  "name": "Okta Production",
  "provider_type": "oidc",
  "issuer_url": "https://mycompany.okta.com/oauth2/default",
  "jwks_uri": "https://mycompany.okta.com/oauth2/default/v1/keys",
  "tenant_id_claim": "org_id",
  "allow_auto_provision": true,
  "default_role": "Viewer",
  "role_claim": "groups",
  "admin_role_values": ["tabby-admins"],
  "editor_role_values": ["tabby-editors", "platform-admins"]
}
```

Users in the `tabby-admins` Okta group get Admin. Users in `tabby-editors` or `platform-admins` get Editor. Everyone else gets Viewer.

#### Azure AD with App Roles

```json
{
  "name": "Azure AD",
  "provider_type": "oidc",
  "issuer_url": "https://login.microsoftonline.com/{tenant-id}/v2.0",
  "jwks_uri": "https://login.microsoftonline.com/{tenant-id}/discovery/v2.0/keys",
  "tenant_id_claim": "tid",
  "allow_auto_provision": true,
  "default_role": "Operator",
  "role_claim": "roles",
  "editor_role_values": ["Tabby.Editor"],
  "admin_domains": ["mycompany.com"]
}
```

Users with the `Tabby.Editor` app role get Editor. Users with `@mycompany.com` email get Admin (if no role matched first). Everyone else gets Operator.

#### Frontegg (Multi-tenant SaaS)

```json
{
  "name": "Frontegg",
  "provider_type": "oidc",
  "issuer_url": "https://myapp.frontegg.com",
  "jwks_uri": "https://myapp.frontegg.com/.well-known/jwks.json",
  "tenant_id_claim": "tenantId",
  "allow_auto_provision": true,
  "default_role": "Operator",
  "role_claim": "roles",
  "editor_role_values": ["Admin"]
}
```

Frontegg users with the `Admin` role in their tenant get Editor in Tabby. This maps the platform's admin concept to Tabby's Editor (full CRUD within own tenant, no cross-tenant access).

#### Simple Domain-Based (No Role Claim)

```json
{
  "name": "Google Workspace",
  "provider_type": "oidc",
  "issuer_url": "https://accounts.google.com",
  "jwks_uri": "https://www.googleapis.com/oauth2/v3/certs",
  "allow_auto_provision": true,
  "default_role": "Viewer",
  "admin_domains": ["mycompany.com"]
}
```

No role claim mapping. Users with `@mycompany.com` email get Admin. Everyone else gets Viewer.

### Browser OAuth Flow

For IdPs that support browser-based OAuth, configure these additional fields to enable `GET /auth/oauth/{idpId}/login`:

| Field | Description |
|---|---|
| `auth_url` | Authorization endpoint (e.g., `https://mycompany.okta.com/oauth2/v1/authorize`) |
| `token_url` | Token endpoint (e.g., `https://mycompany.okta.com/oauth2/v1/token`) |
| `scopes` | Comma-separated OAuth scopes (e.g., `"openid,email,profile"`) |

The flow uses PKCE (no client secret needed for the browser redirect). The callback at `/auth/oauth/callback` exchanges the code, resolves the role via the same mapping logic, and sets an auth cookie.

## Session Idle Shutdown

Sessions track activity via two timestamps:

| Field | Updated by |
|---|---|
| `last_activity_at` | `POST /execute/fetch`, `POST /execute/browser`, `POST /credentials/request` |
| `last_credential_request_at` | `POST /credentials/request` only |

The controller checks idle time as:

```
idle_time = now - (last_activity_at || last_credential_request_at || started_at)
```

If a session was never used (both timestamps null), `started_at` is the fallback — the session is considered idle since creation.

The idle threshold is resolved per-session:
1. App template's `idle_shutdown_seconds` (if the app was provisioned from a template)
2. Global `IDLE_SHUTDOWN_SECONDS` env var on the controller (fallback)
3. `0` = disabled (sessions never expire by idle)

Sessions also have a hard limit via `MAX_SESSION_AGE_HOURS` (default: 24h) regardless of activity.

Both idle and max-age shutdown set `desired_session_count = 0` on the app to prevent the controller from recreating the pod.
