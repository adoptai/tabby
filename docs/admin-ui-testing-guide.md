# Admin UI — Zero to Hero Testing Guide

## Prerequisites

- Kind cluster `tabby-dev` running (already exists)
- `tilt` installed (`which tilt`)
- `pnpm` installed

## 1. Start everything with Tilt

```bash
cd ~/work/tabby
tilt up
```

This builds all Docker images, deploys via Helm, and sets up port-forwards automatically.
Open **http://localhost:10350** to see the Tilt dashboard with build/deploy status for each service.

Wait until all resources show green in the Tilt UI before testing.

### Ports (auto-forwarded by Tilt)

| Service | Port | URL |
|---|---|---|
| Admin UI | 13000 | http://localhost:13000 |
| API | 18080 | http://localhost:18080 |
| Postgres | 25432 | `psql -h localhost -p 25432 -U browser_hitl -d browser_hitl` |
| Redis | 16379 | `redis-cli -p 16379` |
| MinIO | 19000 | http://localhost:19000 |
| NATS | 14222 | — |

## 2. Test credentials

### Admin user (local, password login)

```
Email:    admin@browser-hitl.local
Password: LocalDev123!@#
```

### Editor user (local, password login)

```
Email:    morasque@morasque.com
Password: Morasque123!@#
```

### OAuth (Frontegg)

Click "Sign in with Frontegg" on the login page. Uses your Frontegg account.

After the role-resolver fix, Frontegg users with platform role "Admin" now map to Tabby role **Editor** (configured via `editor_role_values: ["Admin"]` on the IdP).

## 3. Test as Admin

Open **http://localhost:13000** → login with the admin credentials above.

### Pages to verify

| Page | URL | What to check |
|---|---|---|
| Dashboard | `/dashboard` | 7 health cards, session counts, "Live" indicator, recent activity panel |
| Sessions | `/sessions` | Table with sessions, "All Sessions" / "My Sessions" toggle, pagination, auto-refresh |
| Session Detail | `/sessions/:id` (click a row) | State/health badges, stats cards, HITL controls, interventions table, "Open Viewer" button |
| Applications | `/apps` | Table with apps, "+ New Application" button, click row for detail |
| App Detail | `/apps/:id` (click a row) | Details grid, scale control, config JSON display, Edit/Deactivate/Destroy buttons |
| App Templates | `/templates` | Table with all templates (should show 17+), profile patterns |
| Template Detail | `/templates/:id` (click a row) | Config display, Edit/Delete buttons |
| Profiles | `/profiles` | Table with profile versions (ACTIVE/RETIRED), canary stats |
| Profile Detail | `/profiles/:id` | Version info, promote/rollback buttons |
| Tenants | `/tenants` | 4 tenants, Edit/Delete, "+ New Tenant" |
| Users | `/users` | User list, "+ New User", role badges |
| Identity Providers | `/identity-providers` | Frontegg IdP, Test JWKS button, Edit |
| Agent Clients | `/agent-clients` | Tenant selector, client list, Register |

### Create flows to test

#### Create Application (`/apps/new`)

1. Name: `test-app` (required)
2. Target URLs: `https://example.com` (required, one per line)
3. Login Config: use the visual step builder — click "+ Add Step", select "Go to URL", enter `https://example.com`
4. Keepalive Config: leave default `{"health_checks": []}`
5. Export Policy: leave default `{"artifact_types": ["cookies"]}`
6. Click Save

Expected: redirects to apps list, new app appears.

#### Create Template (`/templates/new`)

1. Name: `test-template` (required)
2. Profile Name Pattern: `test-*` (required)
3. Login Config: use step builder — add a "Go to URL" step + a "Wait for selector" step
4. Toggle to JSON mode, verify JSON is valid, toggle back
5. Click Save

Expected: redirects to templates list, new template appears.

#### Create Tenant (`/tenants`, click "+ New Tenant")

1. Name: `test-tenant`
2. Max Sessions: 5
3. Click Create

Expected: dialog closes, new tenant appears in table.

#### Create User (`/users`, click "+ New User")

1. Email: `test@test.com`
2. Password: `TestUser123!@#` (min 12 chars, upper+lower+digit+special)
3. Role: Operator
4. Tenant ID: pick one from the tenants page
5. Click Create

Expected: dialog closes, new user appears.

#### Register Agent Client (`/agent-clients`, click "+ Register Client")

1. Name: `test-agent`
2. Tenant ID: should be pre-filled
3. Allowed Profiles: `test-*` (one per line)
4. Click Register
5. **Copy the client secret** — it's only shown once

Expected: secret reveal dialog appears with client_id + secret.

### Destructive operations to test (use test records only!)

- **Delete test tenant**: click Delete, re-type name, confirm
- **Delete test user**: click Delete, confirm
- **Revoke test agent client**: click Revoke, confirm
- **Deactivate test app**: on detail page, click Deactivate, confirm
- **Destroy test app**: on detail page, click Destroy, re-type name, confirm

### Step builder test

1. Go to `/apps/new` or `/templates/new`
2. In Login Config, click "+ Add Step"
3. Add steps in this order:
   - **Go to URL**: `https://login.example.com`
   - **Fill**: selector `#username`, value `${USERNAME}`
   - **Fill**: selector `#password`, value `${PASSWORD}`
   - **Click**: selector `button[type="submit"]`
   - **Wait for URL**: pattern `*/dashboard*`
4. Expand "Advanced" on one step → set timeout_ms to 15000
5. Expand "On Failure" on the click step → set action to "request_help", message "Login button not found"
6. Drag steps to reorder (move up/move down buttons)
7. Toggle to **JSON** mode → verify the JSON matches the visual steps
8. Toggle back to **Visual** → verify round-trip preserved everything
9. Submit the form

## 4. Test as Editor

Logout (click the power icon in topbar), then login with Editor credentials.

### What Editor SHOULD see

| Page | Visible? | Can write? |
|---|---|---|
| Dashboard | ✓ | — |
| Sessions | ✓ (own sessions) | — |
| Applications | ✓ | ✓ create, edit, deactivate |
| App Templates | ✓ | ✓ create, edit, delete |
| Profiles | ✓ | ✓ promote, rollback |
| Tenants | ✗ (lock icon) | ✗ |
| Users | ✗ (lock icon) | ✗ |
| Identity Providers | ✗ (lock icon) | ✗ |
| Agent Clients | ✗ (lock icon) | ✗ |

### What to verify

1. Sidebar only shows: Dashboard, Sessions, Applications, App Templates, Profiles
2. Role badge in topbar shows "EDITOR" (purple)
3. Navigate directly to `/tenants` → shows lock icon + "You don't have permission"
4. Navigate directly to `/users` → same
5. Navigate directly to `/identity-providers` → same
6. Navigate directly to `/agent-clients` → same
7. Sessions default to "My Sessions" filter
8. Viewer button disabled for sessions not owned by this user

## 5. Test the Viewer

> Requires an active session with VNC or CDP streaming. If no sessions are running, create an app with `desired_session_count: 1` and wait for it to reach HEALTHY state.

1. Go to Sessions, find a HEALTHY session
2. Click the row → Session Detail
3. Click "Open Viewer"
4. Verify:
   - Connection bar shows green dot + "VNC connected" (or "CDP connected")
   - Browser content renders in the canvas
   - HITL panel is visible on the right
   - Clipboard "Send" works (paste a value, click Send)
   - Session status section shows State + Health badges
   - "Restart session" shows two-step confirmation

## 6. Test light mode

Click the sun/moon icon in the topbar. The entire UI should switch to light theme:
- White/light gray backgrounds
- Dark text
- All badges and status colors still readable
- Toggle back to dark mode — should persist across page refresh

## 7. Run automated tests

```bash
# Frontend
cd apps/admin-ui
npx tsc --noEmit           # TypeScript
npx vitest run             # Unit/component tests (24 tests)
npx vite build             # Production build

# Backend
TENANT_ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) pnpm nx test api    # 595 tests

# Full monorepo
TENANT_ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) pnpm run test       # All 7 projects
```

## 8. Cleanup

Delete only test records you created:
- Test apps, templates, tenants, users, agent clients
- Do NOT delete existing tenants (AdoptAI, automation anywhere, workday localhost, default)
- Do NOT delete existing templates (salesforce, workday, 6sense, etc.)

To stop Tilt: press `Ctrl+C` in the terminal where `tilt up` is running, or run `tilt down`.
