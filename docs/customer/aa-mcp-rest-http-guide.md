# MCP Server — HTTP REST Integration Guide

## Overview

The Adopt MCP server uses the [Model Context Protocol](https://modelcontextprotocol.io/) over **Streamable HTTP** transport. All communication happens via standard HTTP POST/GET to a single endpoint (`/mcp`). This guide shows how to interact with the MCP server using plain HTTP REST calls — no MCP SDK required.

---

## Endpoint

```
POST <mcp_server_url>/mcp
```

All JSON-RPC messages are sent as HTTP POST requests to this endpoint.

---

## Authentication

Include authentication headers on **every request**:

### Option A — PAT (Personal Access Token)

```
client-id: <user_client_id>
client-secret: <user_client_secret>
```

### Option B — Bearer Token

```
Authorization: Bearer <token>
```

The PAT method is simpler for REST testing. The bearer token can be obtained via the OAuth flow or the Frontegg API token endpoint.

---

## Protocol Basics

The MCP server speaks [JSON-RPC 2.0](https://www.jsonrpc.org/specification) over HTTP. Every request is a JSON-RPC message with `jsonrpc`, `method`, `id` (for requests), and `params`.

The server may respond with:
- `Content-Type: application/json` — single JSON-RPC response
- `Content-Type: text/event-stream` — SSE stream with multiple events (for long-running calls)

Include these headers on **every** request (including notifications):
```
Content-Type: application/json
Accept: application/json, text/event-stream
```

**Important:** The `Accept` header must be present on all requests, including notifications. Without it, the server returns `406 Not Acceptable`.

---

## Step-by-Step: Listing and Calling Tools

### Step 1 — Initialize

Before anything else, send an `initialize` request:

```bash
curl -X POST <mcp_server_url>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "client-id: <user_client_id>" \
  -H "client-secret: <user_client_secret>" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "id": 1,
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {
        "name": "rest-test",
        "version": "1.0"
      }
    }
  }'
```

**Expected response** (SSE format — the response comes as `text/event-stream`):
```
event: message
data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"Adopt MCP","version":"3.2.0"}}}
```

The JSON-RPC response is inside the `data:` line. Parse accordingly.

**Note:** The server runs in stateless mode — no `Mcp-Session-Id` is returned. Each request is independent.

### Step 2 — Send Initialized Notification

After initialize, send the `initialized` notification:

```bash
curl -X POST <mcp_server_url>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "client-id: <user_client_id>" \
  -H "client-secret: <user_client_secret>" \
  -d '{
    "jsonrpc": "2.0",
    "method": "notifications/initialized"
  }'
```

**Expected response:** `202 Accepted` (no body — it's a notification).

**Note:** The `Accept` header is required even for notifications.

### Step 3 — List Tools

```bash
curl -X POST <mcp_server_url>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "client-id: <user_client_id>" \
  -H "client-secret: <user_client_secret>" \
  \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 2,
    "params": {}
  }'
```

**Expected response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "RAMP_QUOTE_QUOTELINE_CREATOR_AGENT",
        "description": "...",
        "inputSchema": { ... }
      },
      ...
    ]
  }
}
```

### Step 4 — Call a Tool

```bash
curl -X POST <mcp_server_url>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "client-id: <user_client_id>" \
  -H "client-secret: <user_client_secret>" \
  \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "id": 3,
    "params": {
      "name": "RAMP_QUOTE_QUOTELINE_CREATOR_AGENT",
      "arguments": {
        "quote_config": { ... }
      }
    }
  }'
```

**Note:** Tool calls may take a long time (minutes). The server may respond with an SSE stream (`text/event-stream`) containing progress notifications before the final result. Use `curl --no-buffer` to see the stream in real-time:

```bash
curl -X POST <mcp_server_url>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "client-id: <user_client_id>" \
  -H "client-secret: <user_client_secret>" \
  \
  --no-buffer \
  -d '{ "jsonrpc": "2.0", "method": "tools/call", "id": 3, "params": { "name": "...", "arguments": { ... } } }'
```

---

## SSE Stream Format

When the server responds with `text/event-stream`, events look like:

```
event: message
data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":3,"progress":0,"total":100,"message":"{...}"}}

event: message
data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{...}"}]}}

```

Each `event: message` line is followed by a `data:` line containing a JSON-RPC message. The final event contains the tool result (has `id` and `result`).

---

## HITL Response

When a tool requires human interaction (browser login), the result contains:

```json
{
  "status": "tabby_hitl_required",
  "vnc_url": "https://...",
  "short_url": "https://...",
  "message": "Log into Salesforce...",
  "step_index": 1,
  "instructions": "..."
}
```

The caller must:
1. Open the `vnc_url` in a browser for the user.
2. Wait for the user to complete the interaction.
3. Call the same tool again — the server handles retry automatically.

---

## Stateless Mode

The server runs in **stateless HTTP mode**. This means:
- Each request is independent — no persistent session required.
- No `Mcp-Session-Id` is returned or needed.
- Authentication is validated on every request.
- All responses use SSE format (`text/event-stream`) — parse the `data:` lines for JSON-RPC messages.

---

## Complete Example: List Tools with curl

```bash
MCP_URL="<mcp_server_url>"
CLIENT_ID="<user_client_id>"
CLIENT_SECRET="<user_client_secret>"
HEADERS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "client-id: $CLIENT_ID" -H "client-secret: $CLIENT_SECRET")

# 1. Initialize
curl -s -X POST "$MCP_URL/mcp" "${HEADERS[@]}" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# 2. Send initialized notification
curl -s -X POST "$MCP_URL/mcp" "${HEADERS[@]}" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. List tools (parse data: line from SSE)
curl -s -X POST "$MCP_URL/mcp" "${HEADERS[@]}" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2,"params":{}}' \
  | grep "^data:" | sed 's/^data: //' | python3 -m json.tool
```

---

## References

- [MCP Specification — Streamable HTTP Transport](https://modelcontextprotocol.io/specification/draft/basic/transports)
- [MCP Specification — Tools](https://modelcontextprotocol.io/specification/draft/server/tools)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
