# MCP Authentication — Technical Guide

## Overview

The Adopt MCP server supports two authentication methods. The method chosen determines the user experience, session isolation, and whether the identity-provider login screen appears during the VNC/Tabby flow.

---

## Authentication Methods

### Method 1 — OAuth Browser Flow

This is the standard MCP OAuth flow. When the MCP client connects, the server initiates an OAuth authorization code flow through Frontegg (the identity provider). The user sees a browser login screen, authenticates, and receives a token.

**How it works:**

```
MCP Client → MCP Server → Frontegg OAuth authorize → User logs in → Token issued
```

- The MCP client must support the [MCP OAuth 2.0 Authorization flow](https://modelcontextprotocol.io/specification/draft/basic/authorization).
- The user sees the Frontegg login page (which may include Okta SSO if configured for the organization).
- After authentication, the MCP client receives a Bearer token and includes it in all subsequent requests.
- Each session is tied to the authenticated user.

**When to use:** When the MCP client supports OAuth and the user can interact with a browser during the initial connection setup.

**Limitation:** Requires a browser-based login during MCP connection setup. If the host application (e.g., EKB) does not support opening a browser for OAuth during the MCP handshake, this method may not be viable.

---



### Method 2 — Personal Access Token (PAT) via Headers

This method bypasses the browser-based OAuth flow entirely. The user provides their personal `client_id` and `client_secret` as HTTP headers when connecting to the MCP server. The server exchanges these credentials for a Frontegg access token in the background — no browser login required.

**How it works:**

```
MCP Client sends headers:
  client-id: <user's client_id>
  client-secret: <user's client_secret>

MCP Server → Frontegg API token endpoint → Access token issued
→ All subsequent requests authenticated as that user
```

- The user generates a Personal Access Token (PAT) from the Adopt platform dashboard.
- The PAT consists of a `client_id` and `client_secret` pair.
- These are sent as HTTP headers (`client-id` and `client-secret`) on every request to the MCP server.
- The MCP server calls the Frontegg token endpoint to exchange them for a Bearer token.
- The resulting session is tied to the individual user who generated the PAT.

**When to use:** When the MCP client cannot perform an OAuth browser flow during connection setup (e.g., server-to-server, gateway-based MCP, or environments without a browser during handshake).

**Advantage:** No browser login screen during MCP connection. The authentication happens entirely server-side via API. This also means one fewer authentication step for the user during the VNC/Tabby flow, since the user is already authenticated through their PAT.

---



## Per-User Requirement

Both methods require **per-user authentication**. Each user must authenticate individually:

- **OAuth:** Each user logs in with their own Frontegg/Okta credentials.
- **PAT:** Each user generates their own `client_id` / `client_secret` from the Adopt dashboard.

A single shared token for all users is not supported. This is required for:

- **Session isolation:** Each user's Tabby browser session is scoped to their identity. User A cannot see or interact with User B's session.
- **Audit:** Actions are attributed to the specific user who performed them.
- **Security:** Shared credentials would give all users access to all sessions.

---



## MCP Client Configuration



### For OAuth (Method 1)

The MCP client must support the standard MCP OAuth authorization flow. Configuration depends on the client implementation. The MCP server exposes the standard OAuth endpoints:

- `/.well-known/oauth-authorization-server` — Authorization server metadata
- `/oauth/authorize` — Authorization endpoint (redirects to Frontegg)
- `/oauth/token` — Token endpoint (proxied to Frontegg)
- `/oauth/register` — Dynamic client registration



### For PAT (Method 2)

The MCP client must include the following HTTP headers on every request to the MCP server:


| Header          | Value                    | Description                            |
| --------------- | ------------------------ | -------------------------------------- |
| `client-id`     | User's PAT client_id     | From Adopt dashboard → Personal Tokens |
| `client-secret` | User's PAT client_secret | From Adopt dashboard → Personal Tokens |


Example MCP client configuration (generic):

```json
{
  "mcpServers": {
    "adopt-mcp": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "client-id": "<user_client_id>",
        "client-secret": "<user_client_secret>"
      }
    }
  }
}
```

For clients that use `mcp-remote` (stdio transport):

```json
{
  "mcpServers": {
    "adopt-mcp": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://mcp.example.com/mcp",
        "--header", "client-id: <user_client_id>",
        "--header", "client-secret: <user_client_secret>"
      ]
    }
  }
}
```



### Additional Headers

The following headers need to be included for additional context: (check with Rahul/Other Dev)


| Header         | Description                                      |
| -------------- | ------------------------------------------------ |
| `email`        | User's email address                             |
| `end_user_id`  | End-user identifier (for multi-tenant scenarios) |
| `api_base_url` | Target application base URL                      |
| `app_base_url` | Target application base URL (alias)              |


---



## How PAT Generation Works

1. User logs into the Adopt platform at `https://app.adopt.ai`.
2. Navigates to **Dashboard → Admin → Personal Tokens**.
3. Creates a new token — the platform generates a `client_id` and `client_secret`.
4. User configures these in their MCP client.

The token is tied to the user's Frontegg identity. When the MCP server receives it, it exchanges it for a Frontegg access token that carries the user's identity, organization, and permissions — identical to what an OAuth login would produce.

---



## Impact on VNC/Tabby Flow


| Aspect                  | OAuth (Method 1)                  | PAT (Method 2)                                            |
| ----------------------- | --------------------------------- | --------------------------------------------------------- |
| MCP connection setup    | Browser login required            | No browser login                                          |
| User identity           | From OAuth token                  | From PAT → Frontegg token                                 |
| Session isolation       | Per-user                          | Per-user                                                  |
| VNC authentication      | May require platform login        | Already authenticated via PAT                             |
| Number of login screens | 2 (MCP OAuth + VNC platform auth) | 1 (VNC platform auth only, or 0 if already authenticated) |


Using PAT reduces the number of authentication steps the user experiences, since the MCP connection itself doesn't require a browser login.

---



## EKB / MCP Gateway Considerations

If Automation Anywhere's MCP integration uses a gateway or proxy architecture:

- The gateway must be able to forward the `client-id` and `client-secret` headers to the Adopt MCP server.
- Each user connecting through the gateway must have their own PAT configured.
- The gateway must not strip, replace, or share credentials across users.

If the gateway architecture does not support per-user header configuration, the OAuth method (Method 1) may be required — but that in turn requires the gateway to support the MCP OAuth browser flow.

---



## References

- [MCP Specification — Authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [Frontegg — Personal Tokens](https://docs.frontegg.com/reference/personal-tokens)
- [OAuth 2.0 Client Credentials Grant (RFC 6749, Section 4.4)](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4)

