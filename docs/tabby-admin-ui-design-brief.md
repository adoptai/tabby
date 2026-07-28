# Tabby Admin UI — Complete Design Brief

## What this is

Design a complete, production-quality admin interface for **Tabby**, a Browser Human-in-the-Loop (HITL) platform. Tabby manages Playwright/Chromium browser sessions that execute login automation scripts. When automation hits obstacles (OTP, CAPTCHA, MFA), human operators intervene via VNC or CDP streaming viewers. Extracted credentials (cookies, headers, tokens) are encrypted and served to downstream AI agents.

The audience is infrastructure engineers, DevOps operators, and platform admins managing browser automation at scale — not end users. This is an internal operations tool, not a customer-facing product.

The current implementation is functionally complete but visually poor: inconsistent spacing, unstyled forms, broken flows, no design system. Every page needs to be redesigned from scratch while preserving all functionality.

## Tech stack (do not change)

- React 19, Vite 6, React Router v7
- Tailwind CSS v4 with `@tailwindcss/vite` plugin
- Radix UI primitives, Lucide icons
- TanStack Query for data fetching
- Zustand for auth/UI state
- Monaco Editor (lazy-loaded) for JSON editing
- noVNC for VNC streaming, custom canvas for CDP streaming

## Design direction

This should feel like **a serious infrastructure control plane** — think Vercel dashboard, Linear, Grafana, or Railway. Dense but readable. Information-rich without feeling cluttered. The kind of tool an SRE trusts to manage production browser sessions at 2 AM.

Not a marketing site. Not a SaaS onboarding flow. Not a generic admin template. A tool built for people who know what they're looking at and need to act fast.

Dark mode is the primary theme (operators often work in low-light). Light mode must work equally well.

---

## Design system tokens

### Color

Define a complete semantic token system in CSS custom properties on `:root`, redefined under `.dark`. Current tokens exist but are minimal — expand them significantly.

**Required semantic tokens:**
- `--bg`, `--fg` — page background and primary text
- `--card`, `--card-fg` — card/panel surfaces
- `--primary`, `--primary-fg` — primary actions (buttons, links, active nav)
- `--muted`, `--muted-fg` — secondary surfaces, helper text
- `--destructive`, `--destructive-fg` — delete, destroy, danger actions
- `--border` — all borders and dividers
- `--ring` — focus rings
- `--accent` — used sparingly for visual interest (different from primary)
- `--success` — healthy, active, pass states
- `--warning` — unhealthy, login_needed, canary, degraded states
- `--error` — failed, auth_fail states
- `--info` — starting, staging, informational states

Status colors must be distinct from the primary accent. They encode operational state and need to be instantly scannable.

### Typography

Use a system font stack for body text (fast, no CSP issues). Use a monospace stack for IDs, codes, selectors, JSON, and technical values. Consider a slightly tighter line-height for dense data tables vs. normal line-height for form labels and descriptions.

Key typographic decisions:
- Table cell text: 13px, tight leading
- Form labels: 13px, medium weight, muted color
- Page titles: 24px, bold
- Section headers: 16px, semibold
- Badges/chips: 11px, semibold, uppercase tracking
- Monospace values (IDs, selectors, URLs): 12px, tabular-nums

### Layout

Fixed sidebar (240px expanded, 64px collapsed) + fixed topbar (56px) + scrollable main content area. Content max-width around 1200px with comfortable padding. Tables and forms fill available width. Viewer page is full-bleed (no max-width, no padding).

---

## RBAC — Role-aware visibility

Five roles exist. The UI must show/hide navigation items, action buttons, and form fields based on role. The backend enforces authorization — frontend checks are purely UX.

| Capability | Admin | Editor | Operator | Viewer | Agent (no UI) |
|---|---|---|---|---|---|
| Dashboard | ✓ | ✓ | ✓ | ✓ | — |
| Sessions list | all | all | own | own (read-only) | — |
| Session detail + HITL controls | ✓ | ✓ | ✓ | read-only | — |
| VNC/CDP Viewer | ✓ | ✓ | ✓ | ✓ | — |
| Applications CRUD | CRUD + destroy | CRUD + deactivate | create + scale | — | — |
| App Templates CRUD | ✓ | ✓ | read | — | — |
| Profiles CRUD + promote/rollback | ✓ | ✓ | read | read | — |
| Tenants CRUD | ✓ | — | — | — | — |
| Users CRUD | ✓ | — | — | — | — |
| Identity Providers CRUD + test | ✓ | — | — | — | — |
| Agent Clients CRUD + rotate | ✓ | — | — | — | — |

---

## Complete page inventory

### 1. Login page (`/login`)

**Route:** unauthenticated, centered layout, no sidebar

**Content:**
- Product name "Tabby" with subtle branding
- OAuth provider buttons (fetched from `GET /auth/oauth/providers`). Each button: "Sign in with {provider.name}"
- Divider with "or" text
- Collapsible email/password form (secondary path):
  - Email input (default: `admin@browser-hitl.local`)
  - Password input
  - Submit button
- Error message area (red text below form)
- Loading state on submit

**Notes:** OAuth is the primary flow. Email/password is a fallback for local development. The form should feel intentionally secondary (collapsed by default when OAuth providers exist).

### 2. Dashboard (`/dashboard`)

**Content:**
- Page title "Dashboard"
- **Session health summary cards** — a row of 7 cards, one per session state:
  - STARTING (blue/info)
  - HEALTHY (green/success)
  - UNHEALTHY (amber/warning)
  - LOGIN_NEEDED (amber/warning)
  - LOGIN_IN_PROGRESS (violet/info)
  - FAILED (red/error)
  - TERMINATED (gray/neutral)
  - Each card shows: state badge + count (large number)
- Total session count below the cards
- Data refreshes every 10 seconds

**Empty state:** "No sessions running" with muted description

### 3. Sessions list (`/sessions`)

**Content:**
- Page title "Sessions"
- **Data table** with columns:
  - Application name (text)
  - Session ID (monospace, truncated with title tooltip)
  - State (status badge)
  - Health (status badge)
  - Created (relative or absolute timestamp)
  - Actions: "Details" link
- Pagination: 20 per page, "Showing X–Y of Z", Previous/Next buttons
- Auto-refresh every 10 seconds
- Click row or "Details" → navigate to `/sessions/:id`

**Empty state:** "No sessions" + "Sessions are created when applications scale up."

**Status badge colors:**
| Value | Color |
|---|---|
| HEALTHY / PASS / ACTIVE | green |
| STARTING / STAGING | blue |
| UNHEALTHY / LOGIN_NEEDED / CANARY / TRANSIENT_FAIL | amber |
| LOGIN_IN_PROGRESS | violet |
| FAILED / AUTH_FAIL | red |
| TERMINATED / RETIRED | gray |
| N/A | gray |

### 4. Session detail (`/sessions/:id`)

**Content:**
- Header: "Session {id (truncated)}" + app name subtitle
- **Action buttons** (top right):
  - "Open Viewer" (primary, navigates to `/sessions/:id/viewer`)
  - "Stream URL" (secondary, calls `POST /sessions/:id/stream`, opens URL in new tab)
- **Stats grid** (4 cards):
  - State (status badge)
  - Health (status badge)
  - Retries (number)
  - HITL Attempts (number)
- **HITL controls** (visible for Admin/Editor/Operator when state is LOGIN_IN_PROGRESS or LOGIN_NEEDED):
  - "Takeover Baton" button (primary) — `POST /sessions/:id/takeover`
  - "Release Baton" button (secondary) — `POST /sessions/:id/release`
- **Interventions table** — "Interventions" section:
  - Columns: Type, Outcome (badge), Created, Completed
  - Empty state: "No interventions recorded."
- Auto-refresh every 5 seconds

### 5. Session viewer (`/sessions/:id/viewer`)

**Layout:** Full-bleed, no content max-width, no main padding. Viewer fills viewport minus topbar.

**Content:**
- **Connection bar** (top, thin): connection status dot (green=connected, amber=connecting, red=disconnected) + "VNC connected" / "CDP connected" text
- **Viewer area** (main): VNC canvas (via noVNC) or CDP canvas (via custom WebSocket screencast renderer), fills available space, black background
- **HITL side panel** (right, 320px, collapsible via toggle button on edge):
  - **Human Input Needed** section (amber background, shown when `pending_input_request` exists):
    - Input type + label text
    - "Mark as Resolved" button (green, calls `POST /sessions/:id/input` with `{type: "confirm", value: "resolved", step_index}`)
    - Disabled state after resolving, re-enables on new pending request
  - **Clipboard** section:
    - Password-masked input
    - "Send" button (sends text to VNC clipboard)
  - **Session Status** section (collapsible):
    - State badge, Health badge, Intervention count, Retry count
  - **Restart** section (bottom, danger zone):
    - "Restart Session" button (destructive outline)
    - Two-step confirmation: first click shows warning text + "Cancel" / "Confirm Restart" buttons

**Auth:** Viewer calls `POST /sessions/:id/stream` to get stream token, connects WebSocket to API host directly.

**Streaming modes:**
- VNC: `wss://{apiHost}/vnc-ws?session_id=...&token=...` via noVNC RFB
- CDP: `wss://{apiHost}/cdp-ws?session_id=...&token=...` via canvas screencast

### 6. Applications list (`/apps`)

**Visible to:** Admin, Editor, Operator

**Content:**
- Page title "Applications" + "New Application" button (top right, for Admin/Editor/Operator)
- **Data table** with columns:
  - Name (link to detail)
  - Tenant ID (monospace, truncated)
  - Sessions (desired count)
  - Execute Enabled (badge: green "Enabled" / gray "Disabled")
  - Created (timestamp)
  - Actions: "Details" link
- Pagination: 20 per page

### 7. Application detail (`/apps/:id`)

**Content:**
- Header: app name + actions
- **Action buttons:**
  - "Edit" (secondary) — opens edit dialog/drawer (NOT a dead link to `/apps/:id/edit`)
  - "Deactivate" (warning) — confirmation dialog, for Admin/Editor
  - "Destroy" (destructive) — confirmation dialog with app name re-type, for Admin/Editor
- **Info grid:**
  - Name, Tenant ID, Template ID, Owner User ID, Credential Ref, Execute Enabled
  - Created, Updated timestamps
  - Target URLs (list of URLs, monospace)
- **Scale control** (inline):
  - Current desired session count display
  - Number input (integer only, step=1, min=0) + "Scale" button
  - Calls `POST /apps/:id/sessions/scale` with `{ desired_sessions: number }`
- **Configuration tabs:**
  - Login Config (formatted JSON display, read-only)
  - Keepalive Config (formatted JSON)
  - Export Policy (formatted JSON)
  - Browser Policy (formatted JSON)
  - Notification Config (formatted JSON)
  - Extra Egress Allowlist (string list)

### 8. Create/Edit Application form

**Can be a drawer (Sheet) or dialog. NOT a separate page.**

**Required fields (marked with *):**
- Name * — text input, min 1 char
- Target URLs * — textarea, one URL per line, minimum 1 URL. Parse on submit: `split('\n').map(trim).filter(Boolean)`. Show validation error if empty.
- Login Config * — JSON editor (Monaco or textarea with syntax highlighting). Must produce a valid object, not null. Default placeholder: `{"steps": []}`
- Keepalive Config * — JSON editor. Default: `{"health_checks": []}`
- Export Policy * — JSON editor. Default: `{"artifact_types": ["cookies"]}`

**Optional fields:**
- Tenant ID — text input (for Admin, allows cross-tenant creation)
- Desired Session Count — integer input, min 0
- Execute Enabled — checkbox/switch, default false
- Browser Policy — JSON editor (collapsible section)
- Notification Config — JSON editor (collapsible section)
- Extra Egress Allowlist — textarea, one domain per line

**Note:** `credential_ref` does NOT exist in the backend DTO. Do not include it in this form.

**Validation:** JSON fields must parse to a valid object (not null, not a string). Show inline parse errors. Required fields show error state when empty on submit.

### 9. Templates list (`/templates`)

**Visible to:** Admin, Editor (write), Operator (read-only)

**Content:**
- Page title "App Templates" + "New Template" button (Admin/Editor)
- **Data table** — columns:
  - Name (link to detail)
  - Profile Name Pattern (monospace)
  - Idle Shutdown (seconds, or "—")
  - Execute Enabled (badge)
  - Created (timestamp)
  - Actions: "Details" link

**Note:** API returns a plain array, not paginated `{ data, total }`.

### 10. Template detail (`/templates/:id`)

**Content:**
- Header: template name + actions
- **Action buttons:**
  - "Edit" (opens edit drawer/dialog, NOT a link to `/templates/:id/edit`)
  - "Delete" (destructive confirmation, Admin/Editor)
- **Info display:**
  - Name, Profile Name Pattern, Credential Ref Default, Idle Shutdown, Execute Enabled, Extra Egress Allowlist
  - Created, Updated timestamps
- **Configuration display** (tabs or sections):
  - Login Config (formatted JSON)
  - Keepalive Config (formatted JSON)
  - Export Policy (formatted JSON)
  - Browser Policy (formatted JSON)
  - Notification Config (formatted JSON)

### 11. Create/Edit Template form

**Drawer or dialog.**

**Required fields (marked with *):**
- Name * — text input, min 1 char
- Profile Name Pattern * — text input, min 1 char. Tooltip: "Glob pattern matched against Tabby profile names"
- Login Config * — JSON editor. Default: `{"steps": []}`
- Keepalive Config * — JSON editor. Default: `{"health_checks": []}`
- Export Policy * — JSON editor. Default: `{"artifact_types": ["cookies"]}`

**Optional fields:**
- Credential Ref Default — text input (note: field name is `credential_ref_default`, not `credential_ref`)
- Idle Shutdown Seconds — integer input, min 60 (backend enforces `@Min(60)`)
- Execute Enabled — checkbox/switch
- Extra Egress Allowlist — textarea, one domain per line
- Browser Policy — JSON editor (collapsible)
- Notification Config — JSON editor (collapsible)
- Tenant ID — text input (Admin only)

### 12. DSL Step Builder (inside Login Config)

**This is a sub-component used within the App/Template create/edit forms in place of a raw JSON textarea for the `login_config.steps` array.**

**Two modes:** Visual (default) and JSON (toggle button)

**Visual mode:**
- Toolbar: "Add Step" dropdown (16 step types) + "Switch to JSON" toggle
- Draggable step cards in a vertical list
- Each card shows: step number, action type badge, field inputs, collapse/expand, move up/down, delete

**Step types and their fields:**

| Type | Fields |
|---|---|
| `goto` | url (text), url_expression (text, shown on toggle) |
| `fill` | selector (text, monospace), value (text, supports `${USERNAME}` / `${PASSWORD}`) |
| `type` | selector (text), value (text) |
| `click` | selector (text), first (checkbox) |
| `select` | selector (text), value (text) |
| `wait_for` | selector (text), first (checkbox) |
| `wait_for_url` | pattern (text, monospace) |
| `frame` | selector (text) |
| `main_frame` | (no fields) |
| `popup` | (no fields) |
| `keyboard` | key (text or select: Enter, Tab, Escape, etc.) |
| `evaluate` | expression (code textarea), store_as (text) |
| `sleep` | ms (number) |
| `screenshot` | (no fields) |
| `reload` | (no fields) |
| `request_human_input` | input_type (select: otp/email/password/captcha/verification_code/url/confirm), label (text), field_selector (text), submit_selector (text), placeholder (text) |

**Common options** (collapsible "Advanced" section per card):
- timeout_ms (number, default 30000)
- retry_count (number)
- sensitive (checkbox)
- retry_backoff (select: fixed / exponential)
- retry_delay_ms (number)
- retry_max_delay_ms (number)

**On Failure** (collapsible section, only for: goto, fill, click, wait_for, wait_for_url):
- action (select: skip / abort / request_help)
- If request_help: message (text), input_type (select), screenshot (checkbox)

**JSON mode:**
- Full Monaco/CodeMirror editor showing JSON representation
- "Apply" button to parse and sync back to visual mode
- Inline parse error display

### 13. Profiles list (`/profiles`)

**Visible to:** All authenticated roles (Admin/Editor can write, Operator/Viewer read-only)

**Content:**
- Page title "Profiles"
- **Data table** — columns:
  - Profile ID (text)
  - Version (text)
  - Version State (badge: STAGING/CANARY/ACTIVE/RETIRED)
  - App ID (monospace, truncated)
  - Canary Requests (number)
  - Canary Errors (number)
  - Actions: "Details" link + inline Promote/Rollback buttons for applicable states

**Promote button:** visible for STAGING and CANARY states (Admin/Editor)
**Rollback button:** visible for ACTIVE state when `parent_version_id` exists (Admin/Editor)

### 14. Profile detail (`/profiles/:id`)

**Content:**
- Header: profile ID + version
- Info: version_state badge, app_id, tenant_id, parent_version_id, owner_user_id
- Canary stats: request count, error count, error rate (calculated)
- Target domains list
- Credential types (formatted JSON)
- Login config (formatted JSON)
- Promote/Rollback buttons (with confirmation dialogs)

### 15. Tenants page (`/tenants`) — Admin only

**Content:**
- Page title "Tenants" + "New Tenant" button
- **Data table** — columns:
  - ID (monospace)
  - Name
  - Max Sessions (number)
  - Created (timestamp)
  - Actions: inline edit max_sessions, Delete

**Create Tenant dialog:**
- Name * (text, required)
- ID (text, optional — auto-generated if blank)
- Max Sessions (integer, optional, default 10, max 1000)

**Edit:** Inline edit of max_sessions (click to edit, integer input, min 1 max 1000, Save/Cancel)

**Delete:** Confirmation dialog, destructive, require tenant name re-type. Warning: "This will permanently delete the tenant and all associated data (applications, sessions, profiles, users, artifacts). This cannot be undone."

### 16. Users page (`/users`) — Admin only

**Content:**
- Page title "Users" + "New User" button
- **Data table** — columns:
  - Email
  - Role (badge)
  - Tenant ID (monospace)
  - Status (badge: active=green, disabled=gray)
  - Created (timestamp)
  - Actions: Delete

**Create User dialog:**
- Email * (email input)
- Password * (password input, with complexity hint: "Min 12 chars, uppercase, lowercase, digit, special character")
- Role * (select: Admin / Editor / Operator / Viewer)
- Tenant ID * (select dropdown populated from tenants list, or UUID input)

**Delete:** Confirmation dialog, destructive.

### 17. Identity Providers page (`/identity-providers`) — Admin only

**Content:**
- Page title "Identity Providers" + "New IdP" button
- **Data table** — columns:
  - Name
  - Issuer URL (monospace, truncated)
  - Provider Type (badge: oidc / saml)
  - Auto-Provision (badge: enabled/disabled)
  - Default Role
  - Actions: Edit, Test JWKS, Delete

**Test JWKS:** Inline button per row. Calls `GET /admin/identity-providers/:id/test`. Shows result inline: "✓ {key_count} keys ({latency_ms}ms)" or error message.

**Create/Edit IdP dialog (large, scrollable):**

**Required:**
- Name * (text)
- Provider Type * (select: oidc / saml) — **THIS FIELD IS CRITICAL, MUST NOT BE OMITTED**

**OIDC Configuration section:**
- Issuer URL (text)
- JWKS URI (text) — alternative to issuer-based discovery
- Auth URL (text) — required for browser OAuth flow
- Token URL (text)
- Userinfo URL (text)
- Sign Out URL (text)
- Scopes (text, default: "openid email profile")
- Audience (text)

**User Identity Mapping section:**
- User ID Claim (text, default: "sub")
- Email Claim (text, default: "email")
- Name Claim (text)
- Tenant ID Claim (text)

**Role Mapping section:**
- Role Claim (text, e.g., "roles")
- Admin Role Values (textarea, one per line) — "Values in the source JWT that map to Tabby Admin"
- Editor Role Values (textarea, one per line) — "Values that map to Tabby Editor"
- Admin Domains (textarea, one per line) — "Email domains that auto-assign Admin role (fallback)"
- Default Role (select: Admin / Editor / Operator / Viewer)

**Provisioning section:**
- Enabled (checkbox, default true)
- Allow Auto-Provision (checkbox) — "Automatically create tenant and user on first login"
- Allow Shared Session Fallback (checkbox)

### 18. Agent Clients page (`/agent-clients`) — Admin only

**Content:**
- **Tenant selector** at top (dropdown, pre-selected from current user's tenant)
- Page title "Agent Clients" + "Register Client" button
- **Data table** — columns:
  - Name
  - Client ID (monospace)
  - Allowed Profiles (comma-separated list or "Unrestricted" badge)
  - Revoked (badge: revoked=red, active=green)
  - Last Used (timestamp or "Never")
  - Actions: Rotate Secret, Revoke (not shown for already-revoked)

**Register Client dialog:**
- Name * (text)
- Tenant ID * (UUID, pre-filled from selector)
- Allowed Profiles (textarea, one per line) — **required when "Unrestricted" is unchecked, minimum 1 entry**
- Unrestricted Profiles (checkbox) — when checked, allowed_profiles field is hidden
- Token TTL Seconds (integer, optional)
- Rate Limit Per Minute (integer, optional, max 1000)

**After registration — Secret Reveal dialog (non-dismissable):**
- Shows Client ID (monospace, with copy button)
- Shows Client Secret (monospace, with copy button)
- Warning: "Save this secret now. It cannot be retrieved again."
- Only action: "Done, I copied the secret" button

**Rotate Secret:** Confirmation first, then shows new secret in same Secret Reveal dialog.

**Revoke:** Confirmation dialog, destructive. Revoked rows are visually dimmed.

---

## Shared components and patterns

### Status badges

Rounded pill / chip. 11px semibold uppercase. Background tinted to match status color at ~10% opacity, text in full-saturation status color. Used everywhere: session state, health, profile version state, execute enabled, user status.

### Data tables

- Dense rows (40px height)
- Header row: muted background, medium-weight labels
- Hover: subtle row highlight
- Monospace for IDs, URLs, selectors
- Right-align action columns
- Pagination below: "Showing X–Y of Z" left, Prev/Next buttons right
- `tabular-nums` for any numeric columns
- Horizontal scroll on overflow for wide tables

### Forms and inputs

- Labels above inputs, 13px medium weight
- Required fields marked with * in the label
- Input fields: rounded border, comfortable padding, focus ring
- Validation errors: red border + red error text below the field
- JSON editors: dark background, syntax highlighting, inline error display
- Collapsible optional sections (e.g., "Advanced Options", "Browser Policy")
- Form submit buttons: primary for create/save, disabled while loading with spinner
- Cancel button: secondary/outline style

### Confirmation dialogs

- Overlay backdrop (dark semi-transparent)
- Centered dialog card
- Title + description
- For destructive actions: description includes specific warning about consequences
- For irreversible destructive actions: require re-typing the resource name
- Button row: Cancel (secondary) + Confirm (primary or destructive)
- Loading state on confirm button

### Empty states

- Centered in content area
- Descriptive title ("No sessions", "No templates")
- Optional subtitle explaining context
- Optional primary action button ("New Template", etc.)

### Loading states

- Skeleton loaders matching the shape of the content (table skeleton, card skeleton)
- Not just a spinner — use skeleton shapes for tables and cards

### Error states

- Inline error messages for form validation
- Toast notifications for mutation success/failure
- Error boundary fallback: centered error message + "Try again" button
- API error shape: `{ error: { code, message, details? } }`

### JSON editors

- Monaco Editor (lazy-loaded, ~300KB)
- Dark theme for the editor area (regardless of page theme)
- Syntax highlighting, bracket matching, auto-indent
- Inline error markers for parse failures
- "Apply" button when in JSON mode of the step builder

---

## Topbar

- Fixed, 56px height
- Left: breadcrumb or empty
- Right: theme toggle button (sun/moon icon), user info (email + role badge), logout button (icon)
- User display should show email/name from JWT, not a raw UUID — strip `federated:` prefix, ideally resolve to email from claims

## Sidebar

- Fixed left, 240px expanded, 64px collapsed (icon-only)
- Top: "Tabby" brand name + collapse toggle button
- Nav items: icon + label, active state with primary color tint
- Role-aware: items filtered by user role (see RBAC table above)
- Smooth collapse transition
- Bottom: no footer needed

---

## Known implementation defects to fix after design

These are backend integration bugs that must be fixed in code, not in design. The design should assume correct behavior. Documenting them here so the implementer knows:

1. **Create App form sends `credential_ref`** — field doesn't exist in backend DTO. Remove from form.
2. **Create Template sends `credential_ref` instead of `credential_ref_default`** — wrong field name.
3. **JSON fields send `null` when blank** — must send `{}` or a valid default object, not null.
4. **Create IdP missing `provider_type`** — required field, must be in the form.
5. **`profile_name_pattern` is required in templates** — UI must mark it required.
6. **Edit App/Template links go to nonexistent routes** — use drawer/dialog instead of navigation.
7. **`idle_shutdown_seconds` min is 60** — enforce in UI.
8. **Agent client `allowed_profiles` requires min 1 when not unrestricted** — validate before submit.
9. **User password requires 12+ chars with uppercase, lowercase, digit, special char** — show hint.
10. **Tenant `max_sessions` max is 1000** — enforce in UI.
11. **Scale sessions input must be integer** — use `step="1"`.
12. **`step_index` is required in InputDto** — type it as required.
13. **Topbar shows raw UUID instead of email** — decode JWT and show email or name if available.

---

## Responsive behavior

Desktop-first. Minimum supported width: 1024px.

- Sidebar collapses to icon-only below 1280px
- Tables get horizontal scroll on narrow viewports
- Viewer page is full-width at all sizes
- Forms maintain comfortable width (max ~600px for inputs)
- Cards grid: 4 columns on wide, 2 on medium, 1 on narrow

---

## What to produce

A complete set of React components and pages implementing this design. Every page, every table, every form, every field, every action, every state (loading, empty, error, success). The output should be production-ready code, not mockups.

Use the existing tech stack (Tailwind v4, Radix UI, Lucide icons). Define the design system as CSS custom properties. Build reusable components (StatusBadge, DataTable, FormField, ConfirmDialog, JsonEditor wrapper, etc.) and compose pages from them.

The result should look like a tool that a team would trust to manage production infrastructure.
