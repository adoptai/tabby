# Tabby — Architecture & Session Security

## Integration Flow

```mermaid
sequenceDiagram
    participant Rep as End User (Sales Rep)
    participant ASF as ASF (AA Skill Framework)
    participant EKB as EKB (Enterprise Knowledge Base)
    participant TFG as TrueFoundry MCP Gateway
    participant MCP as Adopt MCP Server
    participant Tabby as Tabby (Browser Sessions)
    participant WFE as Workflow Engine
    participant SF as Salesforce / 3rd Party

    Note over TFG: One-time setup: AA registers Adopt<br/>with OAuth/PAT credentials

    Rep->>ASF: Trigger CPQ action
    ASF->>EKB: Resolved intent + user context
    EKB->>TFG: MCP skill call (tool_name, args, OAuth token)
    TFG->>MCP: Route to Adopt Service

    MCP->>Tabby: Check session for this user

    alt Active session exists
        Tabby-->>MCP: Session ready
        MCP->>WFE: Execute workflow (use existing session)
        WFE->>SF: API calls (REST / browser)
        SF-->>WFE: Response
        WFE-->>MCP: Result
        MCP-->>TFG: Tool result
        TFG-->>EKB: Result
        EKB-->>ASF: Result
        ASF-->>Rep: Action completed
    else No active session
        Tabby-->>MCP: No session → spin up new pod
        MCP-->>TFG: login_required + VNC URL
        TFG-->>EKB: login_required + VNC URL
        EKB-->>ASF: login_required + VNC URL
        ASF-->>Rep: Show VNC login popup

        Rep->>Tabby: Login via VNC (MFA / OTP / CAPTCHA)
        Tabby-->>Tabby: Session captured

        Note over MCP: Auto-retry detects session ready
        MCP->>WFE: Execute workflow (new session)
        WFE->>SF: API calls (REST / browser)
        SF-->>WFE: Response
        WFE-->>MCP: Result
        MCP-->>TFG: Tool result
        TFG-->>EKB: Result
        EKB-->>ASF: Result
        ASF-->>Rep: Action completed
    end
```

---

## VNC Access — User Authentication

When the user receives a VNC link to log in, the session is protected by an identity verification gate:

```mermaid
sequenceDiagram
    participant User as User (Browser)
    participant Viewer as VNC Viewer Page
    participant IdP as Platform Identity Provider
    participant Tabby as Tabby API

    User->>Viewer: Opens VNC link
    Viewer->>Viewer: Check: valid Tabby JWT cookie?

    alt Already authenticated
        Viewer->>Tabby: Connect WebSocket (JWT in cookie)
        Tabby->>Tabby: Validate JWT, check owner_user_id matches session
        Tabby-->>Viewer: VNC stream connected
    else Not authenticated
        Viewer->>IdP: Redirect to IdP login
        Note over IdP: If user is already logged into<br/>the platform → instant redirect,<br/>no login screen
        IdP-->>Viewer: Redirect back with auth code
        Viewer->>Tabby: Exchange code → Tabby JWT
        Tabby-->>Viewer: Set JWT cookie + redirect to VNC
        Viewer->>Tabby: Connect WebSocket (JWT in cookie)
        Tabby->>Tabby: Validate JWT, check owner_user_id matches session
        Tabby-->>Viewer: VNC stream connected
    end
```

If the user is already logged into the platform, the redirect is instant — they click the VNC link and are connected without seeing a login screen.

If someone else receives the VNC link, they hit the platform login wall and cannot access the session without valid credentials for the organization.

**Fallback:** If OAuth is not configured, the viewer prompts the user to enter their email. Tabby validates the email against the session owner before allowing access.

---

## Session Isolation

### Per-User Isolation

Every browser session is bound to a specific user identity:

- Sessions are scoped to `owner_user_id` (derived from the caller's JWT)
- User A cannot see or access User B's sessions
- All API endpoints filter by `owner_user_id` — cross-user access is impossible at the query level

### Pod-Level Isolation

Each session runs in its own Kubernetes pod:

- Dedicated Chromium instance — no shared browser state between sessions
- Separate network namespace — pods cannot communicate with each other
- NetworkPolicy enforcement — each worker pod can only reach the target application's domains
- Non-root execution — all Linux capabilities dropped

### Credential Protection

Extracted credentials (cookies, tokens, CSRF) are:

- Encrypted at rest with AES-256-GCM
- Stored in tenant-scoped buckets
- Accessible only via authenticated API calls matching the session's `owner_user_id`
- Never exposed through the VNC viewer

### Tenant Isolation

All data is scoped by tenant:

- Sessions, applications, profiles, users, and credentials are all tenant-scoped
- Cross-tenant access is impossible at the database query level
- Each tenant has its own encrypted storage bucket

---

## VNC Link Protection Summary

| Layer | Protection |
|-------|-----------|
| **Identity verification** | VNC viewer requires authentication via the organization's IdP (OAuth redirect) before connecting |
| **Session ownership** | After authentication, Tabby validates the user's identity matches the session owner |
| **Stream token TTL** | VNC links contain a short-lived signed JWT (10 minutes) — expired links are rejected |
| **Credential isolation** | Extracted credentials are never visible through VNC — they are encrypted and served only through authenticated API calls |
| **Pod isolation** | Each session runs in its own pod with NetworkPolicy restricting network access |
| **Fallback** | Email verification gate when OAuth is not configured |
