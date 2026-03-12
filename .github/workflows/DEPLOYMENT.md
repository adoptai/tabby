# Tabby Deployment Guide

How the CI/CD pipelines work, what they deploy, and what you need to configure manually.

---

## Service Map

Tabby is a monorepo with 7 services. Each service has its own Dockerfile and runs as a separate container/pod.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          EXTERNAL TRAFFIC                               │
│                         (Ingress / TLS)                                 │
└──────────┬──────────────────────┬───────────────────────┬───────────────┘
           │                      │                       │
    ┌──────▼──────┐       ┌───────▼──────┐       ┌───────▼──────┐
    │  Admin UI   │       │   API        │       │ Egress Proxy │
    │  :3000      │──────▶│   :8080      │       │ :3128        │
    │  Express    │ calls │   NestJS     │       │ FQDN filter  │
    └─────────────┘       └──┬───┬───┬───┘       └──────┬───────┘
                             │   │   │                   │
              ┌──────────────┘   │   └──────────┐       │
              │                  │               │       │
    ┌─────────▼───┐   ┌─────────▼──┐   ┌────────▼──┐   │
    │ Controller  │   │  Slack Bot │   │ Teams Bot │   │
    │ :8090       │   │  NATS sub  │   │ Bot Frmwk │   │
    │ Pod manager │   └────────────┘   └───────────┘   │
    └──────┬──────┘                                     │
           │ creates/destroys                           │
    ┌──────▼──────────────────────────────────────┐     │
    │  Worker Pods (1 per session)                 │────┘
    │  Playwright + Chromium + VNC/CDP             │ all browser
    │  Login DSL execution, artifact extraction    │ traffic goes
    └──────────────────────────────────────────────┘ through proxy
```

### Service Roles


| Service          | Image                        | Port | What it does                                                                                                                                                                  |
| ---------------- | ---------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API**          | `Dockerfile.api`             | 8080 | Central REST API — auth, CRUD, HITL operations, streaming, metrics. All clients talk to this.                                                                                 |
| **Controller**   | `Dockerfile.controller`      | 8090 | Watches session state in DB, creates/destroys Worker pods in K8s. Calls egress proxy admin API to set per-session allowlists.                                                 |
| **Worker**       | `Dockerfile.worker`          | 8091 | Ephemeral pod (1 per session). Runs Playwright + CloakBrowser, executes Login DSL, extracts artifacts. Heaviest resource consumer.                                            |
| **Slack Bot**    | `Dockerfile.slack-bot`       | —    | Subscribes to NATS events, posts HITL notifications to Slack, relays OTP codes from operators.                                                                                |
| **Teams Bot**    | `Dockerfile.teams-bot`       | 3978 | Same as Slack Bot but for Microsoft Teams via Bot Framework.                                                                                                                  |
| **Admin UI**     | `Dockerfile.admin-ui`        | 3000 | Express server rendering the admin dashboard. Proxies API calls to the API service internally.                                                                                |
| **Egress Proxy** | ConfigMap + `node:20-alpine` | 3128 | FQDN allowlist enforcement. All browser traffic from Worker pods routes through this. No custom Docker image — it's `node:20-alpine` running a ConfigMap-mounted `server.js`. |


### Infrastructure (not built by CI)

These are off-the-shelf images deployed by the Helm chart:


| Service       | Image                | Purpose                                                            |
| ------------- | -------------------- | ------------------------------------------------------------------ |
| PostgreSQL 16 | `postgres:16-alpine` | Primary datastore — sessions, apps, users, tenants, audit trail    |
| Redis 7       | `redis:7-alpine`     | OTP relay (60s TTL), JWT blacklist, distributed locks              |
| NATS 2.10     | `nats:2.10-alpine`   | Durable event bus (JetStream) — HITL events, session state changes |
| MinIO         | `minio/minio`        | S3-compatible object storage for encrypted artifact bundles        |


> **Production:** Replace PostgreSQL, Redis, and MinIO with managed services (RDS, ElastiCache, S3). Only NATS runs in-cluster.

---

## What the Workflows Build vs. What You Configure

### What CI/CD handles automatically

- Lint, test, security audit on every PR
- Docker image builds for all 7 services (parallel, cached)
- Push to GHCR (`ghcr.io/adoptai/tabby/<service>`)
- TrueFoundry `patch-application` to trigger deployment
- Post-deploy health checks

### What you must configure manually

The workflows build and deploy the containers, but they **do not** manage secrets, environment variables, or infrastructure. You need to set these up in your deployment platform (TrueFoundry, Helm, or whatever orchestrates the pods).

---

## Required Secrets (GitHub Actions)

Set these in **Settings → Secrets and variables → Actions**:


| Secret               | Required | Purpose                                                                  |
| -------------------- | -------- | ------------------------------------------------------------------------ |
| `TFY_API_KEY`        | Yes      | TrueFoundry API key for deployments                                      |
| `STAGING_API_URL`    | No       | e.g. `https://tabby-staging.example.com` — for post-deploy health checks |
| `PRODUCTION_API_URL` | No       | e.g. `https://tabby.example.com` — for post-deploy health checks         |


`GITHUB_TOKEN` is provided automatically (used for GHCR push).

---

## Required Environment Variables (per service)

These must be configured in your deployment platform (TrueFoundry app settings, Helm values, or K8s ConfigMaps/Secrets).

### All services need


| Variable                | Example                                         | Notes                                         |
| ----------------------- | ----------------------------------------------- | --------------------------------------------- |
| `DATABASE_URL`          | `postgresql://user:pass@host:5432/browser_hitl` | Managed DB in prod                            |
| `REDIS_URL`             | `redis://host:6379`                             | Managed Redis in prod                         |
| `NATS_URL`              | `nats://browser-hitl-nats:4222`                 | In-cluster NATS                               |
| `JWT_SIGNING_KEY`       | 48+ char random string                          | **Must be identical** across API and all bots |
| `TENANT_ENCRYPTION_KEY` | 64-char hex (`openssl rand -hex 32`)            | Per-tenant AES-256-GCM key for artifacts      |
| `NODE_ENV`              | `production`                                    | Enables production optimizations              |


### API-specific


| Variable                                                   | Example                     | Notes                                             |
| ---------------------------------------------------------- | --------------------------- | ------------------------------------------------- |
| `ADMIN_BOOTSTRAP_EMAIL`                                    | `admin@yourdomain.com`      | First admin account (created on first startup)    |
| `ADMIN_BOOTSTRAP_PASSWORD`                                 | strong random               | Change after first login                          |
| `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | —                           | Or S3 credentials in prod                         |
| `CORS_ORIGIN`                                              | `https://tabby.example.com` | **Not** `*` in production                         |
| `METRICS_AUTH_TOKEN`                                       | random hex                  | Protects `/metrics` endpoint                      |
| `STREAM_HOST`                                              | `tabby.example.com`         | Used to build VNC stream URLs returned to clients |
| `SERVICE_AUTH_CLIENT_ID` / `SERVICE_AUTH_CLIENT_SECRET`    | —                           | For bot → API service token auth                  |


### Slack Bot


| Variable               | Example                        | Notes                        |
| ---------------------- | ------------------------------ | ---------------------------- |
| `SLACK_BOT_TOKEN`      | `xoxb-...`                     | Bot User OAuth Token         |
| `SLACK_SIGNING_SECRET` | from Slack app                 | For request verification     |
| `SLACK_APP_TOKEN`      | `xapp-...`                     | For Socket Mode              |
| `SLACK_CHANNEL`        | `tabby-alerts`                 | Default notification channel |
| `API_BASE_URL`         | `http://browser-hitl-api:8080` | Internal API address         |


### Teams Bot


| Variable                 | Example        | Notes                |
| ------------------------ | -------------- | -------------------- |
| `MICROSOFT_APP_ID`       | from Azure Bot | Bot Framework app ID |
| `MICROSOFT_APP_PASSWORD` | from Azure Bot | Bot Framework secret |


### Admin UI


| Variable              | Example                     | Notes                                                  |
| --------------------- | --------------------------- | ------------------------------------------------------ |
| `NEXT_PUBLIC_API_URL` | `https://tabby.example.com` | **Browser-facing** API URL (not internal service name) |


### Controller

No extra env vars beyond the shared ones. It discovers other services via K8s DNS:

- API: `http://browser-hitl-api:8080`
- Egress proxy admin: `http://browser-hitl-egress-proxy:8095`

### Egress Proxy


| Variable                         | Example                 | Notes                                      |
| -------------------------------- | ----------------------- | ------------------------------------------ |
| `EGRESS_PROXY_ADMIN_TOKEN`       | random hex              | Authenticates controller → proxy admin API |
| `EGRESS_PROXY_SESSION_KEY`       | random hex              | Signs per-session proxy credentials        |
| `EGRESS_PROXY_DEFAULT_ALLOWLIST` | comma-separated domains | Baseline domains allowed for all sessions  |


---

## Deployment Checklist

### Staging

- TrueFoundry applications created for: api, controller, worker, slack-bot, admin-ui
- TrueFoundry FQNs updated in `deploy-staging.yaml` matrix
- `TFY_API_KEY` secret set in GitHub
- All env vars configured in TrueFoundry for each service
- PostgreSQL, Redis, NATS, MinIO/S3 accessible from staging cluster
- Egress proxy allowlist includes all target portal domains
- `STAGING_API_URL` secret set (optional, for health checks)

### Production

- Same as staging, plus:
- GitHub environment `production` created with required reviewers
- TLS enabled (cert-manager + `letsencrypt-prod`)
- NATS auth enabled (`nats.auth.enabled: true`)
- Network policies enabled
- `CORS_ORIGIN` set to exact domain (not `*`)
- Managed PostgreSQL with automated backups
- Managed Redis with persistence
- Managed S3/GCS instead of MinIO
- `PRODUCTION_API_URL` secret set (optional, for health checks)
- Monitoring: kube-prometheus-stack + PrometheusRules enabled

---

## Common Gotchas


| Problem                                       | Cause                                                                                                    | Fix                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Admin UI shows `ERR_NAME_NOT_RESOLVED`        | `NEXT_PUBLIC_API_URL` set to internal K8s DNS (`http://browser-hitl-api:8080`) instead of the public URL | Set it to the external URL the **browser** can reach                      |
| Stream URLs return `http://localhost/vnc/...` | `STREAM_HOST` not set on API                                                                             | Set to public hostname (e.g. `tabby.example.com`)                         |
| Slack bot silent after deploy                 | NATS wasn't ready when bot started — connection fails permanently                                        | Restart the bot pod after NATS is healthy                                 |
| Worker pods crash-loop                        | Egress proxy is down → controller can't set allowlists → kills worker                                    | Restart egress proxy first, then controller                               |
| `JWT_SIGNING_KEY` mismatch                    | API and bots have different keys → tokens from API are invalid for bot → 401                             | Ensure **all services** share the exact same `JWT_SIGNING_KEY`            |
| Helm upgrade breaks env overrides             | `kubectl set env` overrides are lost on `helm upgrade`                                                   | Use Helm values or TrueFoundry config instead of manual `kubectl set env` |
| Security audit fails CI                       | `pnpm audit` found high/critical vulnerability                                                           | Update the dependency or add to `.pnpmfile.cjs` audit overrides           |


---

## TrueFoundry Application FQNs

Update these in the workflow files once applications are created:


| Service    | Staging FQN                                             | Production FQN                                        |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------- |
| API        | `tfy-dev-cluster:adopt-dev-ws:tabby-api-staging`        | `tfy-dev-cluster:adopt-prod-ws:tabby-api-prod`        |
| Controller | `tfy-dev-cluster:adopt-dev-ws:tabby-controller-staging` | `tfy-dev-cluster:adopt-prod-ws:tabby-controller-prod` |
| Worker     | `tfy-dev-cluster:adopt-dev-ws:tabby-worker-staging`     | `tfy-dev-cluster:adopt-prod-ws:tabby-worker-prod`     |
| Slack Bot  | `tfy-dev-cluster:adopt-dev-ws:tabby-slack-bot-staging`  | `tfy-dev-cluster:adopt-prod-ws:tabby-slack-bot-prod`  |
| Admin UI   | `tfy-dev-cluster:adopt-dev-ws:tabby-admin-ui-staging`   | `tfy-dev-cluster:adopt-prod-ws:tabby-admin-ui-prod`   |


> **Note:** Teams Bot and noVNC sidecar are not deployed standalone via TrueFoundry. The noVNC sidecar is bundled into Worker pods by the Controller. Teams Bot can be added when needed.

---

## Workflow File Reference


| File                     | Trigger               | What it does                                                                                 |
| ------------------------ | --------------------- | -------------------------------------------------------------------------------------------- |
| `ci.yaml`                | PR to dev/main        | Lint → Test → Build check → Security audit → Helm lint                                       |
| `deploy-staging.yaml`    | Push to dev           | CI gates → Build 7 images (GHCR) → TrueFoundry staging → Health check                        |
| `deploy-production.yaml` | Push to main / manual | CI gates (strict) → Build images → TrueFoundry prod (with approval) → Health check → Summary |


