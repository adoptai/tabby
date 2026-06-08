# Tabby Setup Guide

Setup guide for deploying and configuring Tabby (Browser HITL). **Assumes the Adopt platform are already configured with IDP/OAuth authentication.**

---

## Prerequisites

### Platform-Side (must be done before Tabby setup)

- `tabby` feature flag enabled for the organization
- Actions that should use Tabby have `use_tabby` set in deployment rules (`db_org_action_rules`) Can be setted in the UI
- **Token Manager configured with TABBY storage type entries**
- **Playground Profile configured with Tabby URL and IDP ID**

### Infrastructure

- External DNS entry for Tabby API (e.g., `tabby-api.customer.com`)
- Outbound HTTPS access to the IDP's JWKS endpoint (for JWT validation)

> **Infrastructure note:** The current Helm chart is self-contained — it bundles PostgreSQL, Redis, NATS, and MinIO as subchart dependencies. External managed services (e.g., AWS RDS, ElastiCache, Amazon S3) are not fully supported yet through Helm values. **Support for external managed infrastructure is planned for a future release.**

---

## Architecture

```
Customer Network / On-Prem                        Adopt Cloud
┌──────────────────────────┐                 ┌──────────────────────┐
│  Tabby API (port 8000)   │◄──────────────► │  Adopt Platform      │
│  Controller (port 8090)  │   token-exchange│                      │
│  Worker Pods (ephemeral) │   credentials   │                      │
│  Redis, Postgres, NATS   │                 │   IDP                │
│  MinIO                   │                 └──────────────────────┘
└──────────────────────────┘                         │
         │                                           │
         └──── JWKS fetch (HTTPS) ──────────────────►│
```

- **Tabby API must have a public DNS entry and external ingress** — the **API serves VNC/noVNC streaming links**, handles token exchange requests from the platform, and accepts WebSocket connections from end-user browsers. Without a publicly reachable URL (e.g., `https://tabby-api.customer.com`), no part of Tabby works. This URL is configured as `config.publicBaseUrl` in the Helm values.
- **WebSocket support required on the ingress** — VNC/CDP streaming uses long-lived WebSocket connections. The ingress must support HTTP upgrade with timeouts of at least 3600 seconds.
- **Admin UI is useless for now** — Tabby does not depend on it for core functionality. It can be disabled (`adminUi.enabled: false`). The API Swagger (`/api/docs`) serves as an alternative for administrative tasks. For now, we need to maintain as disabled because it's not useful
- **Proxy/WAF** — Tabby can sit behind a reverse proxy or WAF. Currently Tabby does not support exposing only specific routes; all API routes are served on the same port. If route-level restriction is needed, configure it at the proxy layer.

### Ingress Configuration

The Helm chart includes a standard Kubernetes Ingress resource (disabled by default). It supports NGINX Ingress Controller out of the box:

```yaml
ingress:
  enabled: true
  ingressClassName: nginx
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  hosts:
    - host: tabby-api.customer.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: tabby-api-tls
      hosts:
        - tabby-api.customer.com
```

**If using Istio:** The chart does not include Istio VirtualService resources. If your cluster uses Istio instead of NGINX Ingress, leave `ingress.enabled: false` and create the VirtualService manually or through your existing Istio configuration. The API service is exposed at `<release-name>-adopt-tabby-api:8000` inside the cluster.

**Note: Tabby provided values.yaml already is configured using istio like in the platform.**

**WebSocket support is required:** VNC/CDP streaming uses WebSocket connections. Ensure your ingress controller (or Istio gateway) supports WebSocket upgrades with long timeouts (3600s recommended for VNC sessions).

### Node Scheduling (Karpenter, nodeSelector, affinity, tolerations)

All components support standard Kubernetes scheduling primitives through Helm values. No Karpenter-specific configuration is hardcoded in the chart — it works with any scheduler.

```yaml
# Example: place API pods on specific nodes
api:
  nodeSelector:
    workload-type: "tabby-api"
  tolerations:
    - key: "dedicated"
      operator: "Equal"
      value: "tabby"
      effect: "NoSchedule"
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          preference:
            matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values: ["m5.xlarge", "m5.2xlarge"]
```

The same `nodeSelector`, `tolerations`, and `affinity` blocks are available for: `api`, `controller`, `worker`, `postgresql`, `redis`, `nats`, `minio`, `egressProxy`, `slackBot`, `teamsBot`.

**Defaults:** All scheduling fields default to empty (`{}` / `[]`), meaning pods are scheduled on any available node. If your cluster uses Karpenter, you can add Karpenter-specific node selectors through these same fields. If not, leave them empty.

> **Note on worker pods:** The `worker.nodeSelector/tolerations/affinity` values are defined in the chart but are not currently propagated to dynamically created worker pods. Worker pods are created by the controller at runtime and use the namespace's default scheduling. This is a known limitation — if you need worker pods on specific nodes, configure the scheduling at the namespace level or via a mutating webhook.

### Auto-Scaling (HPA)

The chart supports optional Horizontal Pod Autoscalers for the API and Controller. Disabled by default.

```yaml
api:
  autoscaling:
    enabled: true
    minReplicas: 1
    maxReplicas: 4
    targetCPUUtilizationPercentage: 70
    targetMemoryUtilizationPercentage: 80

controller:
  autoscaling:
    enabled: true
    minReplicas: 1
    maxReplicas: 3
    targetCPUUtilizationPercentage: 70
    targetMemoryUtilizationPercentage: 80
```

When `autoscaling.enabled: true`, the chart creates a `HorizontalPodAutoscaler` (v2) that scales the Deployment based on CPU and/or memory utilization. The `replicas` field in the Deployment is still respected as the initial count, but the HPA takes over after that.

**What auto-scales:**

- **API** — handles credential requests, token exchange, session management. Scales with concurrent user traffic.
- **Controller** — handles session reconciliation. With SKIP LOCKED support, multiple controller replicas process different sessions in parallel without conflicts.

**What does NOT auto-scale via HPA:**

- **Worker pods** — managed by the controller based on `desired_session_count` per application. The number of workers equals the number of active sessions, not a function of CPU/memory utilization.
- **Infrastructure** (PostgreSQL, Redis, NATS, MinIO) — single-instance by default. Scale manually or use managed external services.

> **Cluster requirement:** HPA requires the [Metrics Server](https://github.com/kubernetes-sigs/metrics-server) installed in the cluster. Most managed Kubernetes services (EKS, GKE, AKS) include it by default. Verify with: `kubectl top pods -n <namespace>`.

### Production Resource Recommendations

Resource values are configured through the Helm values file under each component's `resources` block. Below are recommended production values with reasoning. Defaults in the chart are safe starting points — adjust based on observed usage.

#### API — NestJS REST server

Handles token exchange, credential resolution, session management, and VNC/CDP WebSocket proxying.


| Setting        | Value | Why                                                                                      |
| -------------- | ----- | ---------------------------------------------------------------------------------------- |
| Replicas       | 2     | Redundancy. HPA can scale further under load.                                            |
| CPU request    | 500m  | NestJS idles at ~10% of a core. 500m covers burst during concurrent credential requests. |
| CPU limit      | 2000m | Allows spikes during heavy token exchange or multiple concurrent WebSocket proxies.      |
| Memory request | 512Mi | NestJS + TypeORM idle at ~150 MB. 512Mi covers connection pools and V8 heap.             |
| Memory limit   | 2Gi   | Headroom for GC pressure under sustained load. Heap is capped at 700 MB via Dockerfile.  |


```yaml
api:
  replicas: 2
  resources:
    requests:
      cpu: "500m"
      memory: "512Mi"
    limits:
      cpu: "2000m"
      memory: "2Gi"
```

#### Controller — Session reconciliation engine

Watches the database, creates/destroys worker pods, manages NATS events and circuit breakers. Supports multi-replica with SKIP LOCKED.


| Setting        | Value | Why                                                                                   |
| -------------- | ----- | ------------------------------------------------------------------------------------- |
| Replicas       | 2     | Parallel reconciliation via row-level locking. Each replica processes different apps. |
| CPU request    | 500m  | Mostly DB queries + K8s API calls. Lightweight but periodic spikes during reconcile.  |
| CPU limit      | 1000m | Reconciliation is I/O-bound, not CPU-bound. 1 core is sufficient.                     |
| Memory request | 512Mi | Similar to API. DB pool + NATS connection + K8s client.                               |
| Memory limit   | 1Gi   | Heap capped at 700 MB. 1Gi gives breathing room.                                      |


```yaml
controller:
  replicas: 2
  resources:
    requests:
      cpu: "500m"
      memory: "512Mi"
    limits:
      cpu: "1000m"
      memory: "1Gi"
```

#### Worker — Chromium browser session (per user)

Each worker pod runs a full Playwright/Chromium instance for one session. Resource usage depends on the target website complexity.


| Setting        | Value | Why                                                                                               |
| -------------- | ----- | ------------------------------------------------------------------------------------------------- |
| CPU request    | 1000m | Chromium uses ~1 core during page navigation. Idle during HITL wait.                              |
| CPU limit      | 2000m | Allows burst during heavy JS execution (SPAs like Salesforce Lightning).                          |
| Memory request | 2Gi   | Single Chromium tab: 400-600 MB idle, 800 MB-1.2 GB active. Playwright Node process adds ~100 MB. |
| Memory limit   | 3Gi   | 1.5x headroom above peak RSS. Prevents OOMKill during V8 GC spikes.                               |


```yaml
worker:
  resources:
    requests:
      cpu: "1000m"
      memory: "2Gi"
    limits:
      cpu: "2000m"
      memory: "3Gi"
```

> **Note:** Each concurrent Tabby session creates one worker pod. 50 concurrent users = 50 pods = ~50 CPU + ~100 Gi memory requested. Plan cluster capacity accordingly.

#### PostgreSQL

Stores sessions, applications, profiles, users, audit log, and circuit breaker state.


| Setting        | Value | Why                                                                      |
| -------------- | ----- | ------------------------------------------------------------------------ |
| CPU request    | 500m  | Tabby's query pattern is simple (CRUD + SKIP LOCKED). Not CPU-intensive. |
| CPU limit      | 2000m | Allows burst during migration runs or heavy concurrent queries.          |
| Memory request | 1Gi   | Connection pool of 20 × ~30-50 MB per connection = 600 MB-1 GB.          |
| Memory limit   | 2Gi   | Headroom for shared_buffers and work_mem.                                |


```yaml
postgresql:
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2000m"
      memory: "2Gi"
```

#### Redis

Caches federated tokens, stream tokens, short-links, human input, circuit breaker markers.


| Setting        | Value | Why                                                                            |
| -------------- | ----- | ------------------------------------------------------------------------------ |
| CPU request    | 250m  | Redis is single-threaded and Tabby's workload is light (key-value lookups).    |
| Memory request | 256Mi | Tabby stores small values with short TTLs. Total dataset rarely exceeds 50 MB. |


```yaml
redis:
  resources:
    requests:
      cpu: "250m"
      memory: "256Mi"
    limits:
      cpu: "500m"
      memory: "512Mi"
```

#### NATS

Publishes HITL lifecycle events (`hitl.started`, `hitl.completed`, `session.state.changed`).


| Setting              | Value | Why                                                                             |
| -------------------- | ----- | ------------------------------------------------------------------------------- |
| CPU request          | 250m  | Event throughput is low (one event per session state change).                   |
| Memory request       | 256Mi | JetStream stores messages on disk. In-memory usage is minimal.                  |
| JetStream max memory | 256Mi | Caps JetStream's in-memory cache. 256Mi is safe for production message volumes. |


```yaml
nats:
  resources:
    requests:
      cpu: "250m"
      memory: "256Mi"
    limits:
      cpu: "500m"
      memory: "512Mi"
  jetstream:
    maxMemory: "256Mi"
```

#### MinIO

Stores encrypted credential artifacts (AES-256-GCM) and session screenshots.


| Setting        | Value | Why                                                                            |
| -------------- | ----- | ------------------------------------------------------------------------------ |
| CPU request    | 250m  | Artifact upload/download is infrequent (once per credential extraction cycle). |
| Memory request | 512Mi | MinIO baseline is ~256 MB. Can spike during concurrent uploads. 512Mi is safe. |


```yaml
minio:
  resources:
    requests:
      cpu: "250m"
      memory: "512Mi"
    limits:
      cpu: "500m"
      memory: "1Gi"
```

---

## Environment Variables Reference

### Critical Secrets

These must be provided explicitly. The Helm chart does **not** auto-generate any secrets — every value must be supplied by the operator.

All variables marked `Customer generates` in the **Provided By** column can be generated using the commands below and passed directly to the Helm chart.


| Variable                     | Helm Value                        | Provided By        | Description                                                                                            | How to Generate           |
| ---------------------------- | --------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------- |
| `TENANT_ENCRYPTION_KEY`      | `secrets.tenantEncryptionKey`     | Customer generates | AES-256-GCM key for artifact encryption. 64 hex characters. Must be identical on API and Worker pods.  | `openssl rand -hex 32`    |
| `JWT_SIGNING_KEY`            | `secrets.jwtSigningKey`           | Customer generates | HS256 key for all Tabby-issued JWTs. Minimum 32 characters.                                            | `openssl rand -base64 48` |
| `ADMIN_BOOTSTRAP_PASSWORD`   | `secrets.adminBootstrapPassword`  | Customer chooses   | Password for the initial admin user. Uppercase, lowercase, digit, special char, min 12 chars.          | Choose a strong password  |
| `POSTGRES_PASSWORD`          | `secrets.postgresPassword`        | Customer generates | PostgreSQL password. Required when using the bundled PostgreSQL.                                       | `openssl rand -base64 24` |
| `MINIO_ACCESS_KEY`           | `secrets.minioAccessKey`          | Customer generates | MinIO root access key. Required when using the bundled MinIO.                                          | `openssl rand -base64 16` |
| `MINIO_SECRET_KEY`           | `secrets.minioSecretKey`          | Customer generates | MinIO root secret key. Required when using the bundled MinIO.                                          | `openssl rand -base64 32` |
| `EGRESS_PROXY_SESSION_KEY`   | `secrets.egressProxySessionKey`   | Customer generates | Session signing key for the egress proxy.                                                              | `openssl rand -hex 32`    |
| `EGRESS_PROXY_ADMIN_TOKEN`   | `secrets.egressProxyAdminToken`   | Customer generates | Admin token for egress proxy allowlist management.                                                     | `openssl rand -base64 32` |
| `AGENT_SECRET_HMAC_KEY`      | `secrets.agentHmacKey`            | Customer generates | HMAC key for agent client_secret generation. Changing this invalidates all existing agent credentials. | `openssl rand -base64 32` |
| `SERVICE_AUTH_CLIENT_SECRET` | `secrets.serviceAuthClientSecret` | Customer generates | Secret for service-to-service authentication (platform → Tabby).                                       | `openssl rand -base64 32` |


### IDP Client Credentials (Browser OAuth)

These are required for the VNC OAuth authentication gate. They are provided by the **Adopt team** as part of the IDP registration.


| Variable            | Helm Value                | Provided By    | Description                                                           |
| ------------------- | ------------------------- | -------------- | --------------------------------------------------------------------- |
| `IDP_CLIENT_ID`     | `secrets.idpClientId`     | Adopt provides | OAuth client ID registered in the IDP for Tabby's browser OAuth flow. |
| `IDP_CLIENT_SECRET` | `secrets.idpClientSecret` | Adopt provides | OAuth client secret (stored encrypted).                               |


These are **environment variables**, not fields in the IDP registration payload. The Adopt team registers a redirect URI (`https://TABBY_API_URL/auth/oauth/callback`) in the IDP and provides these values.

### Configuration (Non-Secret)


| Variable                     | Helm Value                        | Default                                  | Description                                                                                                                            |
| ---------------------------- | --------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`            | `config.publicBaseUrl`            | —                                        | **Required.** External URL of the Tabby API (e.g., `https://tabby-api.customer.com`). Used for OAuth callbacks, VNC stream URLs, CORS. |
| `STREAM_HOST`                | `config.streamHost`               | Falls back to `PUBLIC_BASE_URL` hostname | Hostname for WebSocket stream URLs.                                                                                                    |
| `STREAM_PROTOCOL`            | `config.streamProtocol`           | `wss` in production                      | WebSocket protocol (`wss` for HTTPS, `ws` for HTTP).                                                                                   |
| `ADMIN_BOOTSTRAP_EMAIL`      | `config.adminBootstrapEmail`      | `admin@browser-hitl.local`               | Email for the bootstrap admin user.                                                                                                    |
| `BOOTSTRAP_TENANT_NAME`      | —                                 | `default`                                | Name of the auto-created bootstrap tenant.                                                                                             |
| `WORKER_NAMESPACE`           | —                                 | Release namespace                        | K8s namespace where worker pods are created.                                                                                           |
| `MAX_SESSION_AGE_HOURS`      | `config.maxSessionAgeHours`       | `24`                                     | Maximum lifetime of a worker session (hours). Workers self-terminate after this.                                                       |
| `IDLE_SHUTDOWN_SECONDS`      | `config.idleShutdownSeconds`      | `0` (disabled)                           | Seconds without a credential request before a session is terminated. Set to `3600` (1 hour) for production to reclaim idle workers.    |
| `RECONCILE_INTERVAL_SECONDS` | `config.reconcileIntervalSeconds` | `15`                                     | Controller reconcile loop frequency (seconds).                                                                                         |
| `RECONCILE_BATCH_SIZE`       | `config.reconcileBatchSize`       | `50`                                     | Maximum sessions processed per reconcile pass.                                                                                         |
| `CORS_ORIGIN`                | `config.corsOrigin`               | `*`                                      | CORS allowed origins. Restrict in production.                                                                                          |
| `API_DOCS_ENABLED`           | —                                 | `true`                                   | Set to `false` to disable Swagger UI in production.                                                                                    |
| `NODE_ENV`                   | —                                 | —                                        | Set to `production` for production deployments.                                                                                        |


### Monitoring (Optional)


| Variable                    | Helm Value                      | Default | Description                                               |
| --------------------------- | ------------------------------- | ------- | --------------------------------------------------------- |
| `SENTRY_ENABLED`            | `config.sentryEnabled`          | `false` | Enable Sentry error reporting.                            |
| `SENTRY_DSN`                | `secrets.sentryDsn`             | —       | Sentry DSN endpoint. Required when `SENTRY_ENABLED=true`. |
| `SENTRY_TRACES_SAMPLE_RATE` | `config.sentryTracesSampleRate` | `0.1`   | Percentage of requests traced (0.0–1.0).                  |


### Data Retention

Configurable via environment variables. Cleanup runs as daily cron jobs.


| Variable                                | Default   | Description                                                  | Cleanup Schedule |
| --------------------------------------- | --------- | ------------------------------------------------------------ | ---------------- |
| `LIFECYCLE_ARTIFACT_RETENTION_DAYS`     | `7`       | Days to retain credential artifacts                          | Daily 3:15 AM    |
| `LIFECYCLE_SESSION_RETENTION_DAYS`      | `14`      | Days to retain terminated sessions                           | Daily 3:15 AM    |
| `LIFECYCLE_INTERVENTION_RETENTION_DAYS` | `30`      | Days to retain HITL intervention records                     | Daily 3:15 AM    |
| `LIFECYCLE_APP_RETENTION_DAYS`          | `30`      | Days to retain apps with zero desired sessions               | Daily 3:15 AM    |
| Audit events                            | `90 days` | Audit log retention (hardcoded, per-tenant override planned) | Daily 2:00 AM    |


### Circuit Breaker

The controller has a circuit breaker that pauses reconciliation when repeated failures occur, preventing resource waste from pods that keep crashing.


| Variable                                   | Default | Description                                                           |
| ------------------------------------------ | ------- | --------------------------------------------------------------------- |
| `CIRCUIT_BREAKER_APP_FAILURE_THRESHOLD`    | `5`     | Consecutive failures before pausing a specific app's reconciliation   |
| `CIRCUIT_BREAKER_TENANT_FAILURE_THRESHOLD` | `50`    | Cumulative failures across all apps before pausing the entire tenant  |
| `CIRCUIT_BREAKER_WINDOW_SECONDS`           | `300`   | Rolling window (5 min) for counting failures                          |
| `CIRCUIT_BREAKER_COOLDOWN_SECONDS`         | `600`   | How long reconciliation stays paused after the circuit opens (10 min) |


> **Note on tenant threshold:** Set high enough to avoid false pauses when many users run concurrent sessions. With 200+ simultaneous users, transient K8s scheduling failures can accumulate quickly. The default of 50 is designed for high-concurrency deployments. For smaller setups (<20 users), 10-20 is sufficient.

### Auto-Constructed (Helm generates from chart values)

These are built automatically by the Helm ConfigMap. You do **not** need to set them manually, but they exist for reference:


| Variable           | Constructed From                               | Example                                                             |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------- |
| `DATABASE_URL`     | `postgres.auth.`* + `secrets.postgresPassword` | `postgresql://browser_hitl:PASS@release-postgres:5432/browser_hitl` |
| `REDIS_URL`        | Release name                                   | `redis://release-redis:6379`                                        |
| `NATS_URL`         | Release name                                   | `nats://release-nats:4222`                                          |
| `MINIO_ENDPOINT`   | Release name                                   | `release-minio`                                                     |
| `EGRESS_PROXY_URL` | Release name                                   | `http://release-egress-proxy:3128`                                  |


---

## Step 1: Bootstrap Admin Login

On first startup, Tabby automatically creates a bootstrap admin user and tenant if no tenants exist. This is idempotent — it only runs once.

**Admin credentials are defined in:**

- Email: `config.adminBootstrapEmail` in Helm values (default: `admin@browser-hitl.local`)
- Password: `secrets.adminBootstrapPassword` in Helm values

**To retrieve the admin password from a running deployment:**

```bash
kubectl get secret <RELEASE_NAME>-browser-hitl -n <NAMESPACE> \
  -o jsonpath='{.data.adminPassword}' | base64 -d
```

**To log in:**

```bash
TOKEN=$(curl -s https://TABBY_API_URL/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@browser-hitl.local","password":"YOUR_ADMIN_PASSWORD"}' \
  | jq -r '.token')
```

This can also be done via Swagger UI at `https://TABBY_API_URL/api/docs`.

---

## Step 2: Register Identity Provider

Tabby is a **Resource Server** — it validates JWTs issued by an external IDP using public JWKS keys. One IDP registration serves all tenants and users.

### 2.1 Verify JWKS Reachability

Before registering, confirm Tabby can reach the IDP's JWKS endpoint:

```bash
curl -s "https://auth.adopt.ai/.well-known/openid-configuration" | jq .jwks_uri
# Must return a valid https:// URL
```

### 2.2 Register the IDP

**Endpoint:** `POST /admin/identity-providers` (Admin JWT required)

```json
{
      "name": "Frontegg (auth.adopt.ai)",
      "provider_type": "oidc",
      "issuer_url": "https://auth.adopt.ai",
      "jwks_uri": "https://auth.adopt.ai/.well-known/jwks.json",
      "audience": "ae925ccb-94e9-4967-8438-914e89651c32",
      "auth_url": "https://auth.adopt.ai/oauth/authorize",
      "token_url": "https://auth.adopt.ai/oauth/token",
      "userinfo_url": "https://auth.adopt.ai/identity/resources/users/v2/me",
      "scopes": "openid email profile",
      "admin_domains": ["EMAIL.DOMAIN", "CHOOSE-WHICH-DOMAIN-WILL-BE-THE-ADMIN.COM"], // adopt.ai or automationanywhere.com
      "tenant_id_claim": "tenantId",
      "user_id_claim": "sub",
      "email_claim": "email",
      "name_claim": "name",
      "enabled": true,
      "allow_auto_provision": false,
      "default_role": "Operator"
  }
```

Save the returned `id` — it is needed for the platform's Playground Profile configuration.

### IDP Field Reference


| Field                  | Required            | Description                                                                                                                                                               |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | Yes                 | Display name for this IDP                                                                                                                                                 |
| `provider_type`        | Yes                 | `oidc` (SAML support planned)                                                                                                                                             |
| `issuer_url`           | Yes                 | OIDC issuer base URL. Tabby discovers JWKS via `/.well-known/openid-configuration`.                                                                                       |
| `audience`             | No                  | Expected `aud` claim value (the platform's OAuth client_id). When omitted, Tabby only validates signature + issuer + expiry. Recommended for cloud; optional for on-prem. |
| `tenant_id_claim`      | For multi-tenant    | JWT claim holding the tenant/org identifier (e.g., `tenantId` for Frontegg, `tid` for Azure AD, `org_id` for Okta)                                                        |
| `user_id_claim`        | Default: `sub`      | JWT claim for user identity                                                                                                                                               |
| `email_claim`          | Default: `email`    | JWT claim for user email                                                                                                                                                  |
| `name_claim`           | Default: `name`     | JWT claim for display name                                                                                                                                                |
| `admin_domains`        | No                  | Email domains granted Admin role on auto-provision (e.g., `["adopt.ai"]`)                                                                                                 |
| `default_role`         | Default: `Operator` | Role for users not matching `admin_domains`                                                                                                                               |
| `allow_auto_provision` | Default: `false`    | Auto-create tenants and users on first JWT. **Recommended: `true`.**                                                                                                      |


> `**client_id` and `client_secret` are NOT part of this payload.** They are environment variables (`IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`) used only for browser OAuth login. The IDP registration is for JWT validation only.

---

## Step 3: Create Tenant

With `allow_auto_provision: true`, tenants are created automatically on first JWT. Manual creation is only needed to set a specific name or control `max_sessions`.

**Endpoint:** `POST /tenants` (Admin JWT required)

```json
{
  "name": "Customer Name",
  "id": "TENANT_ID_FROM_JWT_CLAIM", // platform org id
  "max_sessions": 1000
}
```


| Field          | Description                                                           |
| -------------- | --------------------------------------------------------------------- |
| `id`           | **Must match** the `tenant_id_claim` value from the users' JWTs.      |
| `name`         | Display name (must be unique).                                        |
| `max_sessions` | Maximum concurrent sessions/worker pods for this tenant. Default: 10. |


**About `max_sessions`:**

- Limits the maximum number of concurrent Tabby sessions (worker pods) that Tabby will allow for the tenant.
- If set to 10, Tabby will create at most 10 simultaneous browser session pods.
- **Important:** setting `max_sessions` to a high number (e.g., 1000) **does NOT mean the Kubernetes cluster can actually run 1000 Chromium pods**. Each session pod requires ~1 CPU and ~2 Gi memory. The actual usable concurrency depends on available cluster resources.
- **If the cluster cannot schedule pods because of insufficient resources, users will see session startup delays or failures.**
- For testing, start with 3–5. For production, set higher (e.g., 50–500) **but ensure the cluster has enough capacity. Monitor pod scheduling and adjust.**
- Resource requests/limits per worker pod are configured in the Helm values (`worker.resources`). Default: 1 CPU / 2 Gi request, 2 CPU / 3 Gi limit.
- Can be updated later via `PATCH /tenants/:id`.

---

## Step 4: Create App Templates

App templates define how Tabby launches and manages browser sessions for a specific application (e.g., Salesforce, Workday).

**Endpoint:** `POST /admin/app-templates` (Admin JWT required)

### Salesforce Template

Replace `YOUR_TENANT_ID` and `YOUR_INSTANCE` (e.g., `aainc--qas` for sandbox).

```json
  "profile_name_pattern": // THIS FIELD NEED TO MATCH WITH THE PROFILE-ID CONFIGURED IN THE TOKEN MANAGER
```

```json
{
  "tenant_id": "YOUR_TENANT_ID",
  "name": "Salesforce Sandbox",
  "profile_name_pattern": "salesforce-aa-adopt", // THIS FIELD NEED TO MATCH WITH THE PROFILE-ID CONFIGURED IN THE TOKEN MANAGER
  "login_config": {
    "login_url": "https://test.salesforce.com/", // this one
    "credential_ref": "manual:",
    "steps": [
      {"action": "goto", "url": "https://test.salesforce.com/"},
      {"action": "fill", "selector": "input#username", "value": ""},
      {"action": "fill", "selector": "input#password", "value": "", "sensitive": true},
      {"label": "Log into Salesforce via VNC stream, then click Mark as Resolved", "action": "request_human_input", "input_type": "confirm", "timeout_ms": 1200000},
      {"label": "Navigate to any quote page in VNC. The quote must have products configured, then click Mark as Resolved", "action": "request_human_input", "input_type": "confirm", "timeout_ms": 1200000},
      {"action": "evaluate", "expression": "(function(){ var m = window.location.href.match(/SBQQ__Quote__c\\/([a-zA-Z0-9]{15,18})/); return m ? m[1] : ''; })()", "store_as": "quote_id"}
    ]
  },
  "keepalive_config": {
    "interval_seconds": 120,
    "actions": [
      {"action": "evaluate", "expression": "fetch('/lightning/page/home', {credentials: 'include'}).then(r => r.status)"}
    ],
    "health_checks": [
      {"type": "url_check", "url": "https://YOUR_INSTANCE.sandbox.lightning.force.com/lightning/page/home", "expect_status": 200, "timeout_ms": 20000}
    ]
  },
  "export_policy": {
    "artifact_types": ["cookies", "headers", "local_storage", "session_storage"],
    "encryption": {"algo": "AES-256-GCM"},
    "ttl_seconds": 3600,
    "refresh_interval_seconds": 120,
    "target_domains": [
      "YOUR_INSTANCE.sandbox.my.salesforce.com",
      "YOUR_INSTANCE.sandbox.lightning.force.com",
      "YOUR_INSTANCE--sbqq.sandbox.vf.force.com"
    ],
    "extract_urls": {"*/apex/sb*": "https://YOUR_INSTANCE--sbqq.sandbox.vf.force.com/apex/sb?id={{quote_id}}"},
    "credential_types": {
      "cookies": [
        {"name": "sid", "domain": ".salesforce.com", "path": "/", "secure": true, "httpOnly": true, "volatility": "SEMI_STABLE"},
        {"name": "oid", "domain": ".salesforce.com", "path": "/", "secure": true, "httpOnly": false, "volatility": "STABLE"}
      ],
      "headers": [
        {"name": "authorization", "volatility": "VOLATILE"},
        {"name": "x-csrf-token", "volatility": "VOLATILE"},
        {"name": "x-sfdc-request-id", "volatility": "VOLATILE"}
      ],
      "custom": [
        {"key": "access_token", "volatility": "SEMI_STABLE"},
        {"key": "aura_token", "volatility": "VOLATILE"},
        {"key": "aura_context", "volatility": "SEMI_STABLE"},
        {"key": "vf_vid", "volatility": "SEMI_STABLE"},
        {"key": "vf_csrf_load", "volatility": "VOLATILE"},
        {"key": "vf_auth_load", "volatility": "VOLATILE"},
        {"key": "vf_csrf_save", "volatility": "VOLATILE"},
        {"key": "vf_auth_save", "volatility": "VOLATILE"},
        {"key": "vf_csrf_read", "volatility": "VOLATILE"},
        {"key": "vf_auth_read", "volatility": "VOLATILE"},
        {"key": "vf_csrf_search", "volatility": "VOLATILE"},
        {"key": "vf_auth_search", "volatility": "VOLATILE"},
        {"key": "vf_cookie", "volatility": "VOLATILE"},
        {"key": "Cookie", "volatility": "VOLATILE"}
      ]
    },
    "header_allowlist": ["authorization", "x-csrf-token", "x-sfdc-request-id"],
    "custom_extractions": [
      {"key": "access_token", "type": "cookie", "cookie_name": "sid", "description": "Salesforce session ID"},
      {"key": "aura_token", "type": "js_eval", "expression": "localStorage.getItem('$AuraClientService.token$one:one') || ''", "description": "Lightning Aura JWT"},
      {"key": "aura_context", "type": "js_eval", "expression": "(function(){ var html = document.documentElement.outerHTML; var fwuid = (html.match(/[\"']fwuid[\"']\\s*:\\s*[\"']([A-Za-z0-9_\\-+=/]+)[\"']/) || [])[1] || ''; var appM = (html.match(/[\"']app[\"']\\s*:\\s*[\"']([^\"']+)[\"']/) || [])[1] || 'one:one'; try { return JSON.stringify({mode:'PROD',fwuid:fwuid,app:appM}); } catch(e) { return ''; } })()"},
      {"key": "vf_vid", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { return JSON.parse(m[1]).vf.vid; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_csrf_load", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='load'}).csrf; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_auth_load", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='load'}).authorization; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_csrf_save", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='save'}).csrf; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_auth_save", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='save'}).authorization; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_csrf_read", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='read'}).csrf; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_auth_read", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; return ms.find(function(x){return x.name==='read'}).authorization; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_csrf_search", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; var s = ms.find(function(x){return x.name==='search'}); return s ? s.csrf : ''; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_auth_search", "type": "js_eval", "expression": "(function(){ var m = document.documentElement.innerHTML.match(/RemotingProviderImpl\\(({.*?})\\s*\\)/s); if (!m) return ''; try { var ms = JSON.parse(m[1]).actions['SBQQ.ServiceRouter'].ms; var s = ms.find(function(x){return x.name==='search'}); return s ? s.authorization : ''; } catch(e) { return ''; } })()", "extract_on_url": "*/apex/sb*"},
      {"key": "vf_cookie", "type": "js_eval", "expression": "document.cookie", "extract_on_url": "*/apex/sb*"},
      {"key": "Cookie", "type": "js_eval", "expression": "document.cookie"}
    ]
  },
  "browser_policy": {"downloads": false, "clipboard": false, "file_chooser": false, "allow_evaluate": true},
  "notification_config": {},
  "credential_ref_default": "manual:",
  "idle_shutdown_seconds": 3600
}
```

> **Note on `credential_ref`:** Using `manual:` means the user logs in manually via VNC. No Kubernetes Secrets are needed for credentials. The `fill` steps for username/password have empty values — the user fills them on screen.

### Workday Template

Replace `YOUR_TENANT_ID`. Replace `wd5-impl` URLs with your Workday instance domains.

```json
{
  "tenant_id": "YOUR_TENANT_ID",
  "name": "Workday",
  "profile_name_pattern": "workday-aa-adopt",
  "login_config": {
    //https://wd5-impl-identity.workday.com/wday/authgwy/automationanywhere3/upc/login
    "login_url": "https://WORKDAY_IDENTITY_DOMAIN/wday/authgwy/TENANT/upc/login",
    "credential_ref": "manual:",
    "steps": [
      //https://wd5-impl-identity.workday.com/wday/authgwy/automationanywhere3/upc/login
      {"action": "goto", "url": "https://WORKDAY_IDENTITY_DOMAIN/wday/authgwy/TENANT/upc/login"},
      {"action": "click", "selector": "[data-testid=\"username\"]", "timeout_ms": 30000},
      {"label": "Log into Workday via VNC stream, then click Mark as Resolved", "action": "request_human_input", "input_type": "confirm", "timeout_ms": 1200000}
    ]
  },
  "keepalive_config": {
    "interval_seconds": 120,
    "actions": [
      //https://wd5-impl.workday.com/automationanywhere3/d/home.htmld
      {"action": "goto", "url": "https://WORKDAY_MAIN_DOMAIN/TENANT/d/home.htmld"}
    ],
    "health_checks": [
      {"type": "url_check", "url": "https://WORKDAY_MAIN_DOMAIN/TENANT/d/home.htmld", "expect_status": 200, "timeout_ms": 20000}
    ]
  },
  "export_policy": {
    "artifact_types": ["cookies", "headers", "local_storage", "session_storage"],
    "encryption": {"algo": "AES-256-GCM"},
    "ttl_seconds": 3600,
    "refresh_interval_seconds": 120,
    "target_domains": ["WORKDAY_MAIN_DOMAIN", "WORKDAY_IDENTITY_DOMAIN"],
    "extract_urls": {"*/TENANT/*": "https://WORKDAY_MAIN_DOMAIN/TENANT/d/home.htmld"},
    "credential_types": {
      "cookies": "ALL",
      "headers": ["authorization", "x-csrf-token"],
      "local_storage": "ALL",
      "session_storage": "ALL"
    },
    "header_allowlist": ["authorization", "x-csrf-token"],
    "custom_extractions": [
      {"key": "wd_all_cookies", "type": "js_eval", "expression": "document.cookie", "extract_on_url": "*/TENANT/*"}
    ]
  },
  "browser_policy": {"downloads": false, "clipboard": false, "file_chooser": false},
  "notification_config": {},
  "credential_ref_default": "manual:",
  "idle_shutdown_seconds": 3600
}
```

---

## Step 5: Platform Configuration

### Token Manager

Token Manager entries map Tabby-extracted credentials to token names the platform uses in actions.

**Salesforce Token Manager:**


| Name             | Storage Type | Tabby Profile ID      | Credential Path         | Domain Suffix |
| ---------------- | ------------ | --------------------- | ----------------------- | ------------- |
| `sfdc_cookie`    | TABBY        | `salesforce-aa-adopt` | `custom.Cookie`         | `force.com`   |
| `aura_token`     | TABBY        | `salesforce-aa-adopt` | `custom.aura_token`     | `force.com`   |
| `aura_context`   | TABBY        | `salesforce-aa-adopt` | `custom.aura_context`   | `force.com`   |
| `access_token`   | TABBY        | `salesforce-aa-adopt` | `custom.access_token`   | `force.com`   |
| `vf_cookie`      | TABBY        | `salesforce-aa-adopt` | `custom.vf_cookie`      | `force.com`   |
| `vf_vid`         | TABBY        | `salesforce-aa-adopt` | `custom.vf_vid`         | `force.com`   |
| `vf_csrf_load`   | TABBY        | `salesforce-aa-adopt` | `custom.vf_csrf_load`   | `force.com`   |
| `vf_auth_load`   | TABBY        | `salesforce-aa-adopt` | `custom.vf_auth_load`   | `force.com`   |
| `vf_csrf_save`   | TABBY        | `salesforce-aa-adopt` | `custom.vf_csrf_save`   | `force.com`   |
| `vf_auth_save`   | TABBY        | `salesforce-aa-adopt` | `custom.vf_auth_save`   | `force.com`   |
| `vf_csrf_read`   | TABBY        | `salesforce-aa-adopt` | `custom.vf_csrf_read`   | `force.com`   |
| `vf_auth_read`   | TABBY        | `salesforce-aa-adopt` | `custom.vf_auth_read`   | `force.com`   |
| `vf_csrf_search` | TABBY        | `salesforce-aa-adopt` | `custom.vf_csrf_search` | `force.com`   |
| `vf_auth_search` | TABBY        | `salesforce-aa-adopt` | `custom.vf_auth_search` | `force.com`   |


> **Important:** `sfdc_cookie` uses `custom.Cookie` (not `cookies.ALL`). Salesforce Aura session cookies are JS-visible, not HttpOnly.

**Workday Token Manager:**


| Name               | Storage Type | Tabby Profile ID   | Credential Path | Domain Suffix |
| ------------------ | ------------ | ------------------ | --------------- | ------------- |
| `wd_cookies_tabby` | TABBY        | `workday-aa-adopt` | `cookies.ALL`   | `workday.com` |


> **Important:** Workday uses `cookies.ALL` (Playwright-extracted HttpOnly cookies), not `custom.Cookie`.

### Playground Profile

Currently, the Playground Profile requires:


| Field                    | Value                                                      |
| ------------------------ | ---------------------------------------------------------- |
| **Tabby URL**            | `https://TABBY_API_URL`                                    |
| **Identity Provider ID** | The UUID returned from Step 2.2                            |
| **Security Headers**     | mapping of header names to token manager names (see below) |


**Salesforce Security Headers:**

```json
{"Cookie": "sfdc_cookie", "aura_token": "aura_token", "aura_context": "aura_context", "access_token": "access_token", "vf_cookie": "vf_cookie", "vf_vid": "vf_vid", "vf_csrf_load": "vf_csrf_load", "vf_auth_load": "vf_auth_load", "vf_csrf_save": "vf_csrf_save", "vf_auth_save": "vf_auth_save", "vf_csrf_read": "vf_csrf_read", "vf_auth_read": "vf_auth_read", "vf_csrf_search": "vf_csrf_search", "vf_auth_search": "vf_auth_search"}
```

**Workday Security Headers:**

```json
{"cookie": "wd_cookies_tabby"}
```

> **Future simplification:** The Playground Profile is being migrated to a simpler model. The platform will only need `TABBY_URL` as an environment variable and a `use_tabby` boolean toggle on the profile. The IDP ID and Tabby URL fields on the profile will be replaced. This change is in progress and does not affect the current setup.

---

## Runtime Flow

### First request from a new user

1. Platform sends user's JWT to Tabby via `POST /auth/token-exchange`
2. Tabby validates JWT signature via JWKS, reads `tenant_id_claim` and `sub`
3. Credential request (`POST /credentials/request`) — no session exists yet
4. Tabby auto-provisions from template: App → Profile → Session → Worker pod starts
5. Platform polls session status (up to 150s) waiting for VNC + HITL
6. HITL notification sent (Slack/Teams/MCP) — user logs in via VNC
7. Session becomes HEALTHY → credentials extracted → action executes

### Subsequent requests (session alive)

1. Token exchange (cached in platform Redis for ~59 min)
2. Credential request → session HEALTHY → credentials returned instantly

### After idle shutdown

1. Controller detects no credential requests for `IDLE_SHUTDOWN_SECONDS` → terminates pod
2. Next credential request → 404 → platform detects idle shutdown → re-scales app to 1
3. New pod starts → HITL notification → user re-logs in → HEALTHY
4. Same app/profile reused — only the session restarts

---

## Troubleshooting


| Symptom                            | Likely Cause                                                          | Fix                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `401 No registered IdP for issuer` | JWT `iss` doesn't match `issuer_url` in IDP registration              | Verify `issuer_url` matches the discovery endpoint's `iss` value exactly                                    |
| `401 JWT audience mismatch`        | JWT `aud` doesn't match `audience` in IDP registration                | Use the platform's OAuth `client_id` from the IDP admin console, or omit `audience`                         |
| `401 Tenant not found`             | `tenant_id_claim` value has no matching Tabby tenant                  | Enable `allow_auto_provision: true` or manually create the tenant with matching ID                          |
| `warming_up` HITL response         | Worker pod still scheduling                                           | Wait ~45s and retry. Cold starts take 30–120s depending on cluster autoscaler.                              |
| Empty credentials response         | `TENANT_ENCRYPTION_KEY` missing or mismatched                         | Must be set on both API and Worker pods with the same value                                                 |
| VNC doesn't load                   | Session not yet HEALTHY, or `PUBLIC_BASE_URL` incorrect               | Check `GET /sessions/:id` for state. Verify `PUBLIC_BASE_URL` is externally reachable.                      |
| `dom_check` returns false for SPAs | SPA renders `body` differently                                        | Use `url_check` with `expect_status: 200` instead of `dom_check` (applies to Salesforce Lightning, Workday) |
| Session terminates unexpectedly    | `MAX_SESSION_AGE_HOURS` exceeded or `IDLE_SHUTDOWN_SECONDS` triggered | Check controller logs. Increase values if needed.                                                           |
| Salesforce account lockout         | Too many failed OTP attempts                                          | Salesforce locks after ~5 failed attempts. No automated backoff — manual intervention needed.               |


---

## Testing the Setup

Before testing, verify all pieces are in place:

- `tabby` feature flag enabled for the organization on the platform
- Token Manager entries created with TABBY storage type (see Token Manager tables above — the `profile_id` must match the `profile_name_pattern` from the app template)
- Playground Profile configured with **Tabby URL** and **IDP ID** (from Step 2)
- App templates created (Salesforce, Workday, etc.) with correct `profile_name_pattern`
- Actions that should use Tabby have `use_tabby` enabled in deployment rules
- Data migration from production (if applicable) has the correct profile/token mappings

### Via Copilot

1. Log into the platform
2. Open the Copilot sidebar
3. Execute an action that uses Tabby (e.g., a Salesforce action with `use_tabby` deployment rule)
4. Expected: a HITL card appears with "Open Browser (VNC)" link
5. Click the link → VNC viewer opens → log into the target site → click "Mark as Resolved"
6. The action should complete with resolved credentials

### Via MCP

1. Connect to the MCP server
2. List available tools — actions configured with Tabby should show a label in their description: **"[Requires login — may return a VNC URL for human action.]"**
3. Execute one of those tools
4. Expected: the response includes a VNC link for human login, or the session resolves automatically if already warm

### Quick Validation: MCP Tool Labels

A good first check before running anything: list the MCP tools and verify the Tabby-enabled actions have the `[Requires login]` label in their description. If the label is missing:

- **Deployment rule not set** — check `use_tabby` is enabled for that action in `db_org_action_rules`
- **Feature flag not active** — verify the `tabby` feature flag is enabled for the organization
- **Playground Profile misconfigured** — verify Tabby URL and IDP ID are set correctly
- **Token Manager missing** — verify TABBY storage type entries exist with the correct `profile_id`

The MCP reads these settings from the platform's `action-integration-tools` endpoint and caches them for 10 minutes. After making changes, wait up to 10 minutes or restart the MCP server to pick up the new configuration.

---

## Security Notes

- All artifacts are encrypted with AES-256-GCM before storage in MinIO
- JWTs expire after 24h with immediate revocation via Redis-backed blacklist
- VNC access requires OAuth or email verification; session owner enforcement returns 403 on mismatch
- Stream tokens are 10 min TTL, single-use
- Append-only audit log with SHA-256 hash chains covers all security-relevant actions
- Data retention is configurable and runs as daily cleanup crons
- `TENANT_ENCRYPTION_KEY` is a deployment-wide key — protect it as you would a database master key

---

## Egress Proxy Allowlist

When the egress proxy is enabled (`egressProxy.enabled: true`), worker pods can only make outbound HTTP requests to domains in the allowlist. Add the domains your target applications use.

Below is the current production allowlist as a starting point. Add or remove domains based on your target SaaS applications.

```yaml
egressProxy:
  enabled: true
  defaultAllowlist:
    # --- Target SaaS applications ---
    - ".salesforce.com"
    - ".force.com"
    - ".workday.com"
    - ".workdaycdn.com"
    - ".automationanywhere.digital"
    - ".automationanywhere.com"
    - ".6sense.com"
    - ".6si.com"
    - ".6sc.co"
    - ".hubspot.com"
    - ".hubspot.net"
    - ".hsappstatic.net"
    - ".hs-scripts.com"
    - ".hs-analytics.net"
    - ".hs-banner.com"
    - ".hsforms.com"
    - ".hscollectedforms.net"
    - ".hsadspixel.net"
    - ".hsstatic.net"
    - ".apollo.io"
    # --- Auth providers ---
    - ".microsoftonline.com"
    - ".login.live.com"
    - ".windows.net"
    - ".microsoft.com"
    - ".msauth.net"
    - ".msftauth.net"
    - ".b2clogin.com"
    - ".auth0.com"
    - ".cdn.auth0.com"
    - ".recaptcha.net"
    - ".onmicrosoft.com"
    # --- CDNs and static assets ---
    - ".googleapis.com"
    - ".gstatic.com"
    - ".google.com"
    - ".google-analytics.com"
    - ".googletagmanager.com"
    - ".cloudflare.com"
    - ".challenges.cloudflare.com"
    - ".cloudflareinsights.com"
    - ".cloudfront.net"
    - ".jsdelivr.net"
    - ".unpkg.com"
    - ".amazonaws.com"
    - ".akamaihd.net"
    - ".akamaized.net"
    - ".bootstrapcdn.com"
    - ".fontawesome.com"
    - ".tailwindcss.com"
    - ".typekit.net"
    # --- Analytics / monitoring (commonly loaded by target sites) ---
    - ".sentry.io"
    - ".datadoghq.com"
    - ".pendo.io"
    - ".pendo-static-5698236162899968.storage.googleapis.com"
    - ".pendo-static-5673999629942784.storage.googleapis.com"
    - ".pendo-io-static.storage.googleapis.com"
    - ".rollbar.com"
    - ".mxpnl.com"
    - ".marketo.net"
    - ".heap-api.com"
    - ".dynatrace.com"
    - ".go-mpulse.net"
    - ".bat.bing.com"
    - ".googlesyndication.com"
    - ".ingest-lr.com"
    - ".logrocket.io"
    - ".lr-in-prod.com"
    - ".lr-ingest.com"
    - ".lr-in.com"
    - ".lr-ingest.io"
    # --- Third-party widgets / services ---
    - ".intercom.io"
    - ".customer.io"
    - ".commandbar.com"
    - ".wistia.com"
    - ".wistia.net"
    - ".ably.io"
    - ".ably-realtime.com"
    - ".transcend-cdn.com"
    - ".wowscale.com"
    - ".fullview.io"
    - ".descope.com"
    - ".descopecdn.com"
    - ".cookielaw.org"
    - ".onetrust.com"
    - ".cookiehub.eu"
    - ".zoominsoftware.io"
    - ".cdn.office.net"
    # --- Carrier/logistics platforms ---
    - ".hapag-lloyd.com"
    - ".hlag.cloud"
    - ".hlag.com"
    - ".hlagwebprod.onmicrosoft.com"
    - ".cma-cgm.com"
    - ".auth.cma-cgm.com"
    - ".captcha-delivery.com"
    - ".one-line.com"
    - ".aar.org"
    - ".msc.com"
    - ".mymsc.com"
    - ".mscciam.b2clogin.com"
    - ".identityserver.msc.com"
    - ".greenxtrade.com"
    - ".bluextrade.com"
    - ".carrierxtrade.com"
```

> **Note:** If a target SaaS site loads resources from a domain not in this list, the page may fail to render or function correctly. Check the worker browser's network tab (via VNC) for blocked requests and add the missing domains.

---

## WDL Compatibility Notes

When adapting existing Chrome Extension WDLs for server-side Tabby execution:

1. **Use absolute URLs** — relative paths (e.g., `url: "/aura"`) don't work server-side. Use full URLs.
2. **Use `{security_params.token_name}`** for tokens in POST payloads:
  ```json
   "payload": {
     "aura.token": "{security_params.aura_token}",
     "aura.context": "{security_params.aura_context}"
   }
  ```
3. **No newlines in JSON strings** — the `message` field in WDL payloads must be single-line JSON.
4. `**target_domains` is critical** — must include ALL domains the application uses. Missing domains = missing cookies/tokens.

