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

## Database Migrations

17 migrations in `apps/api/src/migrations/`. TypeORM, `synchronize: false`, `migrationsRun: true`. Auto-run on API startup.

Latest: `1708300000016-GenericOAuth` — adds `client_secret`, `auth_url`, `token_url`, `userinfo_url`, `sign_out_url`, `scopes`, `admin_domains`, `name_claim` to `identity_providers` (Generic IdP / browser OAuth support).

Recent migrations (newest first):
- `...016-GenericOAuth` — Generic IdP OAuth columns on `identity_providers` (see above)
- `...015-MultiTenantCloud` — Changes `tenants.id` from uuid to varchar for custom IDs (Frontegg org IDs); adds `tenant_id_claim` to `identity_providers`; fixes `service_profiles` unique indexes to include `owner_user_id`
- `...014-AddAppOwnerUserId` — Adds `owner_user_id` to `applications`
- `...013-AddIdleShutdown` — Adds `sessions.last_credential_request_at` for idle shutdown tracking
- `...012-AddAppTemplates` — Creates `app_templates` table
- `...011-AddOwnerUserIds` — Adds `owner_user_id` to `sessions` and `service_profiles`; adds `oidc`/`saml` to identity_provider enum
- `...009-GenericHumanInput` — Adds `sessions.pending_input_request` (JSONB), `interventions.input_request_metadata` (JSONB), `INPUT_NEEDED` to intervention type enum

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
18. **`streaming_mode` ignored in `browser_policy`** — Not a valid field. VNC streaming is always enabled for HITL sessions. Remove from app payloads.
19. **No initContainers for Postgres/Redis/MinIO/NATS** — Removed (required `runAsUser: 0`, rejected by PodSecurityAdmission in restricted namespaces). `fsGroup` handles volume ownership instead.
20. **Concurrent auto-provisioning race on `credentials/request`** — Catches Postgres duplicate-key (23505) and retries the lookup. See `apps/api/src/modules/credentials/credentials.service.ts`.
21. **Admin-UI ingress route gated on `adminUi.enabled`** — The `{{- if .Values.adminUi.enabled }}` block in `charts/browser-hitl/templates/ingress.yaml` controls the `/` route. Disabling admin-UI removes it cleanly.

## Git

- Main branch: `dev`
- Squash merge enforced — PR title becomes the commit message
- Do NOT commit `values-staging.yaml` (contains secrets)
- Local deep-dive reference docs (if any) are not committed to git
