# Tabby (Browser HITL)

Browser Human-In-The-Loop platform. Workers run Playwright/Chromium to execute Login DSL scripts, with human intervention via Slack/VNC when automation gets stuck (OTP, CAPTCHA, MFA).

## Build & Test

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run lint
```

## Project Structure

Monorepo (NX + pnpm workspaces):
- `apps/api` — NestJS REST API (port 8000)
- `apps/controller` — Watches sessions, creates/destroys worker pods
- `apps/worker` — Ephemeral Playwright pod, executes Login DSL
- `apps/slack-bot` — NATS subscriber, Slack notifications + OTP relay
- `apps/teams-bot` — Microsoft Teams equivalent
- `apps/admin-ui` — Next.js dashboard (port 8000)
- `packages/shared` — Shared types, enums, state machines
- `charts/browser-hitl` — Helm chart for K8s deployment
- `infra/docker/` — 7 Dockerfiles (api, controller, worker, novnc, slack-bot, teams-bot, admin-ui)

## Ports (standardized)

ALL services run on port 8000 (API, Admin UI). Controller: 8090, Worker health: 8091. Do NOT use 3000 or 8080 — those are legacy.

## Docker Images

Registry: `ghcr.io/adoptai/tabby/{service}:{tag}`
Build: `docker build -f infra/docker/Dockerfile.{service} -t ghcr.io/adoptai/tabby/{service}:{tag} .`

7 images: api, controller, worker, novnc, slack-bot, teams-bot, admin-ui

## Helm Chart

- Chart: `oci://ghcr.io/adoptai/charts/browser-hitl`
- Package: `helm package charts/browser-hitl/ && helm push browser-hitl-{version}.tgz oci://ghcr.io/adoptai/charts`
- Lint: `helm lint charts/browser-hitl/`
- Template test: `helm template tabby-dev charts/browser-hitl/ -f charts/browser-hitl/values-staging.yaml`

### Key Helm patterns

- Service names are dynamic: `{{ include "browser-hitl.fullname" . }}-{component}` (e.g., `tabby-dev-browser-hitl-api`)
- NEVER hardcode service names in values files — use templates with the fullname helper
- ConfigMap URLs (Redis, NATS, MinIO) are auto-generated from fullname helper in `configmap.yaml`
- VirtualServices are auto-generated in `templates/virtualservices.yaml` — only the `host` field needs to come from values

### Values files

- `values.yaml` — defaults (DO NOT put secrets here)
- `values-staging.yaml` — staging overrides, NOT committed to git (contains secrets)
- `values-production.yaml` — production template
- `values-staging-backup-0.1.4.yaml` — backup of running staging config before 0.1.5

## Staging Deployment (TrueFoundry)

- Platform: TrueFoundry (wraps ArgoCD)
- Cluster: `adopt-azure-cluster`, namespace: `azure-ws`
- Helm release name: `tabby-dev`
- Application ID: `cmmndf24i3odr01qbeit45nfw`
- Workspace ID: `cmknxazcu05ot01o13zn7b97c`
- ArgoCD manages the deployment — `helm install/upgrade` directly will CONFLICT
- To update: `kubectl edit applications.argoproj.io tabby-dev -n azure-ws` or TrueFoundry UI
- Safer edit: `kubectl get applications.argoproj.io tabby-dev -n azure-ws -o yaml > /tmp/tabby-app.yaml`, edit, then `kubectl apply -f /tmp/tabby-app.yaml`
- Domains: `tabby-api.adoptai.dev` (API), `tabby-admin.adoptai.dev` (Admin UI)
- Istio gateway: `istio-system/tfy-wildcard`

## CI/CD (.github/workflows/)

- `ci.yaml` — PR validation: lint, test, build check, security audit, helm lint
- `deploy-staging.yaml` — Triggers on push to `dev`. Builds images, pushes to GHCR. Deploy step is BROKEN (uses per-service FQNs that don't exist). Pending: rewrite to use `tfy apply` with single Helm manifest
- `deploy-production.yaml` — Triggers on push to `main` with manual confirmation gate

## Architecture Notes

### HITL Flow
Worker detects OTP/MFA → signals `AUTH_FAIL` via DB → Controller transitions to `LOGIN_NEEDED` → Creates intervention + sets baton to `HUMAN_REQUESTED` → Publishes NATS events → Slack bot posts notification → Human either submits OTP via Slack (Redis relay) or takes over browser via VNC → Releases control → Worker resumes

### Baton State Machine
`AUTOMATION_CONTROL → HUMAN_REQUESTED → HUMAN_CONTROL → HUMAN_RELEASED → AUTOMATION_CONTROL`

### NATS Events
- `hitl.started.{tenantId}.{sessionId}`
- `hitl.otp-requested.{tenantId}.{sessionId}`
- `hitl.completed.{tenantId}.{sessionId}`
- `session.state.changed.{tenantId}.{sessionId}`

### Key API Endpoints
- `POST /sessions/:id/stream` — VNC stream URL
- `POST /sessions/:id/takeover` — Acquire baton
- `POST /sessions/:id/release` — Release baton
- `POST /sessions/:id/otp` — Submit OTP (stored in Redis, 60s TTL)
- `POST /sessions/:id/acknowledge` — Acknowledge failure, retry

## Known Gotchas

1. **Postgres PVC password persistence** — Changing `postgresPassword` in values does NOT change the actual DB password. Must delete PVC + pod to re-init.
2. **NEXT_PUBLIC_* vars are browser-side** — Must be externally accessible URLs, not internal K8s DNS.
3. **Slack bot runs main.ts in K8s** (Socket Mode, needs 3 tokens) vs `soft-hitl-bridge.ts` locally (only needs bot token).
4. **ArgoCD auto-sync with prune** — Manual `helm upgrade` will be reverted by ArgoCD.
5. **`--enable-automation` flag** — Still present in Chromium flags, sets `navigator.webdriver = true`. Triggers bot detection.
6. **OTP consumer not wired** — `consumeOtpRequested()` exists in `nats-listener.ts` but is never called in `main.ts`.
7. **No OTP retry** — Wrong OTP code kills the session, no retry logic.

## Git

- Main branch: `dev`
- Current work branch: `ci/github-actions-pipelines`
- Do NOT commit `values-staging.yaml` (contains secrets)
