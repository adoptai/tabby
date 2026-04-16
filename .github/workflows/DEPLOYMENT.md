# Tabby Deployment Guide

How the CI/CD pipelines work, what they deploy, and what you need to configure.

---

## Service Map

Tabby is a monorepo with 7 services. Each service has its own Dockerfile and runs as a separate container/pod.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          EXTERNAL TRAFFIC                               │
│                  (Istio VirtualService / TLS)                           │
└──────────┬──────────────────────┬───────────────────────┬───────────────┘
           │                      │                       │
    ┌──────▼──────┐       ┌───────▼──────┐       ┌───────▼──────┐
    │  Admin UI   │       │   API        │       │ Egress Proxy │
    │  :8000      │──────▶│   :8000      │       │ :3128        │
    │  Next.js    │ calls │   NestJS     │       │ FQDN filter  │
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

### Service Ports

All services use port **8000** (API, Admin UI). Controller: **8090**, Worker health: **8091**. Do NOT use 3000 or 8080.

### Infrastructure (deployed by Helm chart)

| Service       | Image                | Purpose                                                            |
| ------------- | -------------------- | ------------------------------------------------------------------ |
| PostgreSQL 16 | `postgres:16-alpine` | Primary datastore — sessions, apps, users, tenants, audit trail    |
| Redis 7       | `redis:7-alpine`     | OTP relay (60s TTL), JWT blacklist, distributed locks              |
| NATS 2.10     | `nats:2.10-alpine`   | Durable event bus (JetStream) — HITL events, session state changes |
| MinIO         | `minio/minio`        | S3-compatible object storage for encrypted artifact bundles        |

> **Production:** Replace with managed services (RDS, ElastiCache, S3). See [Managed Services](#managed-services).

---

## Workflows

| File                     | Trigger               | What it does                                                              |
| ------------------------ | --------------------- | ------------------------------------------------------------------------- |
| `ci.yaml`                | PR to dev/main        | Commitlint → Lint → Test → Build check → Security audit → Helm lint      |
| `deploy-staging.yaml`    | Push to dev           | CI gates → Build images → Auto-bump chart → Push chart → tfy apply → Health check |
| `deploy-production.yaml` | Push to main / manual | CI gates → Build images → Push chart → tfy apply (with approval) → Health check   |

### Image Tag Convention

- **Staging:** `staging-{sha7}` (e.g., `staging-abc1234`), plus `staging-latest`
- **Production:** `prod-{sha7}` (e.g., `prod-abc1234`), plus `latest`

---

## GH_PAT (GitHub Personal Access Token)

The workflows use `GH_PAT` instead of the default `GITHUB_TOKEN` because:
- `GITHUB_TOKEN` cannot push commits that trigger other workflows (the version bump commit needs `[skip ci]`)
- `GITHUB_TOKEN` cannot push to GHCR with write access to packages in some org configurations

### Required permissions

- `repo` (full control of private repositories)
- `write:packages` (push Docker images and Helm charts to GHCR)

### How to create

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. Select the repository scope
3. Grant `Contents: Read and write` and `Packages: Read and write`
4. Set expiration (recommend 90 days) and add to your rotation calendar

### Where to set it

**Settings → Secrets and variables → Actions → Repository secrets** → `GH_PAT`

---

## GitHub Environments

Create two environments: `staging` and `production`.

**Settings → Environments → New environment**

- **staging**: No protection rules needed
- **production**: Add required reviewers (at least 1 team member must approve deploys)

### Secrets by scope

#### Repository-level secrets (Settings → Secrets → Actions)

| Secret    | Required | Purpose                                    |
| --------- | -------- | ------------------------------------------ |
| `GH_PAT`  | Yes      | GitHub PAT for checkout + push (see above) |

#### Environment-level secrets (per environment)

| Secret                      | Required | Env     | Purpose                                               |
| --------------------------- | -------- | ------- | ----------------------------------------------------- |
| `TFY_API_KEY`               | Yes      | Both    | TrueFoundry API key for `tfy apply`                   |
| `TFY_APP_NAME`              | Yes      | Both    | TrueFoundry application name                          |
| `TFY_WORKSPACE_FQN`         | Yes      | Both    | TrueFoundry workspace FQN                             |
| `API_HOST`                  | Yes      | Both    | Public hostname (e.g., `tabby-api.adoptai.dev`)       |
| `ADMIN_HOST`                | Yes      | Both    | Admin UI hostname (e.g., `tabby-admin.adoptai.dev`)   |
| `POSTGRES_PASSWORD`         | Yes      | Both    | PostgreSQL password                                   |
| `JWT_SIGNING_KEY`           | Yes      | Both    | JWT signing key (48+ chars, same across all services) |
| `TENANT_ENCRYPTION_KEY`     | Yes      | Both    | 64-char hex for AES-256-GCM (`openssl rand -hex 32`) |
| `MINIO_ACCESS_KEY`          | Yes      | Both    | MinIO / S3 access key                                 |
| `MINIO_SECRET_KEY`          | Yes      | Both    | MinIO / S3 secret key                                 |
| `ADMIN_BOOTSTRAP_PASSWORD`  | Yes      | Both    | First admin account password                          |
| `EGRESS_PROXY_ADMIN_TOKEN`  | Yes      | Both    | Auth for controller → proxy admin API                 |
| `EGRESS_PROXY_SESSION_KEY`  | Yes      | Both    | Signs per-session proxy credentials                   |
| `SERVICE_AUTH_CLIENT_ID`    | Yes      | Both    | Bot → API service auth client ID (you define this)    |
| `SERVICE_AUTH_CLIENT_SECRET`| Yes      | Both    | Bot → API service auth secret (`openssl rand -hex 32`)|
| `SERVICE_AUTH_ALLOWED_TENANT_IDS` | Yes | Both   | `*` (all tenants) or comma-separated UUIDs            |
| `SVC_AUTH_WILDCARD_SCOPE`  | Yes      | Both    | `true` if using `*` above                             |
| `SLACK_BOT_TOKEN`           | Yes      | Both    | Slack Bot User OAuth Token (`xoxb-...`)               |
| `SLACK_SIGNING_SECRET`      | Yes      | Both    | Slack request verification                            |
| `SLACK_APP_TOKEN`           | Yes      | Both    | Slack Socket Mode token (`xapp-...`)                  |
| `METRICS_AUTH_TOKEN`        | Yes      | Both    | Protects `/metrics` endpoint                          |
| `NATS_AUTH_TOKEN`           | Yes      | Both    | NATS authentication token                             |

#### Optional managed service overrides

| Secret             | Default    | Purpose                                          |
| ------------------ | ---------- | ------------------------------------------------ |
| `DATABASE_URL`     | (in-cluster) | External PostgreSQL URL (e.g., RDS)            |
| `REDIS_URL`        | (in-cluster) | External Redis URL (e.g., ElastiCache)         |
| `NATS_URL`         | (in-cluster) | External NATS URL                              |
| `MINIO_ENDPOINT`   | (in-cluster) | External S3-compatible endpoint                |
| `POSTGRES_ENABLED` | `true`     | Set to `false` when using managed PostgreSQL     |
| `REDIS_ENABLED`    | `true`     | Set to `false` when using managed Redis          |
| `NATS_ENABLED`     | `true`     | Set to `false` when using managed NATS           |
| `MINIO_ENABLED`    | `true`     | Set to `false` when using managed object storage |

When a secret is not set, it defaults to empty string → Helm `default` function falls back to the in-cluster service URL. No changes needed for staging.

---

## Managed Services

For production, replace in-cluster StatefulSets with managed services:

| In-cluster | Managed replacement | Config override   | Disable flag          |
| ---------- | ------------------- | ----------------- | --------------------- |
| PostgreSQL | AWS RDS / Azure DB  | `DATABASE_URL`    | `POSTGRES_ENABLED=false` |
| Redis      | ElastiCache / Azure Cache | `REDIS_URL` | `REDIS_ENABLED=false`    |
| NATS       | (usually in-cluster) | `NATS_URL`       | `NATS_ENABLED=false`     |
| MinIO      | S3 / Azure Blob     | `MINIO_ENDPOINT`  | `MINIO_ENABLED=false`    |

**How it works:**
1. Set `DATABASE_URL=postgresql://...` in the production environment secrets
2. Set `POSTGRES_ENABLED=false` to skip deploying the in-cluster PostgreSQL StatefulSet
3. The Helm configmap template uses `default $constructedUrl .Values.config.databaseUrl` — when the override is set, it wins

### Egress Proxy

The egress proxy allowlist is hardcoded in `infra/tfy/deploy.yaml` (~95 domains). This is intentional:
- The list rarely changes
- It's not secret (just domain patterns)
- Changes are reviewable in PRs
- The proxy must run in-cluster (workers route all browser traffic through it)

---

## Conventional Commits

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

feat: add OTP retry logic
fix: handle empty allowlist in egress proxy
chore: update dependencies
ci: add commitlint to PR checks
```

Enforced by:
- **Local:** Husky `commit-msg` hook runs commitlint
- **CI:** `commitlint` job in `ci.yaml` validates all PR commits

### Chart Version Auto-Bump

On push to `dev`, the staging workflow automatically bumps the chart version:

- `feat:` or `feat(scope):` → **minor** bump (0.X+1.0)
- Everything else (`fix:`, `chore:`, `ci:`, etc.) → **patch** bump (0.0.X+1)

The bump commit uses `[skip ci]` to prevent re-triggering the workflow.

**Important:** Enforce squash merges on the `dev` branch so the commit message is the PR title (which must be conventional). Production reads whatever version is in Chart.yaml — no auto-bump.

---

## Verification Commands

### Check deployed version

```bash
curl -s https://tabby-api.adoptai.dev/health/live | jq .
# Returns: { "status": "ok", "version": "0.1.6", "commit": "abc1234..." }
```

### Check pods

```bash
kubectl get pods -n azure-ws -l app.kubernetes.io/instance=tabby-dev
kubectl logs -n azure-ws deploy/tabby-dev-browser-hitl-api --tail=50
```

### Verify Helm release

```bash
kubectl get applications.argoproj.io tabby-dev -n azure-ws -o jsonpath='{.spec.source.targetRevision}'
```

### Local Helm validation

```bash
helm lint charts/browser-hitl/
helm template tabby-dev charts/browser-hitl/ | grep -c "kind:"
```

---

## Common Gotchas

| Problem                                       | Cause                                                              | Fix                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Admin UI shows `ERR_NAME_NOT_RESOLVED`        | `NEXT_PUBLIC_API_URL` points to internal K8s DNS                   | Set to the external URL the **browser** can reach                         |
| Stream URLs return `http://localhost/vnc/...`  | `STREAM_HOST` not set on API                                       | Set to public hostname (e.g., `tabby-api.adoptai.dev`)                    |
| Slack bot silent after deploy                  | NATS wasn't ready when bot started — no retry                      | Restart the bot pod after NATS is healthy                                 |
| Worker pods crash-loop                         | Egress proxy down → controller can't set allowlists                | Restart egress proxy first, then controller                               |
| `JWT_SIGNING_KEY` mismatch                     | API and bots have different keys → 401s                            | All services must share the exact same key                                |
| Helm upgrade breaks env overrides              | `kubectl set env` overrides lost on upgrade                        | Use Helm values or TrueFoundry config                                     |
| Postgres password unchanged after values edit  | PVC retains old password from init                                 | Delete PVC + pod to re-init                                               |
| Chart push fails "already exists"              | Version wasn't bumped (manual push or prod re-push)                | Production uses `\|\| echo "already exists"` — this is expected           |
