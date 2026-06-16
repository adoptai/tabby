# Tabby (Browser HITL)

Browser Human-In-The-Loop platform. Workers run Playwright/Chromium to execute Login DSL scripts, with human intervention via Slack/VNC when automation gets stuck (OTP, CAPTCHA, MFA, passwords, magic links, or any custom input).

## Build & Test

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run lint
helm lint charts/browser-hitl/
```

**Test with encryption key:** `TENANT_ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) pnpm run test`

**Before committing:** Pre-commit hook runs `lint-staged` + `pnpm run build` + `pnpm run test` automatically via Husky. Commit-msg hook validates conventional commits via commitlint.

## Project Structure

Monorepo (NX + pnpm workspaces):
- `apps/api` — NestJS REST API (port 8000)
- `apps/controller` — Watches sessions, creates/destroys worker pods
- `apps/worker` — Ephemeral Playwright pod, executes Login DSL
- `apps/slack-bot` — NATS subscriber, Slack notifications + human input relay
- `apps/teams-bot` — Microsoft Teams equivalent
- `apps/admin-ui` — Next.js dashboard (port 8000)
- `packages/shared` — Shared types, enums, state machines, DSL types, NATS events
- `charts/browser-hitl` — Helm chart for K8s deployment
- `infra/docker/` — 7 Dockerfiles (api, controller, worker, novnc, slack-bot, teams-bot, admin-ui)
- `infra/tfy/deploy.yaml` — TrueFoundry manifest template (envsubst placeholders)

## Local Development (Kind)

```bash
make kind-create          # one-time: create Kind cluster
make kind-reload-all      # clean + build + docker-build + load + helm upgrade with values-local.yaml
make k8s-port-forward     # forward API (18080), Admin UI (13000), Postgres, Redis, MinIO, NATS
```

All local config (API URL, stream host, service auth, secrets) is in `values-local.yaml` — no manual `kubectl set env` needed.

To enable slack-bot locally, set `slackBot.enabled: true` and add `slackSigningSecret`, `slackAppToken`, `slackBotToken` in `values-local.yaml` secrets section. Remember to also set `slackBot.slackDefaultChannel` to a channel ID.

## Ports (standardized)

ALL services run on port 8000 (API, Admin UI). Controller: 8090, Worker health: 8091. Do NOT use 3000 or 8080 — those are legacy.

## Docker Images

Registry: `ghcr.io/adoptai/tabby/{service}:{tag}`
7 images: api, controller, worker, novnc, slack-bot, teams-bot, admin-ui

## Helm Chart

- Chart: `oci://ghcr.io/adoptai/charts/browser-hitl`
- Lint: `helm lint charts/browser-hitl/`

### Key Helm patterns

- Service names are dynamic: `{{ include "browser-hitl.fullname" . }}-{component}`
- NEVER hardcode service names in values files — use templates with the fullname helper
- ConfigMap URLs (Redis, NATS, MinIO) are auto-generated from fullname helper
- VirtualServices are auto-generated in `templates/virtualservices.yaml`

### Values files

- `values.yaml` — defaults (DO NOT put secrets here)
- `values-local.yaml` — local Kind dev (all config baked in, committed to git)
- `values-staging.yaml` — staging overrides, NOT committed (contains secrets)
- `infra/tfy/deploy.yaml` — CI/CD template, uses `${PLACEHOLDER}` vars substituted by envsubst

## CI/CD (.github/workflows/)

- `ci.yaml` — PR validation: PR title conventional commit check, lint, test, build, security audit, helm lint
- `deploy-staging.yaml` — Push to `dev`: build images → auto-bump chart version → push chart → `tfy apply` → health check
- `deploy-production.yaml` — Push to `main`: reads already-bumped version from Chart.yaml, builds `prod-*` images, same chart version
- Secrets are in GitHub Environments (`staging` / `production`), injected via envsubst into `infra/tfy/deploy.yaml`

### Conventional Commits (enforced)

PR titles MUST follow conventional commits (squash merge makes PR title the commit message):
- `release:` or `feat!:` / `fix!:` → **major** version bump (X+1.0.0)
- `feat:` → minor version bump (0.X+1.0)
- `fix:`, `chore:`, `ci:`, etc. → patch bump (0.0.X+1)
- Enforced by: Husky commit-msg hook (local) + CI PR title check

## Staging Deployment (TrueFoundry)

- Platform: TrueFoundry (wraps ArgoCD)
- Helm release name configured in `infra/tfy/deploy.yaml`
- ArgoCD manages deployment — `helm install/upgrade` directly will CONFLICT
- Istio gateway: `istio-system/tfy-wildcard`

## Architecture Notes

### HITL Flow (Generic Human Input)
Worker hits `request_human_input` DSL step → writes `pending_input_request` to session + signals `AUTH_FAIL` via DB → Controller transitions to `LOGIN_NEEDED` → Creates intervention with `input_request_metadata` + sets baton to `HUMAN_REQUESTED` → Publishes enriched `hitl.started` NATS event (with `intervention_type` + `input_request`) → Slack bot posts dynamic message (buttons adapt to input type) → Human submits value via Slack modal or resolves via VNC → Value stored in Redis (`human_input:{sessionId}:{stepIndex}`, 300s TTL) → Worker polls, receives, acts (fill field / navigate URL / resume) → Health check passes → Session returns to HEALTHY

**Sequential human input:** Controller detects new `pending_input_request` during `LOGIN_IN_PROGRESS` and publishes additional `hitl.started` events. Enables password → OTP in sequence without session state reset.

**No state check on input submission:** `POST /sessions/:id/input` intentionally skips `LOGIN_IN_PROGRESS` state check. Avoids timing race where worker is waiting but controller hasn't reconciled from STARTING yet. Input can also be resubmitted (no NX flag on Redis SET).

### Supported Human Input Types
- `otp` — one-time password / 2FA code
- `email` — email address
- `password` — password (masked in Slack modal)
- `captcha` — CAPTCHA solution
- `verification_code` — generic verification code
- `url` — URL (e.g., magic link)
- `confirm` — human resolves via VNC, clicks "Mark as Resolved" in Slack

### DSL Step Types
Core steps: `goto`, `click`, `fill`, `wait_for` (element selector), `wait_for_url` (URL pattern match), `evaluate` (JS eval in page context), `screenshot`, `request_human_input`. Each step can have `on_failure`, retry config, and conditional execution.

### DSL Step: `on_failure`
Any `wait_for`, `wait_for_url`, `click`, `fill`, `goto` step can have `on_failure`:
- `{ "action": "skip" }` — skip failed step, continue DSL
- `{ "action": "abort" }` — fail immediately
- `{ "action": "request_help", "message": "...", "input_type": "url", "screenshot": true }` — screenshot + ask human for input (reuses generic human input infrastructure)

### DSL Retry Backoff
Steps support `retry_backoff: "exponential"`, `retry_delay_ms`, `retry_max_delay_ms`. Default: fixed 1s delay.

### Baton State Machine
`AUTOMATION_CONTROL → HUMAN_REQUESTED → HUMAN_CONTROL → HUMAN_RELEASED → AUTOMATION_CONTROL`

### Service Profile State Machine
`STAGING → CANARY → ACTIVE → RETIRED`
- Canary promotion gate is wired: `resolveActiveProfile()` queries ACTIVE + CANARY (prefers ACTIVE), increments `canary_request_count`/`canary_error_count`
- Credentials (`POST /credentials/request`) returns `CANARY` freshness when serving from canary

### Credential Reference Types
- `k8s:secret/{name}` — Worker reads `username`/`password` from K8s Secret, injects as `${USERNAME}`/`${PASSWORD}` in DSL
- `manual:` — No stored credentials. Human provides everything via VNC during HITL. Worker skips credential injection entirely.

### Custom Extractions (export_policy)
`export_policy.custom_extractions` array supports site-specific token extraction:
- `js_eval` — runs `page.evaluate(expression)` in browser context (e.g., Salesforce `aura_token`)
- `cookie` — named cookie lookup from browser context
- Both support `extract_on_url` glob filter to only extract on matching pages
- `extract_urls` — map of glob patterns to URLs. Worker navigates to these URLs before running filtered extractions. Supports `{{variable}}` placeholders from `store_as` values. Example: `{"*/apex/sb*": "https://example.com/apex/sb?id={{quote_id}}"}`
- `store_as` — on `evaluate` DSL steps, stores the result in a variable for use in `extract_urls` templates

### Header Capture (export_policy)
Two complementary allowlists, both require `'headers'` in `artifact_types`:
- `header_allowlist` — response headers captured via `page.on('response')`. For headers servers send back.
- `request_header_allowlist` — outbound request headers captured via `page.on('request')`. For JS-minted auth material (bearer JWTs, tenant keys) attached by fetch/axios interceptors that never appears in a response. `Cookie` is rejected here (cookies have their own extraction path).

Both are filtered through `target_urls` globs — only requests/responses whose URL matches at least one `target_url` are captured. If `target_urls` is empty, capture runs on all URLs (mirrors cookie extraction). The on-disk bundle shape is `{ url: { headerName: value } }` for both; at union time, request-header values win on per-URL conflict. Configured casing is preserved so the consumer gets the header name it asked for.

JWT-minting SPAs typically rotate bearers faster than the default 3600s `refresh_interval_seconds` (see gotcha #17) — apps that adopt `request_header_allowlist` should set `refresh_interval_seconds` to 120–300.

### Profile credential_types.custom
`credential_types.custom` array in profiles maps custom extraction keys to consumers. The `key` must exactly match a `key` from `custom_extractions`. Volatility levels: `STABLE`, `SEMI_STABLE`, `VOLATILE`.

### Key API Endpoints
- `POST /sessions/:id/stream` — VNC stream URL
- `POST /sessions/:id/takeover` — Acquire baton
- `POST /sessions/:id/release` — Release baton
- `POST /sessions/:id/input` — Submit generic human input (type, value, step_index)
- `POST /sessions/:id/acknowledge` — Acknowledge failure, retry
- `POST /credentials/request` — Request credentials. Supports `force_refresh: true` to trigger immediate re-extraction. Add `wait_seconds: 1-30` to block until fresh credentials arrive (BLPOP on Redis). Without `wait_seconds`, force_refresh is fire-and-forget.
- `POST /auth/token-exchange` — RFC 8693-inspired exchange: accepts `oidc_jwt` or `agent_assertion` subject token type, issues user-scoped Tabby JWT with `owner_user_id`
- `GET /auth/oauth/providers` — List IdPs with browser OAuth configured (have `auth_url` set)
- `GET /auth/oauth/:idpId/login` — Start browser OAuth flow with PKCE; redirects to IdP
- `GET /auth/oauth/:idpId/callback` — OAuth callback: exchanges code, auto-provisions user, issues Tabby JWT, redirects admin-UI

### MCP Integration (noVNC streaming)
- `GET /stream/r/:id` — short-link redirect: looks up Redis-backed short URL (600s TTL), redirects to full noVNC viewer URL
- Short links created by `stream-token.service.ts:createShortLink()` — used by python-mcp to give LLMs a compact VNC URL
- `?from=mcp` query param gates the "Mark as Resolved" HITL panel in the noVNC viewer (Copilot/CE have their own resolve UI)
- Resolve panel calls `POST /sessions/:id/input` with `{type: "confirm", value: "resolved"}` to release the worker

### NATS Events
- `hitl.started.{tenantId}.{sessionId}` — carries `intervention_type` + `input_request` metadata (multiple events per session for sequential inputs)
- `hitl.completed.{tenantId}.{sessionId}`
- `session.state.changed.{tenantId}.{sessionId}`

### OAuth / Multi-Tenant Architecture
- Tabby is an OAuth Resource Server: validates external IdP JWTs via JWKS (no `client_secret` needed for direct API path). See `apps/api/src/modules/auth/jwt.strategy.ts` and `apps/api/src/modules/auth/oauth-provider.service.ts`.
- Auto-provisioning: tenants and users are provisioned on first JWT validation if `allow_auto_provision` is set on the IdP config. No pre-registration required.
- `admin_domains` on IdP config: emails matching listed domains get Admin role; everyone else gets Operator. Set via `GenericOAuth` migration column.
- Per-session `owner_user_id` scoping: Admin sees all sessions; Operator/Viewer filtered to their own `owner_user_id`. Enforced in `apps/api/src/modules/sessions/sessions.service.ts`.
- Token exchange (`POST /auth/token-exchange`): `agent_assertion` subject type lets a platform/bot exchange an agent JWT on behalf of a user (RFC 8693). `oidc_jwt` subject type exchanges a raw external IdP JWT directly.
- Two-host ingress topology required for on-prem: `tabby-api.*` (API VirtualService) + `tabby-admin.*` (admin-UI VirtualService) — a single shared host does not work because the chart renders them as separate VirtualServices.
- `ADMIN_UI_ENABLED` env (chart: `.Values.adminUi.enabled`) gates the admin-UI Deployment, Service, VirtualService, and Ingress route (`/` path). Turning it off removes all admin-UI resources.

### Platform Integration
For how the Adopt platform calls Tabby (entry points, resolution flow, Token Manager, Playground Profile, deployment rules), see `docs/tabby-platform-handoff.md`.

### Controller Scaling (Multi-Replica)
- Reconcile loop uses `SELECT ... FOR UPDATE SKIP LOCKED` — multiple controller replicas process different apps in parallel
- Circuit breaker persisted in `circuit_breaker_state` DB table (shared across replicas, not in-memory)
- Pod creation is idempotent: pre-checks + catches K8s 409 AlreadyExists
- State machine retries 3x on version conflict (detects if another replica already transitioned)
- `RECONCILE_BATCH_SIZE` (default 50) controls apps/sessions per tick per replica
- `DB_POOL_SIZE` (default 20) configurable Postgres connection pool for API and Controller

### NATS Resilience
All services use `connectNats()` from `packages/shared/src/nats-connect.ts` with infinite reconnect, 2s wait, jitter. Status monitor calls `process.exit(1)` on permanent close (forces K8s restart instead of silent dead connection).

### Execute Endpoints (NoUI / Browser-Use)
Gated behind `execute_enabled` boolean on `applications` entity (migration 022). When enabled:
- `POST /execute/fetch` — runs `fetch()` inside the browser page, inherits cookies/TLS
- `POST /execute/browser` — runs Playwright commands (navigate, click, type, screenshot, HAR capture)
- Worker auth via JWT signed with `JWT_SIGNING_KEY` (2 min TTL), validates `tenant_id` match
- Commands: `navigate`, `click_element`, `click_by_text`, `click_at`, `type_text`, `type_into_label`, `press_key`, `get_page_summary`, `get_page_info`, `screenshot`, `wait_for_selector`, `scroll_page`, `har_start`, `har_stop`, `har_status`
- No raw JS evaluation, no file download/export, no multi-tab

### CDP Streaming Mode
Alternative to VNC — lighter (no Xvfb, no noVNC sidecar). Set `browser_policy.streaming_mode: "cdp"` in app template.
- Worker runs headless Chromium with CDP relay server on port 9223
- API proxies `/cdp-ws` with allowlisted CDP methods (screencast, input events, insertText)
- Canvas-based viewer renders JPEG frames from `Page.screencastFrame`
- Controller creates `{podName}-cdp` service instead of `{podName}-novnc`

### HPA (Horizontal Pod Autoscaler)
Optional HPA for API (max 4 replicas) and Controller (max 3 replicas). Disabled by default.
- `api.autoscaling.enabled: true` / `controller.autoscaling.enabled: true`
- Scales on CPU (70%) and memory (80%) utilization
- Worker pods do NOT auto-scale via HPA — managed by controller based on `desired_session_count`

## Database Migrations

24 migrations in `apps/api/src/migrations/`. TypeORM, `synchronize: false`, `migrationsRun: true`. Auto-run on API startup.

Latest: `1708300000023-ControllerScaling` — adds `last_reconciled_at` to applications, `last_evaluated_at` to sessions, creates `circuit_breaker_state` table.

Recent migrations (newest first):
- `...023-ControllerScaling` — Controller multi-replica support columns + circuit breaker table
- `...022-AddExecuteEnabled` — Adds `execute_enabled` boolean to `applications` (NoUI gating)
- `...021-DropIdpSecrets` — Removes legacy IdP client_id/secret from DB (now env vars)
- `...020-AddTemplateLineage` — Template-to-app lineage tracking
- `...019-AddRestartRequested` — Adds `restart_requested` to sessions
- `...018-GlobalIdp` — Global IdP configuration
- `...017-NullablePasswordHash` — Makes `password_hash` nullable for federated users
- `...016-GenericOAuth` — Generic IdP OAuth columns on `identity_providers`
- `...015-MultiTenantCloud` — Changes `tenants.id` to varchar; adds `tenant_id_claim`
- `...014-AddAppOwnerUserId` — Adds `owner_user_id` to `applications`
- `...013-AddIdleShutdown` — Adds `sessions.last_credential_request_at`
- `...012-AddAppTemplates` — Creates `app_templates` table
- `...011-AddOwnerUserIds` — Adds `owner_user_id` to `sessions` and `service_profiles`
- `...009-GenericHumanInput` — Adds `sessions.pending_input_request`, `interventions.input_request_metadata`

## Known Gotchas

1. **Postgres PVC password persistence** — Changing `postgresPassword` in values does NOT change the actual DB password. Must delete PVC + pod to re-init.
2. **NEXT_PUBLIC_* vars are browser-side** — Must be externally accessible URLs, not internal K8s DNS. Configured in `values-local.yaml` via `config.publicBaseUrl`.
3. **Slack bot modes** — `main.ts` in K8s (Socket Mode, 3 tokens, interactive buttons) vs `soft-hitl-bridge.ts` locally (bot token only, text commands + INPUT/RESOLVE).
4. **ArgoCD auto-sync with prune** — Manual `helm upgrade` will be reverted by ArgoCD.
5. **`tfy apply` replaces ALL values** — Must send full values every deploy (handled by `infra/tfy/deploy.yaml` template).
6. **Never `kubectl set env` locally** — Use `values-local.yaml` instead. Manual env overrides conflict with Helm on next upgrade.
7. **CSS selectors in DSL** — Attribute selectors must quote values: `[data-test-id="value"]` not `[data-test-id=value]`.
8. **`--enable-automation` flag** — Still present in Chromium flags, sets `navigator.webdriver = true`. Triggers bot detection.
9. **`TENANT_ENCRYPTION_KEY` on API pod** — Worker encrypts artifacts, API decrypts for `/credentials/request`. If API pod is missing the key, credentials return empty values silently. Must be set in `values-local.yaml` secrets or via `--set`.
10. **Salesforce Lightning SPA health check** — `dom_check` on `body` may fail (`isVisible()` returns false) even when logged in. Lightning SPA renders body differently. Consider `url_check` instead.
11. **`kind-reload-all` stale dist/** — Docker caches stale `dist/` folders. Makefile now runs `clean build docker-build` to fix.
12. **Salesforce OTP selector** — `input[name='Verification Code']` works for `wait_for` but NOT for `fill`. Correct selector: `input#smc`.
13. **Salesforce account lockout** — Blocks after ~5 failed OTP attempts. No automated backoff.
14. **Slack `expired_trigger_id` in Kind** — Socket Mode has >3s latency locally. Slack modals require trigger_id within 3s. Works in staging/prod.
15. **`screenshot` keepalive does not keep sessions alive** — `screenshot` only captures pixels, does NOT make HTTP requests. Server-side session timers keep ticking. Use `goto` (real navigation) or `evaluate` with `fetch()` for keepalive actions.
16. **`url_check` preferred over `dom_check` for SPAs** — `dom_check` on `body` returns `isVisible()=false` for SPAs like Salesforce Lightning and Workday even when logged in. Use `url_check` with `expect_status: 200` instead.
17. **`refresh_interval_seconds` defaults to 3600** — If not set in `export_policy`, credentials are only re-extracted once per hour. For volatile tokens (Salesforce aura, CSRF), set to 60-120.
18. **`streaming_mode` in `browser_policy`** — Valid values: `"vnc"` (default) or `"cdp"`. CDP mode runs headless Chromium without Xvfb/noVNC. Set to `"cdp"` for lighter sessions when VNC viewer is not needed.
19. **No initContainers for Postgres/Redis/MinIO/NATS** — Removed (required `runAsUser: 0`, rejected by PodSecurityAdmission in restricted namespaces). `fsGroup` handles volume ownership instead.
20. **Concurrent auto-provisioning race on `credentials/request`** — Catches Postgres duplicate-key (23505) and retries the lookup. See `apps/api/src/modules/credentials/credentials.service.ts`.
21. **Admin-UI ingress route gated on `adminUi.enabled`** — The `{{- if .Values.adminUi.enabled }}` block in `charts/browser-hitl/templates/ingress.yaml` controls the `/` route. Disabling admin-UI removes it cleanly.
22. **VNC access requires OAuth authentication** — Opening a VNC viewer URL sets a `tabby_vnc` HttpOnly cookie (1h TTL) via OAuth callback. Without it, the user hits the IdP login wall. Falls back to email gate if no OAuth IdP is configured. Wrong user → 403 (not a redirect loop). Currently owner-only (session owner matched via `owner_user_id` in cookie).
23. **Squash merge breaks long-lived branch sync** — Repo only allows squash merge. For feature→dev PRs this is fine, but syncing between long-lived branches (e.g. `dev`→`tabby-noui`) via GitHub PR causes the next sync to show ALL previous changes again (different SHAs). Sync locally instead: `git checkout target && git merge origin/source && git push`.

## Git

- Main branch: `dev`
- Squash merge enforced — PR title becomes the commit message
- Do NOT commit `values-staging.yaml` (contains secrets)
- Local deep-dive reference docs (if any) are not committed to git
