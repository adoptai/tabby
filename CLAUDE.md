# Tabby (Browser HITL)

Browser Human-In-The-Loop platform. Workers run Playwright/Chromium to execute Login DSL scripts, with human intervention via Slack/VNC when automation gets stuck (OTP, CAPTCHA, MFA).

## Build & Test

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run lint
helm lint charts/browser-hitl/
```

**Before committing:** Pre-commit hook runs `lint-staged` + `pnpm run build` + `pnpm run test` automatically via Husky. Commit-msg hook validates conventional commits via commitlint.

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
- `infra/tfy/deploy.yaml` — TrueFoundry manifest template (envsubst placeholders)

## Local Development (Kind)

```bash
make kind-create          # one-time: create Kind cluster
make kind-reload-all      # build images + load + helm upgrade with values-local.yaml
make k8s-port-forward     # forward API (18080), Admin UI (13000), Postgres, Redis, MinIO, NATS
```

All local config (API URL, stream host, service auth, secrets) is in `values-local.yaml` — no manual `kubectl set env` needed.

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
- `deploy-production.yaml` — Push to `main`: same flow with manual confirmation gate + required reviewers
- Secrets are in GitHub Environments (`staging` / `production`), injected via envsubst into `infra/tfy/deploy.yaml`

### Conventional Commits (enforced)

PR titles MUST follow conventional commits (squash merge makes PR title the commit message):
- `feat:` → minor version bump (0.X+1.0)
- `fix:`, `chore:`, `ci:`, etc. → patch bump (0.0.X+1)
- Enforced by: Husky commit-msg hook (local) + CI PR title check

## Staging Deployment (TrueFoundry)

- Platform: TrueFoundry (wraps ArgoCD)
- Cluster: `adopt-azure-cluster`, namespace: `azure-ws`
- Helm release name: `tabby-dev`
- ArgoCD manages deployment — `helm install/upgrade` directly will CONFLICT
- Domains: `tabby-api.adoptai.dev` (API), `tabby-admin.adoptai.dev` (Admin UI)
- Istio gateway: `istio-system/tfy-wildcard`

## Architecture Notes

### HITL Flow
Worker detects OTP/MFA → signals `AUTH_FAIL` via DB → Controller transitions to `LOGIN_NEEDED` → Creates intervention + sets baton to `HUMAN_REQUESTED` → Publishes NATS events → Slack bot posts notification → Human either submits OTP via Slack (Redis relay) or takes over browser via VNC → Releases control → Worker resumes

### Baton State Machine
`AUTOMATION_CONTROL → HUMAN_REQUESTED → HUMAN_CONTROL → HUMAN_RELEASED → AUTOMATION_CONTROL`

### Service Profile State Machine
`STAGING → CANARY → ACTIVE → RETIRED`
- `recordCanaryResult()` is dead code — canary_request_count never increments
- Credentials (`POST /credentials/request`) require ACTIVE profile
- Workaround: direct DB update to skip canary gate

## Known Gotchas

1. **Postgres PVC password persistence** — Changing `postgresPassword` in values does NOT change the actual DB password. Must delete PVC + pod to re-init.
2. **NEXT_PUBLIC_* vars are browser-side** — Must be externally accessible URLs, not internal K8s DNS. Configured in `values-local.yaml` via `config.publicBaseUrl`.
3. **Slack bot modes** — `main.ts` in K8s (Socket Mode, 3 tokens, interactive buttons) vs `soft-hitl-bridge.ts` locally (bot token only, text commands).
4. **ArgoCD auto-sync with prune** — Manual `helm upgrade` will be reverted by ArgoCD.
5. **No OTP retry** — Wrong OTP code kills the session, no retry logic.
6. **`recordCanaryResult()` never called** — Canary promotion gate is dead code. Must bypass via DB.
7. **`tfy apply` replaces ALL values** — Must send full values every deploy (handled by `infra/tfy/deploy.yaml` template).
8. **Never `kubectl set env` locally** — Use `values-local.yaml` instead. Manual env overrides conflict with Helm on next upgrade.

## Git

- Main branch: `dev`
- Squash merge enforced — PR title becomes the commit message
- Do NOT commit `values-staging.yaml` (contains secrets)
- The 3 `.md` files in root (`tabby-deep-dive.md`, `abcd-deep-dive.md`, `tabby-abcd-integration-guide.md`) are local reference docs, not committed
