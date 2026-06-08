# Platform-Hosted Viewer — Handoff for Gabriel

## What changed

Two PRs (not yet merged into dev/prod):

- **adoptwebui** — [PR #1281](https://github.com/adoptai/adoptwebui/pull/1281)
- **python-mcp** — [PR #86](https://github.com/adoptai/python-mcp/pull/86)

All VNC/CDP access now goes through a platform proxy (`/tabby-viewer/`). The user never accesses Tabby directly.

### Before

```
Platform generates Tabby URL → user opens Tabby URL → OAuth callback on Tabby (Frontegg)
```

Each Tabby deployment needed a callback URL registered in Frontegg. For on-prem this would mean **1 callback URL per customer**.

### After

```
Platform generates grant token → builds platform URL (/tabby-viewer/{sessionId}?grant={grantId})
→ user opens platform URL → platform validates identity → WS proxy to Tabby (server-to-server)
```

Tabby no longer needs a public ingress or callback URL. The platform handles authentication and proxies the stream.

## Simplified config

- Removed `tabby_url` and `tabby_idp_id` from Playground Profile
- Added `use_tabby` toggle on Playground Profile
- New env var `TABBY_URL` (global, not per-profile)
- New env var `FRONTEND_BASE_URL` (to generate absolute viewer URLs)

## Grant security model

| Layer | Protection |
|-------|------------|
| Grant token | UUID, Redis, 10-min TTL, single-use, bound to `{session_id, user_id, org_id}` |
| Platform login | Required — no login redirects to Frontegg or token-login |
| user_id check | Grant only accepted if the logged-in user matches the grant's user |
| Session cookie | `tabby_viewer_session`, HttpOnly, SameSite=Lax, 1h |
| WS upgrade | Validates viewer session cookie |
| Stream token | Never reaches the browser — stays server-side |

## Current state per environment

- **Dev and Prod (cloud):** still use direct OAuth on Tabby. Works, but depends on a registered callback URL.
- **On-prem:** when the platform goes on-prem, the direct OAuth model would break (1 callback URL per customer). These PRs fix that.

## NoUI

The NoUI execute endpoints access Tabby server-to-server with JWT, so they don't need a viewer. But when NoUI spins up a session that requires HITL (initial login), it needs to return a viewer link to the user.

It would be good to reuse the same `/tabby-viewer/` route with grant tokens for this — same auth logic, same proxy, no Tabby URL exposed.

## Key files

### Backend (adoptwebui)

| File | What it does |
|------|-------------|
| `backend/app/routes/tabby_viewer.py` | New — validate-grant, WS proxy (VNC + CDP), HTTP proxy (panel-state, hitl-resolve, restart, successor) |
| `backend/app/services/tabby_resolution_service.py` | Generates grant in HITL response flow, builds `viewer_url` |

### Frontend (adoptwebui)

| File | What it does |
|------|-------------|
| `frontend/src/pages/tabbyViewer/TabbyViewerPage.jsx` | Full viewer — dark theme, HITL controls, restart, successor polling |
| `frontend/src/pages/tabbyViewer/CdpViewer.jsx` | CDP canvas viewer with mouse/keyboard/clipboard forwarding |

### python-mcp

| File | What it does |
|------|-------------|
| `python-mcp/src/core/adopt_agent.py` | Prefers `viewer_url` over `short_url` in HITL response |

## Review

Please review and merge when you get a chance:
- adoptwebui [PR #1281](https://github.com/adoptai/adoptwebui/pull/1281)
- python-mcp [PR #86](https://github.com/adoptai/python-mcp/pull/86)
