# Implementation Prompt: Platform-Hosted VNC/CDP Viewer for Tabby

## Goal

Build a VNC/CDP viewer page inside the Adopt platform (adoptwebui) that proxies Tabby's browser sessions through the platform backend. This eliminates the need to register Frontegg callback URLs per Tabby deployment and ensures users must be authenticated on the platform to access VNC sessions.

## Problem

1. Tabby's VNC viewer requires an OAuth callback URL registered in Frontegg per deployment — doesn't scale for on-prem
2. If a VNC link leaks (especially in MCP flows that traverse multiple services), anyone with the link could access the session before the real user
3. The solution: all VNC access goes through the platform, which verifies the user's identity before granting access

## Architecture

```
                    ┌─────────────────────────────────────────────────────┐
                    │                    User Browser                      │
                    │                                                      │
                    │  1. Click link in Copilot/MCP response               │
                    │     https://platform.com/tabby-viewer/{sessionId}    │
                    │     ?grant={uuid}                                     │
                    └──────────────────┬──────────────────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────────────────┐
                    │              Platform (same origin)                   │
                    │                                                      │
                    │  2. Backend validates:                                │
                    │     - User is logged in (Frontegg session)            │
                    │     - GETDEL grant from Redis (single-use)            │
                    │     - grant.user_id === logged-in user_id             │
                    │     - If mismatch → 403                               │
                    │                                                      │
                    │  3. Sets tabby_viewer_session cookie (HttpOnly, 1h)   │
                    │                                                      │
                    │  4. Renders viewer page (react-vnc)                   │
                    │                                                      │
                    │  5. WebSocket: wss://platform.com/ws/tabby-vnc/      │
                    │     Backend validates cookie on WS upgrade            │
                    │     Opens internal WS to Tabby API                    │
                    │     Bidirectional pipe                                │
                    └──────────────────┬──────────────────────────────────┘
                                       │ (internal — K8s DNS or public TABBY_URL)
                    ┌──────────────────▼──────────────────────────────────┐
                    │              Tabby API (internal or public)           │
                    │                                                      │
                    │  Receives WS from platform backend                   │
                    │  Validates stream token                               │
                    │  Proxies to worker pod websockify                    │
                    └──────────────────┬──────────────────────────────────┘
                                       │ (K8s internal DNS, NetworkPolicy)
                    ┌──────────────────▼──────────────────────────────────┐
                    │              Worker Pod                               │
                    │  websockify (noVNC sidecar) :6080                    │
                    │  Chromium browser session                            │
                    └─────────────────────────────────────────────────────┘
```

**Key points:**

- Browser ONLY talks to `platform.com` — never to Tabby directly. `platform.com`  is not a real value, it's the platform URL.
- Tabby's short-link / stream token stays in the platform backend — never reaches the browser
- User must be logged into the platform AND be the session owner to access the viewer
- Works whether Tabby has public DNS or is intra-cluster only (env var `TABBY_URL` controls it)
- The Tabby API hop is mandatory — it handles auth, service discovery, and is the only thing the worker's NetworkPolicy allows

## Security Model


| Layer                     | Protection                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------- |
| **Grant token**           | UUID, Redis, 10-min TTL, single-use (GETDEL), bound to `{session_id, user_id, org_id}` |
| **Platform login**        | Required — no login = redirect to Frontegg (already registered, zero new callbacks)    |
| **user_id check**         | Grant only accepted if logged-in user matches the grant's user_id → 403 otherwise      |
| **Viewer session cookie** | `tabby_viewer_session`, HttpOnly, Secure, SameSite=Strict, 1h, platform domain         |
| **WS upgrade**            | Validates viewer session cookie — no cookie = no WebSocket                             |
| **Tabby internal**        | Stream token validates the session; Tabby API proxies to correct worker pod            |
| **Worker NetworkPolicy**  | Only Tabby API pods can reach worker:6080 — platform/browser cannot bypass             |


**If the link leaks:**

- Attacker opens link → must log into platform → logs in as themselves → user_id doesn't match grant → **403**
- Grant already consumed by real user → GETDEL returns null → **error**
- Grant expired (10 min) → **error**

**If the Tabby short-link leaks:**

- Tabby's OAuth gate fires → no callback URL registered → OAuth fails
- Email gate fallback → attacker must know the owner's email
- This is defense-in-depth — the primary protection is the platform gate above

## Architecture Decisions and Rationale

- **All the validation of the login in the platform probably already works for other routes and etc, check how this works for the current code and make this new page in this way**
- **Do not re-invent the wheel, use what exists in the platform, the new things is just our things**
- **If there's a way to use the redis and etc that platform already does, like a helper and etc use it**

### Why the platform hosts the viewer (not Tabby directly)

**Problem:** Tabby's VNC viewer requires an OAuth callback URL registered in Frontegg. Each on-prem Tabby deployment would need its own callback — doesn't scale. Additionally, MCP flows traverse multiple services where the VNC link could leak, allowing unauthorized access if the link alone grants entry.

**Decision:** All VNC access goes through the platform. The platform verifies the user's identity (Frontegg login) before granting access. The Tabby short-link/stream token never reaches the browser.

**Alternatives considered and rejected:**

- **Pre-auth via short-link (cookie set on first access):** If the link leaks, whoever clicks first gets the cookie — no identity verification at the point of access.
- **Email gate fallback:** Weak — if both the link and email leak, the session is compromised. Same security model as password-reset links, which infosec flagged as insufficient for VNC session access.
- **Platform callback relay (redirect through platform to Tabby):** The platform doesn't always know the Tabby URL (on-prem vs cloud), and on-prem platform URLs also aren't registered in Frontegg — same problem shifted one level up.
- **iframe embedding Tabby's viewer:** Blocked by three independent layers: X-Frame-Options: SAMEORIGIN (Helmet), SameSite=Lax cookies not sent cross-origin in iframes, and WebSocket upgrade requires the cookie.
- **Frontegg wildcard callbacks:** Unsafe, Frontegg may not support it, and customer Tabby deployments are on arbitrary domains.

### Why the Tabby API hop is mandatory (browser → platform → Tabby API → worker)

**Decision:** The platform cannot connect directly to worker pods, even in the same cluster.

**Reasons:**

1. **Different clusters in production.** Platform and Tabby run in separate clusters. Platform cannot resolve worker pod DNS (`worker-abc-novnc.browser-hitl.svc.cluster.local`).
2. **NetworkPolicy.** Worker pods only accept traffic from Tabby API pods (`app.kubernetes.io/component: api`). Platform pods would be blocked.
3. **No auth on websockify.** The worker's websockify is a raw TCP-to-WS bridge — zero authentication. All security (stream token, owner validation) lives in Tabby API's WS proxy layer. Bypassing it bypasses all auth.

### Why grant token (not JWT in URL, not session cookie inheritance)

**Decision:** Use a short UUID grant token stored in Redis (10-min TTL, single-use GETDEL), NOT a JWT in the URL.

**Reasons:**

- Frontegg access token is in-memory (Redux store), NOT in cookies or localStorage. A new tab cannot inherit the token.
- JWTs in URLs are long, ugly, logged by proxies/NGINX, and appear in browser history.
- A UUID is 36 chars, opaque, single-use, and carries no user data in the URL itself.

### Why grant is generated at HITL response time (not on click)

**Decision:** The grant is pre-generated when `build_hitl_response()` constructs the `tabby_hitl_required` response. The `viewer_url` with the grant embedded is returned to the frontend.

**Reasons:**

- Allows `<a href>` instead of a JavaScript click handler — simpler, works everywhere.
- 10-min TTL is sufficient for the user to see the HITL card and click.
- If the grant expires, the next action execution generates a fresh one.

### Why the viewer route requires platform auth (NOT a public route)

**Decision:** `/tabby-viewer/*` is an authenticated route, NOT a public route. The user must be logged into the platform.

**Reason:** If it were a public route, the grant token in the URL would be the sole auth. If the link leaks (MCP flows traverse multiple services), whoever clicks first consumes the grant — no identity verification. By requiring platform login, even if the link leaks, the attacker must log into the platform as the correct user (user_id in the grant must match the logged-in user).

**On-prem complication:** On-prem uses CE-based auth (`/token-login`) which hardcodes redirect to `/dashboard`, losing the original URL. Fixed by adding `returnUrl` param to preserve the viewer URL through the login redirect. This is a standard pattern (`returnUrl`/`returnTo`) and doesn't break existing flows (falls back to `/dashboard` when no `returnUrl` is present).

**Relevant files:**
- `frontend/src/App.jsx:146` — redirect to `/token-login` (add `returnUrl`)
- `frontend/src/pages/tokenLogin/TokenLoginPage.jsx:72,119` — navigate after login (read `returnUrl`)

### Why disable WebSocket compression

**Decision:** `compression=None` on the upstream `websockets.connect`.

**Reason:** VNC/RFB data is already compressed by the protocol's own codecs (Tight, ZRLE). WebSocket-level compression (permessage-deflate) adds ~300 KB of zlib state per connection for zero benefit. At 1000 connections, that's 300 MB saved.

### Why CDP is deferred to v2

**Decision:** v1 implements VNC only. CDP viewer is structurally the same but uses a different rendering approach (canvas + JPEG frames vs react-vnc/RFB).

**Reason:** VNC is what humans interact with for login/OTP. CDP is a cost optimization (lighter pods). Adding CDP in v2 is a frontend-only change (same WS proxy, different renderer).

## Prerequisites — Read Before Implementing

### Platform codebase (adoptwebui)

- `frontend/src/pages/layout/FixedLayout.jsx` — router, `isPublicStudioRoute`, how public routes work
- `frontend/src/components/experienceComponents/Chat/Message/MessageItem.jsx` — `TabbyHitlCard` (lines 14-107), how `vnc_url` is used
- `frontend/src/api/services/experienceService/endUserConversationApis.js` — `resolveTabbyHitl()`, how HITL response is built
- `backend/app/services/tabby_resolution_service.py` — `build_hitl_response()`, `resolve_tabby_tokens_or_hitl()`
- `backend/app/routes/conversation.py` — `tabby-resolve-hitl` endpoint, `direct-signal` endpoint

### Tabby codebase

- `apps/api/src/modules/streaming/vnc-ws-proxy.service.ts` — WS proxy auth (cookie + stream token)
- `apps/api/src/modules/streaming/cdp-ws-proxy.service.ts` — same for CDP
- `apps/api/src/modules/streaming/streaming.controller.ts` — viewer page, panel-state, hitl-resolve endpoints
- `apps/api/src/modules/streaming/stream-token.service.ts` — stream token generation/validation
- `apps/api/src/modules/hitl/hitl.controller.ts` — `POST /sessions/:id/stream`, `POST /sessions/:id/short-link`

## Implementation Plan

### Phase 1: Platform Backend

**Branch from:** `feat/simplify-tabby-config` (current adoptwebui working branch)

#### 1a. Grant token generation

**Integrate into the existing HITL response flow.** When `build_hitl_response()` in `tabby_resolution_service.py` constructs a `tabby_hitl_required` response, ALSO generate a platform grant:

```python
# After building the HITL response with vnc_url, short_url, etc:
grant_id = str(uuid4())
grant_data = {
    "session_id": session_status.get("session_id"),
    "user_id": user_id,
    "org_id": org_id,
    "stream_token": extracted_stream_token,  # from vnc_url fragment
    "tabby_vnc_ws_url": f"{TABBY_URL}/vnc-ws",  # internal Tabby WS endpoint
}
await cache_client.store_in_cache(f"tabby:vnc_grant:{grant_id}", json.dumps(grant_data), expiry=600)  # 10 min

# Add to the HITL response:
response["viewer_url"] = f"/tabby-viewer/{session_id}?grant={grant_id}"
```

The `viewer_url` replaces `vnc_url` in what the frontend sees. The raw `vnc_url` (Tabby's URL with stream token) stays in the backend — never sent to the browser.

#### 1b. Viewer page backend route

**File: `backend/app/routes/tabby_viewer.py` (new)**

```python
router = APIRouter(prefix="/tabby-viewer", tags=["tabby-viewer"])

@router.get("/{session_id}")
async def viewer_page(session_id: str, grant: str = Query(...), request: Request):
    """Validate grant, set session cookie, serve viewer HTML."""
    # 1. GETDEL grant from Redis (single-use)
    grant_json = await cache_client.get_and_delete(f"tabby:vnc_grant:{grant}")
    if not grant_json:
        raise HTTPException(status_code=403, detail="Invalid or expired grant")

    grant_data = json.loads(grant_json)

    # 2. Validate session_id matches
    if grant_data["session_id"] != session_id:
        raise HTTPException(status_code=403, detail="Session mismatch")

    # 3. Validate user identity
    # Get the current user from Frontegg session
    current_user = get_current_user_from_request(request)  # implement based on platform's auth
    if current_user["user_id"] != grant_data["user_id"]:
        raise HTTPException(status_code=403, detail="Access denied")

    # 4. Generate viewer session token (for WS auth)
    viewer_session = str(uuid4())
    await cache_client.store_in_cache(
        f"tabby:viewer_session:{viewer_session}",
        json.dumps({"session_id": session_id, "user_id": current_user["user_id"], **grant_data}),
        expiry=3600,  # 1h
    )

    # 5. Set cookie + serve viewer page
    response = HTMLResponse(render_viewer_html(session_id))
    response.set_cookie(
        "tabby_viewer_session", viewer_session,
        httponly=True, secure=True, samesite="strict", max_age=3600, path="/tabby-viewer"
    )
    return response
```

**Important:** The `get_current_user_from_request` function needs to work for this route. Investigate how the platform validates the Frontegg session — it might be via the `accessToken` cookie (control-plane mode) or via the Frontegg SDK's session. The viewer page is a public route (like StudioViewer), so the user might not have a standard Frontegg session. If they don't, the backend should redirect to the platform login page, which then redirects back after auth.

#### 1c. WebSocket proxy

```python
@router.websocket("/ws/tabby-vnc/{session_id}")
async def vnc_ws_proxy(websocket: WebSocket, session_id: str):
    """Proxy VNC WebSocket to Tabby internal API."""
    # 1. Validate viewer session cookie
    cookie = websocket.cookies.get("tabby_viewer_session")
    if not cookie:
        await websocket.close(code=1008, reason="Missing session")
        return

    session_json = await cache_client.get_from_cache(f"tabby:viewer_session:{cookie}")
    if not session_json:
        await websocket.close(code=1008, reason="Invalid session")
        return

    session_data = json.loads(session_json)
    if session_data["session_id"] != session_id:
        await websocket.close(code=1008, reason="Session mismatch")
        return

    # 2. Connect to Tabby's WS endpoint
    tabby_url = os.environ.get("TABBY_URL", "")
    ws_url = tabby_url.replace("https://", "wss://").replace("http://", "ws://")
    stream_token = session_data["stream_token"]
    upstream_url = f"{ws_url}/vnc-ws?session_id={session_id}&token={stream_token}"

    await websocket.accept(subprotocol="binary")

    # 3. Bidirectional pipe
    import websockets
    async with websockets.connect(upstream_url, subprotocols=["binary"], compression=None) as upstream:
        async def forward_to_upstream():
            try:
                async for message in websocket.iter_bytes():
                    await upstream.send(message)
            except Exception:
                pass

        async def forward_to_client():
            try:
                async for message in upstream:
                    if isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_text(message)
            except Exception:
                pass

        await asyncio.gather(forward_to_upstream(), forward_to_client())
```

**Disable WebSocket compression** (`compression=None`) — VNC data is already compressed by the RFB protocol. Saves ~300 KB per connection.

#### 1d. HTTP proxy for panel-state and hitl-resolve

```python
@router.get("/api/tabby-proxy/{session_id}/panel-state")
async def panel_state_proxy(session_id: str, request: Request):
    """Proxy panel state to Tabby. Auth via viewer session cookie."""
    session_data = await validate_viewer_cookie(request)
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{TABBY_URL}/vnc/{session_id}/panel-state",
            params={"token": session_data["stream_token"]},
        )
        return JSONResponse(resp.json(), status_code=resp.status_code)

@router.post("/api/tabby-proxy/{session_id}/hitl-resolve")
async def hitl_resolve_proxy(session_id: str, body: dict, request: Request):
    """Proxy HITL resolve to Tabby."""
    session_data = await validate_viewer_cookie(request)
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{TABBY_URL}/vnc/{session_id}/hitl-resolve",
            params={"token": session_data["stream_token"]},
            json=body,
        )
        return JSONResponse(resp.json(), status_code=resp.status_code)
```

### Phase 1.5: Fix Token Login Redirect (Critical for On-Prem)

On-prem deployments use Chrome Extension (CE) auth via `/token-login`. Currently, when an unauthenticated user opens any URL, they're redirected to `/token-login` which always navigates to `/dashboard` after auth — **the original URL is lost**.

This MUST be fixed or the viewer link won't work when the user isn't logged in.

**File: `frontend/src/App.jsx` (line 146)**

```javascript
// Before:
navigate("/token-login", { replace: true });

// After:
navigate(`/token-login?returnUrl=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
```

**File: `frontend/src/pages/tokenLogin/TokenLoginPage.jsx`**

In `completeLoginWithToken` (line 72) and the `useEffect` (line 119):

```javascript
// Before:
navigate("/dashboard", { replace: true });

// After:
const params = new URLSearchParams(window.location.search);
const returnUrl = params.get("returnUrl") || "/dashboard";
navigate(returnUrl, { replace: true });
```

This is a standard `returnUrl` pattern. If no `returnUrl` param exists, falls back to `/dashboard` (backward compatible). The grant token survives the login redirect because the full URL (`/tabby-viewer/{sessionId}?grant={uuid}`) is preserved in the `returnUrl` query param.

**On-prem flow after this fix:**
1. User clicks `plataforma-cliente.com/tabby-viewer/{sessionId}?grant={uuid}`
2. No cookies → redirect to `/token-login?returnUrl=%2Ftabby-viewer%2F{sessionId}%3Fgrant%3D{uuid}`
3. CE authenticates via `app.adopt.ai` cookies
4. `completeLoginWithToken` → `navigate(returnUrl)` → back to `/tabby-viewer/...?grant=...`
5. Grant validated, viewer loads

### Phase 2: Platform Frontend

#### 2a. Install react-vnc

```bash
cd frontend && npm install react-vnc
```

Confirmed compatible with Vite (ESM exports). No config changes needed.

#### 2b. New viewer page

**File: `frontend/src/pages/tabbyViewer/TabbyViewerPage.jsx` (new)**

Add route in `FixedLayout.jsx` in the public routes section (same pattern as `StudioViewer`):

```jsx
<Route path="tabby-viewer/:sessionId" element={<TabbyViewerPage />} />
```

Update `isPublicStudioRoute` regex to match `/tabby-viewer/*`.

The viewer page component:

```jsx
import { VncScreen } from 'react-vnc';
import { useRef, useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

function TabbyViewerPage() {
  const { sessionId } = useParams();
  const vncRef = useRef(null);
  const [panelState, setPanelState] = useState(null);
  const [clipboardText, setClipboardText] = useState('');
  const [status, setStatus] = useState('connecting');

  // WS URL — same origin, proxied by backend
  const wsUrl = `wss://${window.location.host}/ws/tabby-vnc/${sessionId}`;

  // Poll panel state
  useEffect(() => {
    const poll = async () => {
      try {
        const resp = await fetch(`/api/tabby-proxy/${sessionId}/panel-state`);
        if (resp.ok) setPanelState(await resp.json());
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [sessionId]);

  // Send clipboard to remote
  const sendClipboard = () => {
    if (vncRef.current && clipboardText) {
      vncRef.current.clipboardPaste(clipboardText);
    }
  };

  // Mark as Resolved
  const handleResolve = async () => {
    const stepIndex = panelState?.pending_input_request?.step_index;
    await fetch(`/api/tabby-proxy/${sessionId}/hitl-resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input_type: 'confirm',
        value: 'resolved',
        step_index: stepIndex,
      }),
    });
  };

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#1a1a1a' }}>
      {/* VNC Viewer */}
      <div style={{ flex: 1 }}>
        <VncScreen
          url={wsUrl}
          ref={vncRef}
          scaleViewport
          autoConnect
          retryDuration={3000}
          style={{ width: '100%', height: '100%' }}
          rfbOptions={{ wsProtocols: ['binary'] }}
          onConnect={() => setStatus('connected')}
          onDisconnect={(e) => setStatus(e.detail.clean ? 'closed' : 'lost')}
          onClipboard={(e) => setClipboardText(e.detail.text)}
        />
      </div>

      {/* Side Panel */}
      <div style={{ width: 320, background: '#fff', borderLeft: '1px solid #e0e0e0', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3>Session Controls</h3>

        {/* Status */}
        <div>Status: {status}</div>

        {/* Clipboard */}
        <div>
          <label>Clipboard (paste into VNC)</label>
          <textarea
            value={clipboardText}
            onChange={(e) => setClipboardText(e.target.value)}
            rows={4}
            style={{ width: '100%' }}
          />
          <button onClick={sendClipboard}>
            Send to VNC (then Ctrl+V inside viewer)
          </button>
        </div>

        {/* HITL Resolve */}
        {panelState?.pending_input_request && (
          <div>
            <p>{panelState.pending_input_request.message || 'Action requires your input'}</p>
            <button onClick={handleResolve}>Mark as Resolved</button>
          </div>
        )}

        {/* Session Info */}
        {panelState && (
          <div style={{ fontSize: 12, color: '#666' }}>
            <div>State: {panelState.state}</div>
            <div>App: {panelState.app_name}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default TabbyViewerPage;
```

#### 2c. Change TabbyHitlCard

**File: `frontend/src/components/experienceComponents/Chat/Message/MessageItem.jsx`**

Replace the external Tabby link with the platform viewer URL. The `viewer_url` comes from the HITL response (generated by the backend with the grant already embedded):

```jsx
// Before:
<a href={currentVncUrl} target="_blank">Open Browser (VNC)</a>

// After:
<a href={tabbyData.viewer_url} target="_blank">Open Browser (VNC)</a>
```

No click handler needed. No JavaScript. The grant is already in the URL, generated when the HITL response was built. TTL is 10 minutes — if the user doesn't click within 10 min, the next action execution generates a fresh one.

### Phase 3: Tabby Changes (Minimal)

**Branch:** `feat/nats-resilience-controller-scaling` (current Tabby working branch)

#### 3a. Allow WS proxy from platform without tabby_vnc cookie

**File: `apps/api/src/modules/streaming/vnc-ws-proxy.service.ts`**

The platform backend connects to `/vnc-ws?session_id=X&token=Y`. It won't have the `tabby_vnc` cookie (it's a server-to-server connection). The stream token alone should be sufficient for server-side callers.

Add a bypass: if the connection has a valid stream token AND no cookie AND no `Origin` header (server-to-server connections don't send Origin), accept it. Browser connections always send `Origin`, so this doesn't weaken browser-facing security.

```typescript
// After the cookie check fails (around line 130):
// Server-to-server bypass: no Origin header = not a browser
const origin = request.headers.origin;
if (!origin && streamTokenValid) {
  // Server-side proxy (platform backend) — stream token is sufficient
  // Proceed with WS connection
}
```

Same change in `cdp-ws-proxy.service.ts` for CDP support.

#### 3b. Ensure stream token validation is independent

Verify that the stream token validation (`verifyToken` in `stream-token.service.ts`) works without consuming the token (it uses `verifyToken`, not `validateToken` which does GETDEL). The platform might need to reuse the token for panel-state/hitl-resolve calls. Confirm this is already the case.

## What NOT to Change

- Tabby's existing viewer (`/vnc/:sessionId`, `/cdp/:sessionId`) — stays for standalone/open-source
- Tabby's OAuth callback flow — stays as fallback/defense-in-depth
- Tabby's email gate — stays
- `tabby_vnc` cookie mechanism — stays for direct browser access
- `resolve_tabby_hitl()` in `tabby_resolution_service.py` — stays unchanged
- MCP's `requires_tabby` and `direct-signal` flow — stays unchanged
- Tabby's worker pods, controller, NetworkPolicy — zero changes

## Clipboard — How It Works

**Local → Remote (user wants to paste into VNC):**

1. User types/pastes text in the side panel textarea
2. Clicks "Send to VNC"
3. `vncRef.current.clipboardPaste(text)` sends text to the remote machine's clipboard via RFB
4. User clicks inside VNC canvas and presses Ctrl+V → text pastes
5. Works in all browsers, no permissions needed

**Remote → Local (user copies inside VNC):**

1. User copies text inside VNC (Ctrl+C)
2. `onClipboard` event fires → text appears in the side panel textarea
3. User can copy it from there

**Ctrl+C/V directly in the canvas:** operates on the remote clipboard only. This is standard for all web VNC viewers (same in Guacamole). The side panel textarea is the bridge between local and remote clipboards.

## CDP Support

For v1, VNC is the priority. CDP can be added later with the same architecture:

- Backend: same WS proxy pattern, different upstream URL (`/cdp-ws` instead of `/vnc-ws`)
- Frontend: canvas-based renderer instead of `react-vnc` (decode `Page.screencastFrame` JPEG base64)
- Input: `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` via CDP WebSocket messages
- Check: Tabby's `CdpWsProxyService` has an allowlist for CDP methods — ensure input methods are allowed

## Scalability

For up to 1000 concurrent sessions, Python (FastAPI + uvicorn) handles the WS proxy fine:


| Scale         | Workers | Memory         | Status         |
| ------------- | ------- | -------------- | -------------- |
| 100 sessions  | 1       | ~50-100 MB     | Easy           |
| 500 sessions  | 1-2     | ~200-500 MB    | Fine           |
| 1000 sessions | 2-3     | ~500 MB - 1 GB | OK with tuning |


**Important:** Disable WebSocket compression (`compression=None` on the upstream `websockets.connect`). VNC data is already compressed by RFB. Saves ~300 KB per connection.

## Testing

### Unit/Integration tests

1. **Grant flow:** generate grant → validate → GETDEL → second validate returns null
2. **User mismatch:** grant for user A, logged in as user B → 403
3. **Expired grant:** wait 10 min → validate → error
4. **WS proxy:** mock Tabby WS, verify bidirectional binary forwarding
5. **Cookie validation:** WS upgrade without cookie → rejected
6. **Panel state proxy:** mock Tabby endpoint, verify passthrough
7. **HITL resolve proxy:** mock Tabby endpoint, verify passthrough

### Manual test checklist

- MCP flow: trigger HITL → receive platform viewer URL (not Tabby URL)
- Open viewer → must be logged into platform (redirect to login if not)
- Logged in as wrong user → 403
- Logged in as correct user → VNC loads, remote desktop visible
- Clipboard: type in side panel → Send → Ctrl+V in VNC → text pastes
- Mark as Resolved → session resolves
- Sequential HITL: after resolve, trigger new action → new grant generated
- Grant expired (wait 10+ min) → error page
- Grant consumed (open link twice) → second time shows error
- Copilot flow: TabbyHitlCard shows "Open Browser (VNC)" → opens platform viewer
- Test with Tabby intra-cluster (TABBY_URL = internal K8s DNS) → works
- Test with Tabby public DNS → works
- Verify Tabby short-link/stream token never visible in browser (check Network tab, URL bar, page source)

## Git / Commit Rules

- **adoptwebui changes:** branch from `feat/simplify-tabby-config`
- **tabby changes:** branch `feat/nats-resilience-controller-scaling`
- **Do NOT commit anything inside `docs/`** in the Tabby repo
- `scripts/scale-test.sh` in Tabby can be committed
- When staging files, add specific paths — do not use `git add -A` or `git add .`

## Code Standards

### adoptwebui

- Follow existing React component patterns
- Follow existing FastAPI route patterns
- Follow existing styling patterns
- The viewer page should match the platform's visual language

### tabby

- Follow existing NestJS patterns
- Use `@browser-hitl/shared` for shared constants
- Run `pnpm run build && pnpm run test && helm lint charts/browser-hitl/` before committing
- Conventional commits
- Tests must pass with: `TENANT_ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) pnpm run test`

