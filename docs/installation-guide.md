# Tabby (Browser HITL) — Installation Guide

**Chart:** `browser-hitl` v1.3.6  
**Registry:** `oci://ghcr.io/adoptai/charts/browser-hitl`  
**Audience:** Infrastructure teams performing a new deployment  
**Last updated:** 2026-05-05

---

## Prerequisites

### Cluster Requirements

| Requirement | Minimum | Recommended |
|---|---|---|
| Kubernetes version | 1.27 | 1.28–1.30 |
| Helm version | 3.14+ | Latest 3.x |
| CPU available | 8 vCPU | 16+ vCPU |
| RAM available | 32 GiB | 64+ GiB |
| Storage | Default StorageClass with ReadWriteOnce PVCs | `Retain` reclaim policy (see Step 2d) |
| Ingress | NGINX Ingress Controller or Istio + Gateway | NGINX preferred for simplicity |
| Outbound HTTPS | Required | To GHCR (image pulls), to your IdP (JWKS fetches) |
| Pod Security | Standard or restricted | Chart sets runAsNonRoot + drop ALL caps — compatible with `restricted` profile |

The permanent services (API, Controller, Admin UI, Egress Proxy, Postgres, Redis, NATS, MinIO) consume a baseline of cluster resources. Worker pods are created dynamically by the controller — one per active session — and are terminated when the session ends. Ensure the cluster has sufficient headroom to schedule worker pods on demand. Size the cluster for your expected peak concurrent session load: each worker requests 1 vCPU and 2 GiB RAM by default (tunable via `worker.resources`).

### Client Tools

```bash
# Verify required tools
kubectl version --client      # 1.27+
helm version                  # 3.14+
openssl version               # any recent version, for secret generation
```

### Cluster Admin Access

The installation creates a `Role` and `RoleBinding` in the `browser-hitl` namespace granting the controller service account:
- `create`, `delete`, `get`, `list`, `watch` on `pods`, `services`, `networkpolicies`

This is namespace-scoped. No cluster-admin is needed after initial namespace/RBAC creation.

---

## Step 1 — Create the Namespace

```bash
kubectl create namespace browser-hitl
```

If your cluster uses PodSecurityAdmission labels:

```bash
# For 'restricted' profile (recommended):
kubectl label namespace browser-hitl \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/warn=restricted
```

The chart is compatible with the `restricted` profile. All containers are non-root, drop all capabilities, and disallow privilege escalation.

---

## Step 2 — Decide on Infrastructure Configuration

Before writing your values file, make four decisions.

### 2a. In-cluster vs. external stateful services

**Option A — In-cluster (default, simplest)**

The chart deploys Postgres, Redis, NATS, and MinIO as StatefulSets with PVCs. Suitable for a self-contained on-prem deployment.

**Option B — External managed services (recommended for production)**

Disable in-cluster services and provide connection URLs:

```yaml
config:
  databaseUrl: "postgresql://user:pass@your-db-host:5432/browser_hitl"
  redisUrl: "redis://your-redis:6379"
  natsUrl: "nats://your-nats:4222"
  minioEndpoint: "s3.example.com"

postgres:
  enabled: false
redis:
  enabled: false
nats:
  enabled: false
minio:
  enabled: false
```

Hybrid is also valid (e.g., external Postgres + in-cluster Redis/NATS/MinIO).

**External Postgres requirements:** PostgreSQL 15+, a database named `browser_hitl`, and a user with full DDL privileges on that database (TypeORM runs migrations on startup).

### 2b. Ingress topology

**Critical — two hosts required.** The API and Admin UI must be on separate hostnames. A single shared hostname does not work because both services serve from `/` with different path structures.

| Host | Target Service | Example |
|---|---|---|
| `tabby-api.mycompany.local` | API (:8000) | `tabby-api.example.com` |
| `tabby-admin.mycompany.local` | Admin UI (:8000) | `tabby-admin.example.com` |

### 2c. TLS

Use `cert-manager` with a `ClusterIssuer` or provide pre-existing TLS secrets. TLS is disabled by default — enable in all non-development environments.

### 2d. Storage class

For production, create a StorageClass with `reclaimPolicy: Retain`:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: tabby-retained
provisioner: <your-csi-driver>    # disk.csi.azure.com, ebs.csi.aws.com, nfs.csi.k8s.io
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

Then set in values: `global.storageClass: tabby-retained`

Avoid `local-path` or `hostPath` in multi-node clusters — pod rescheduling to a different node loses data.

---

## Step 3 — Generate Secrets

**Generate all secrets before writing the values file. Store them in your secret manager.**

```bash
# AES-256-GCM key for credential encryption (exactly 64 hex chars = 32 bytes)
openssl rand -hex 32
# -> use as: secrets.tenantEncryptionKey

# JWT signing key (symmetric HS256, minimum 32 chars)
openssl rand -base64 48 | tr -d '\n'
# -> use as: secrets.jwtSigningKey

# Postgres password
openssl rand -base64 24
# -> use as: secrets.postgresPassword

# MinIO access key and secret
openssl rand -base64 16 | tr -d '=' | tr '+/' 'az'
openssl rand -base64 32
# -> use as: secrets.minioAccessKey, secrets.minioSecretKey

# Admin bootstrap password (first admin user)
openssl rand -base64 16
# -> use as: secrets.adminBootstrapPassword

# Egress proxy admin token and session HMAC key
openssl rand -hex 32
openssl rand -hex 32
# -> use as: secrets.egressProxyAdminToken, secrets.egressProxySessionKey

# Service auth secret (used by Slack/Teams bots to authenticate to API)
openssl rand -hex 32
# -> use as: secrets.serviceAuthClientSecret

# Agent HMAC key (for agent service accounts)
openssl rand -hex 32
# -> use as: secrets.agentSecretHmacKey  (passed via config or extra env)

# Metrics endpoint auth token (for Prometheus scraping)
openssl rand -hex 32
# -> use as: secrets.metricsAuthToken
```

### Secret Reference

| Secret key | Required | Format | Purpose |
|---|:---:|---|---|
| `postgresPassword` | yes | string | Postgres `browser_hitl` user password |
| `jwtSigningKey` | yes | ≥32 chars | Signs Tabby-issued JWTs (HS256) |
| `tenantEncryptionKey` | **yes** | **64 hex chars** | AES-256-GCM key for all credential/artifact encryption. **Most critical secret.** |
| `minioAccessKey` | yes | string | MinIO root username |
| `minioSecretKey` | yes | ≥8 chars | MinIO root password |
| `adminBootstrapPassword` | yes | strong password | Initial admin user (`admin@browser-hitl.local`) |
| `egressProxyAdminToken` | if egress proxy enabled | hex string | Authenticates allowlist management calls |
| `egressProxySessionKey` | if egress proxy enabled | hex string | HMAC key for per-session proxy auth |
| `serviceAuthClientSecret` | if bots enabled | hex string | Bot-to-API OAuth client secret |
| `metricsAuthToken` | optional | hex string | Bearer token for `/metrics` endpoint |
| `slackBotToken` | if Slack enabled | `xoxb-...` | From Slack app configuration |
| `slackSigningSecret` | if Slack enabled | hex | From Slack app configuration |
| `slackAppToken` | if Slack enabled | `xapp-...` | From Slack app (Socket Mode) |
| `microsoftAppId` | if Teams enabled | UUID | From Azure bot registration |
| `microsoftAppPassword` | if Teams enabled | string | From Azure bot registration |
| `natsAuthToken` | production recommended | string | NATS token auth (enable with `nats.auth.enabled: true`) |

> **About `tenantEncryptionKey`:** the chart automatically injects this key into API pods, Controller pods, and every Worker pod the controller creates at runtime. If you change this key after credentials have been extracted, all previously-encrypted artifact bundles become permanently unreadable. Rotate with a coordinated migration plan.

---

## Step 4 — Write values-onprem.yaml

Create a file named `values-onprem.yaml`. **Do not commit this file to git** — it contains secrets.

```yaml
# values-onprem.yaml — replace all REPLACE_ME values

# =============================================================================
# Image tags — pin to the chart version you are deploying
# =============================================================================
images:
  api:
    repository: ghcr.io/adoptai/tabby/api
    tag: "1.3.6"
    pullPolicy: IfNotPresent
  controller:
    repository: ghcr.io/adoptai/tabby/controller
    tag: "1.3.6"
    pullPolicy: IfNotPresent
  worker:
    repository: ghcr.io/adoptai/tabby/worker
    tag: "1.3.6"
    pullPolicy: IfNotPresent
  novnc:
    repository: ghcr.io/adoptai/tabby/novnc
    tag: "1.3.6"
    pullPolicy: IfNotPresent
  adminUi:
    repository: ghcr.io/adoptai/tabby/admin-ui
    tag: "1.3.6"
    pullPolicy: IfNotPresent
  slackBot:
    repository: ghcr.io/adoptai/tabby/slack-bot
    tag: "1.3.6"
    pullPolicy: IfNotPresent
  teamsBot:
    repository: ghcr.io/adoptai/tabby/teams-bot
    tag: "1.3.6"
    pullPolicy: IfNotPresent

# =============================================================================
# Optional: use a private registry mirror
# =============================================================================
# global:
#   imageRegistry: "registry.mycompany.internal"
#   imagePullSecrets:
#     - name: ghcr-creds

# =============================================================================
# API — stateless, scalable
# =============================================================================
api:
  replicas: 2                # ≥2 for production
  port: 8000

# =============================================================================
# Controller — must be exactly 1 replica
# =============================================================================
controller:
  replicas: 1                # DO NOT scale to 2 — reconcile loop uses row-level locking

# =============================================================================
# Worker resource sizing — tune for your target SaaS apps
# =============================================================================
worker:
  resources:
    requests:
      cpu: "1000m"
      memory: "2Gi"
    limits:
      cpu: "2000m"
      memory: "3Gi"
  novnc:
    resources:
      requests:
        cpu: "100m"
        memory: "128Mi"
      limits:
        cpu: "250m"
        memory: "256Mi"
  # Optional: schedule workers on a dedicated node pool
  # nodeSelector:
  #   workload: tabby-worker
  # tolerations:
  #   - key: workload
  #     operator: Equal
  #     value: tabby-worker
  #     effect: NoSchedule

# =============================================================================
# Notification bots — enable what you use
# =============================================================================
slackBot:
  enabled: false             # set true and provide tokens below if using Slack
teamsBot:
  enabled: false             # set true and provide credentials if using Teams

# =============================================================================
# Admin UI
# =============================================================================
adminUi:
  enabled: true
  replicas: 1

# =============================================================================
# In-cluster stateful services
# Set enabled: false and provide config.* URLs to use external services
# =============================================================================
postgres:
  enabled: true
  persistence:
    size: 50Gi
    storageClass: ""          # leave empty for cluster default; or set e.g. "tabby-retained"

redis:
  enabled: true
  persistence:
    size: 5Gi

nats:
  enabled: true
  auth:
    enabled: true            # enable in production
    token: ""                # set via secrets.natsAuthToken
  persistence:
    size: 10Gi
  jetstream:
    syncInterval: always     # MANDATORY — do not change

minio:
  enabled: true
  persistence:
    size: 100Gi              # artifacts grow; provision generously

# =============================================================================
# Egress proxy — controls and filters outbound browser traffic
# =============================================================================
egressProxy:
  enabled: true
  defaultAllowlist:
    - ".salesforce.com"
    - ".force.com"
    - ".workday.com"
    # Add your customers' target SaaS domains here.
    # Workers can only reach domains in this list.
    # Use fail-closed (egressPolicyFailClosed: "true") once fully populated.

# =============================================================================
# Network Policies — restrict inter-service traffic
# =============================================================================
networkPolicies:
  enabled: true              # enable in production

# =============================================================================
# Ingress — NGINX (two-host topology)
# =============================================================================
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"   # adjust to your issuer
  host: tabby-admin.mycompany.local    # Admin UI hostname
  tls:
    enabled: true
    secretName: tabby-admin-tls

# Second Ingress for the API (different hostname)
extraObjects:
  - apiVersion: networking.k8s.io/v1
    kind: Ingress
    metadata:
      name: tabby-api-ingress
      namespace: browser-hitl
      annotations:
        cert-manager.io/cluster-issuer: "letsencrypt-prod"
        nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
        nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
        nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    spec:
      ingressClassName: nginx
      tls:
        - hosts: [tabby-api.mycompany.local]
          secretName: tabby-api-tls
      rules:
        - host: tabby-api.mycompany.local
          http:
            paths:
              - path: /
                pathType: Prefix
                backend:
                  service:
                    name: tabby-browser-hitl-api    # <release>-browser-hitl-api
                    port:
                      number: 8000

# =============================================================================
# Runtime configuration
# =============================================================================
config:
  publicBaseUrl: "https://tabby-api.mycompany.local"       # externally reachable API URL
  streamHost: "tabby-api.mycompany.local"                  # for VNC WebSocket streams
  streamProtocol: "wss"

  # Session lifecycle
  maxSessionAgeHours: "24"
  idleShutdownSeconds: "3600"             # terminate idle sessions after 1h of no credential request

  # Egress proxy
  egressPolicyFailClosed: "true"          # workers cannot reach any non-allowlisted domain

  # Service auth (for bots connecting to the API)
  serviceAuthAllowedTenantIds: "*"
  serviceAuthAllowWildcardTenantScope: "true"
  serviceAuthClientId: "tabby-onprem-bot"

  # Swagger (disable in production if not needed)
  apiDocsEnabled: "false"

  # Lifecycle retention
  lifecycleSessionRetentionDays: "14"
  lifecycleInterventionRetentionDays: "30"
  lifecycleArtifactRetentionDays: "7"

# =============================================================================
# Backup (enable in production)
# =============================================================================
backup:
  enabled: true
  schedule: "0 2 * * *"      # daily at 2am UTC
  retentionCount: 30

# =============================================================================
# Alerting (enable if you run kube-prometheus-stack)
# =============================================================================
alerting:
  enabled: false             # set true if kube-prometheus-stack is installed

# =============================================================================
# Secrets — REPLACE ALL VALUES
# =============================================================================
secrets:
  postgresPassword: "REPLACE_ME"
  jwtSigningKey: "REPLACE_ME_MIN_32_CHARS"
  tenantEncryptionKey: "REPLACE_ME_64_HEX_CHARS"
  minioAccessKey: "REPLACE_ME"
  minioSecretKey: "REPLACE_ME"
  adminBootstrapPassword: "REPLACE_ME_STRONG_PASSWORD"
  egressProxyAdminToken: "REPLACE_ME_HEX"
  egressProxySessionKey: "REPLACE_ME_HEX"
  serviceAuthClientId: "tabby-onprem-bot"
  serviceAuthClientSecret: "REPLACE_ME_HEX"
  metricsAuthToken: "REPLACE_ME_HEX"
  natsAuthToken: "REPLACE_ME_HEX"
  # Slack (only if slackBot.enabled: true):
  # slackBotToken: "xoxb-..."
  # slackSigningSecret: "..."
  # slackAppToken: "xapp-..."
  # Teams (only if teamsBot.enabled: true):
  # microsoftAppId: "..."
  # microsoftAppPassword: "..."
```

---

## Step 5 — Deploy

```bash
helm upgrade --install tabby \
  oci://ghcr.io/adoptai/charts/browser-hitl \
  --version 1.3.6 \
  --namespace browser-hitl \
  --create-namespace \
  --values values-onprem.yaml \
  --wait \
  --timeout 15m
```

Expected output:
```
Release "tabby" has been upgraded. Happy Helming!
NAME: tabby
LAST DEPLOYED: ...
NAMESPACE: browser-hitl
STATUS: deployed
```

Watch pods come up:
```bash
kubectl get pods -n browser-hitl -w
```

Expected pods (assuming release name `tabby`):

| Pod name | Type | Expected count |
|---|---|---|
| `tabby-browser-hitl-api-*` | Deployment | 2 (or your `api.replicas`) |
| `tabby-browser-hitl-controller-*` | Deployment | 1 |
| `tabby-browser-hitl-admin-ui-*` | Deployment | 1 |
| `tabby-browser-hitl-egress-proxy-*` | Deployment | 1 |
| `tabby-browser-hitl-redis-*` | Deployment | 1 |
| `tabby-browser-hitl-postgres-0` | StatefulSet | 1 |
| `tabby-browser-hitl-nats-0` | StatefulSet | 1 |
| `tabby-browser-hitl-minio-0` | StatefulSet | 1 |

Worker pods do not exist until sessions are started.

> **Note on first deploy:** the controller pod may restart once in the first ~30 seconds while waiting for NATS to become ready. This is expected and self-healing.

---

## Step 6 — DNS Configuration

Create DNS records (or update `/etc/hosts` for testing) pointing both hostnames to your Ingress controller's external IP or load balancer:

```
tabby-api.mycompany.local    →  <ingress external IP>
tabby-admin.mycompany.local  →  <ingress external IP>
```

Verify DNS resolution from inside the cluster if JWKS fetches will use the same hostname:
```bash
kubectl run dns-test --rm -it --restart=Never --image=busybox -- \
  nslookup tabby-api.mycompany.local
```

---

## Step 7 — First Admin Login

The bootstrap admin account is created on first API startup using `secrets.adminBootstrapPassword`. Email is always `admin@browser-hitl.local`.

```bash
curl -s https://tabby-api.mycompany.local/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@browser-hitl.local","password":"YOUR_BOOTSTRAP_PASSWORD"}'
```

Expected response:
```json
{
  "token": "eyJhbGciOi...",
  "expires_at": "2026-04-18T17:48:06.780Z"
}
```

Save the `token` value — this is your admin token for subsequent setup calls.

---

## Step 8 — Configure an Identity Provider

Tabby is an OAuth Resource Server. It validates JWTs from a trusted IdP but does not initiate OAuth flows itself. Register your IdP:

> **Architecture note:** In the current deployment model, the IdP registered here should be the **platform's IdP** (e.g., Frontegg for Adopt-hosted deployments, or your organization's Keycloak/Okta/Azure AD for on-prem). Authentication is handled by the platform layer — end users authenticate to the platform first, which issues JWTs that Tabby then validates. Tabby does not authenticate directly against end customers' IdPs. The `issuer_url` you register here must be the issuer that signs the JWTs your platform produces.

```bash
ADMIN_TOKEN="eyJhbGciOi..."   # token from Step 7

curl -s https://tabby-api.mycompany.local/admin/identity-providers \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Your IdP Name",
    "provider_type": "oidc",
    "issuer_url": "https://your-idp.example.com",
    "tenant_id_claim": "org_id",
    "user_id_claim": "sub",
    "email_claim": "email",
    "name_claim": "name",
    "admin_domains": ["yourcompany.com"],
    "default_role": "Operator",
    "allow_auto_provision": true
  }'
```

### IdP Cheat Sheet

| Provider | `issuer_url` | `tenant_id_claim` | Notes |
|---|---|---|---|
| **Okta** | `https://YOURDOMAIN.okta.com/oauth2/default` | Custom claim (e.g. `org_id`) | Must configure claim in Okta Authorization Server |
| **Azure AD / Entra** | `https://login.microsoftonline.com/{directory_id}/v2.0` | `tid` | Each Azure AD tenant = one directory |
| **Frontegg (Adopt cloud)** | `https://adoptai.frontegg.com` | `tenantId` | No credentials needed; JWKS is public |
| **Auth0** | `https://YOURDOMAIN.auth0.com/` | Custom namespace claim | Must configure via Auth0 Action/Rule |
| **Keycloak** | `https://KEYCLOAK/realms/REALM` | `azp` or custom mapper | Most flexible for custom claims |
| **Google Workspace** | `https://accounts.google.com` | `hd` (hosted domain) | Limited multi-tenant support |

Verify JWKS reachability from inside the cluster after registering:
```bash
IDP_ID="<id-returned-from-registration>"

curl -s "https://tabby-api.mycompany.local/admin/identity-providers/$IDP_ID/test" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# Expected: {"success": true, "key_count": N, "latency_ms": N}
```

If this fails with a TLS error, the API pod may need your CA bundle. Set `NODE_EXTRA_CA_CERTS` in the API deployment or mount the CA cert.

---

## Step 9 — Verification

Run all checks before declaring the installation complete.

### 9.1 Health checks

```bash
# Liveness (API is running)
curl -s https://tabby-api.mycompany.local/health/live
# Expected: {"status":"ok","info":{"api":{"status":"up"}},...}

# Readiness (all dependencies connected)
curl -s https://tabby-api.mycompany.local/health/ready
# Expected: {"status":"ok","info":{"database":{"status":"up"},"redis":{"status":"up"},"nats":{"status":"up"}},...}
```

If readiness fails, check which component is `down` and inspect its pod logs:
```bash
kubectl logs -n browser-hitl -l app.kubernetes.io/component=api --tail=50
```

### 9.2 Admin UI reachable

```bash
curl -sI https://tabby-admin.mycompany.local/
# Expected: HTTP/2 200
```

### 9.3 Token validation

```bash
# With a real JWT from your IdP:
curl -s https://tabby-api.mycompany.local/auth/token-exchange \
  -H 'Content-Type: application/json' \
  -d '{"subject_token": "YOUR_IDP_JWT", "subject_token_type": "oidc_jwt"}'
# Expected: {"access_token": "...", "token_type": "Bearer", "expires_in": 3600}
```

### 9.4 Session creation (end-to-end)

```bash
# Create a minimal test session (requires an app template to be configured)
curl -s https://tabby-api.mycompany.local/sessions \
  -H "Authorization: Bearer $USER_JWT" \
  -H 'Content-Type: application/json' \
  -d '{"app_id": "YOUR_APP_ID"}'
# Expected: 201 + session object with state=STARTING

# Check the session state
SESSION_ID="<id from above>"
curl -s "https://tabby-api.mycompany.local/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $USER_JWT"
# Expected: state transitions STARTING → HEALTHY (or LOGIN_NEEDED if login required)
```

### 9.5 Worker pod created

Once a session is created, a worker pod should appear:
```bash
kubectl get pods -n browser-hitl
# Expected: a pod named tabby-browser-hitl-worker-<session-id>-* in Running state
```

### 9.6 Check controller logs

```bash
kubectl logs -n browser-hitl -l app.kubernetes.io/component=controller --tail=100
# Expected: Reconcile loop running every 15s, worker pod creation events
```

---

## Configuration Reference

### Key Runtime Config Values (`config.*`)

| Key | Default | Notes |
|---|---|---|
| `publicBaseUrl` | `""` | **Required.** Externally reachable API URL. Used in VNC stream URLs and links sent to Slack/Teams. |
| `streamHost` | `""` | **Required.** Hostname for WebSocket VNC streams. Usually same as `publicBaseUrl` host. |
| `streamProtocol` | `""` | `wss` for HTTPS, `ws` for plain HTTP. |
| `maxSessionAgeHours` | `24` | Sessions older than this are recycled, even if healthy. |
| `idleShutdownSeconds` | `0` | `0` = disabled. Set to e.g. `3600` to reclaim idle sessions. Must be > `defaultKeepaliveSeconds` (300). |
| `streamTtlSeconds` | `600` | Signed VNC stream URL lifetime in seconds. |
| `defaultKeepaliveSeconds` | `300` | How often worker sends a keepalive request to prevent session timeout. |
| `reconcileIntervalSeconds` | `15` | Controller reconcile loop interval. Do not set below 10. |
| `egressPolicyFailClosed` | `true` | If `true`, workers cannot connect to any domain not in the allowlist. Start with `false` during initial setup, switch to `true` once allowlist is populated. |
| `apiDocsEnabled` | `true` | Swagger UI at `/api/docs`. Disable in production (`"false"`). |
| `lifecycleSessionRetentionDays` | `14` | Terminated session records are deleted after this many days. |
| `lifecycleArtifactRetentionDays` | `7` | Artifact bundles in MinIO deleted after this many days. |
| `serviceAuthClientId` | `""` | Client ID used by bots to authenticate to the API. |
| `serviceAuthAllowedTenantIds` | `""` | Tenant ID allowlist for service auth. Use `*` for wildcard. |

### Worker Resource Tuning

The default worker resources (1 CPU / 2Gi request, 2 CPU / 3Gi limit) are sized for a medium-complexity SaaS login (Salesforce, Workday). Adjust based on actual usage:

```yaml
worker:
  resources:
    requests:
      cpu: "1000m"
      memory: "2Gi"     # Do not go below 2Gi for Salesforce Lightning / Workday
    limits:
      cpu: "2000m"
      memory: "3Gi"
```

### Egress Proxy Allowlist

The egress proxy blocks all outbound connections from worker pods except those matching the `defaultAllowlist`. Add your customers' target SaaS domains:

```yaml
egressProxy:
  enabled: true
  defaultAllowlist:
    - ".salesforce.com"
    - ".force.com"          # Salesforce communities / portals
    - ".workday.com"
    - ".myworkday.com"      # Workday tenant domains
    - ".okta.com"           # if workers need to reach Okta for SSO
    - ".microsoft.com"
    - ".microsoftonline.com"
    - ".office.com"
    - ".mycompany.com"      # your customers' internal domains if on VPN
```

Pattern format: `.example.com` matches `example.com` and all subdomains.

### Slack Bot Setup

To enable Slack HITL notifications, create a Slack app with Socket Mode and configure:

```yaml
slackBot:
  enabled: true
  slackDefaultChannel: "C1234567890"    # channel ID (not name)

secrets:
  slackBotToken: "xoxb-..."             # Bot token (from OAuth & Permissions)
  slackSigningSecret: "..."             # From Basic Information > App Credentials
  slackAppToken: "xapp-..."             # From Basic Information > App-Level Tokens (connections:write scope)
```

Required Slack bot scopes: `chat:write`, `chat:write.public`, `channels:read`, `im:write`, `views:open`.

---

## Troubleshooting

### API pod crashes on startup — TypeORM migration error

```
QueryFailedError: column "field" of relation "table" does not exist
```

The database schema is out of sync. This happens when:
- Migrations were previously run against a different schema version
- The database was partially migrated

Fix: check that `DATABASE_URL` points to the correct database, and that no stale TypeORM `synchronize: true` runs created the schema outside of migrations.

### API pod crashes — JWKS fetch fails at startup

```
Error: Unable to fetch JWKS from https://...
```

The API pod cannot reach the IdP's JWKS endpoint. Check:
1. Outbound HTTPS from the cluster is allowed for the IdP hostname
2. DNS resolves the IdP hostname from inside the pod:
   ```bash
   kubectl exec -n browser-hitl deploy/tabby-browser-hitl-api -- \
     curl -sI https://YOUR_IDP/.well-known/openid-configuration
   ```
3. If the IdP uses a private CA, set `NODE_EXTRA_CA_CERTS` in the API deployment

### Postgres pod fails — wrong ownership on PVC

```
FATAL: data directory "/var/lib/postgresql/data/pgdata" has wrong ownership
```

A pre-existing PVC has root-owned data. The chart runs Postgres as UID 999 with `fsGroup: 999`. Either delete the PVC (data loss) or run a temporary root pod to chown:

```bash
kubectl run pg-fix --rm -it --restart=Never --image=busybox \
  --overrides='{"spec":{"securityContext":{"runAsUser":0},"containers":[{"name":"c","image":"busybox","command":["chown","-R","999:999","/data"],"volumeMounts":[{"name":"v","mountPath":"/data"}]}],"volumes":[{"name":"v","persistentVolumeClaim":{"claimName":"data-tabby-browser-hitl-postgres-0"}}]}}'
```

### Credentials endpoint returns empty values

Symptom: `POST /credentials/request` returns `200` but all credential fields are `null` or `""`.

Root cause: `TENANT_ENCRYPTION_KEY` is missing or wrong on the API pod. The API decrypts artifacts uploaded by workers. If the keys don't match, decryption silently returns empty values.

Check:
```bash
kubectl exec -n browser-hitl deploy/tabby-browser-hitl-api -- \
  printenv TENANT_ENCRYPTION_KEY | wc -c
# Expected: 65 (64 chars + newline)
```

If it shows 1 (just newline) or wrong length, the secret is not set correctly.

### Worker pod never reaches HEALTHY

Check worker pod logs:
```bash
# Find the worker pod name
kubectl get pods -n browser-hitl | grep worker

# View logs
kubectl logs -n browser-hitl <worker-pod-name> -c worker --tail=100
```

Common causes:
- Target SaaS site requires MFA (session will transition to `LOGIN_NEEDED` — this is expected, set up Slack/Teams bot for HITL notification)
- Target domain not in egress proxy allowlist (check egress proxy logs: `kubectl logs -l app.kubernetes.io/component=egress-proxy -n browser-hitl`)
- Wrong credentials in the application's `login_config`

### Controller pod restarts repeatedly

```bash
kubectl logs -n browser-hitl -l app.kubernetes.io/component=controller --tail=50
```

If the error is NATS connection refused: NATS is not ready yet. Wait 60 seconds and check if the controller stabilizes.

If the error is K8s RBAC (Forbidden): the `Role` and `RoleBinding` for the controller service account are missing or incorrect. Verify:
```bash
kubectl get rolebinding -n browser-hitl
kubectl describe rolebinding tabby-browser-hitl-controller -n browser-hitl
```

### Postgres password does not change after helm upgrade

Changing `secrets.postgresPassword` in `values-onprem.yaml` and running `helm upgrade` updates the Kubernetes Secret but does NOT change the actual Postgres database password. The `initdb` password is set only once at PVC creation time.

To actually change the Postgres password:
```bash
kubectl exec -n browser-hitl tabby-browser-hitl-postgres-0 -- \
  psql -U browser_hitl -c "ALTER USER browser_hitl WITH PASSWORD 'new-password';"
```
Then update the secret value in your values file.

### `idleShutdownSeconds` has no effect

`idleShutdownSeconds` must be set to a value **greater than** `defaultKeepaliveSeconds` (default: 300 seconds). Setting `idleShutdownSeconds: 100` is invalid because the keepalive runner would fire before the idle timer expires.

Minimum effective value: 360 seconds (one keepalive interval beyond the keepalive period).

---

## Air-Gapped / Offline Installation

If the cluster has no internet access, mirror images to your internal registry first.

### Step A — Pull and push images (on a machine with internet)

```bash
CHART_VERSION="1.3.6"
IMAGE_TAG="1.3.6"
SOURCE="ghcr.io/adoptai/tabby"
TARGET="registry.mycompany.internal/tabby"

for svc in api controller worker novnc slack-bot teams-bot admin-ui; do
  docker pull $SOURCE/$svc:$IMAGE_TAG
  docker tag $SOURCE/$svc:$IMAGE_TAG $TARGET/$svc:$IMAGE_TAG
  docker push $TARGET/$svc:$IMAGE_TAG
done

# Also mirror infrastructure images:
docker pull postgres:16.8-alpine && docker tag postgres:16.8-alpine $TARGET/postgres:16.8-alpine && docker push $TARGET/postgres:16.8-alpine
docker pull redis:7.4-alpine && docker tag redis:7.4-alpine $TARGET/redis:7.4-alpine && docker push $TARGET/redis:7.4-alpine
docker pull nats:2.10.24-alpine && docker tag nats:2.10.24-alpine $TARGET/nats:2.10.24-alpine && docker push $TARGET/nats:2.10.24-alpine
docker pull minio/minio:RELEASE.2025-03-12T18-04-18Z && docker tag minio/minio:RELEASE.2025-03-12T18-04-18Z $TARGET/minio:2025-03-12 && docker push $TARGET/minio:2025-03-12
```

### Step B — Pull and save the Helm chart

```bash
helm pull oci://ghcr.io/adoptai/charts/browser-hitl --version 1.3.6
# Produces: browser-hitl-1.3.6.tgz
```

### Step C — Update values to use internal registry

```yaml
global:
  imageRegistry: "registry.mycompany.internal/tabby"
  imagePullSecrets:
    - name: internal-registry-creds

# Override infrastructure images to point to your mirror:
postgres:
  image:
    repository: registry.mycompany.internal/tabby/postgres
    tag: "16.8-alpine"
redis:
  image:
    repository: registry.mycompany.internal/tabby/redis
    tag: "7.4-alpine"
nats:
  image:
    repository: registry.mycompany.internal/tabby/nats
    tag: "2.10.24-alpine"
minio:
  image:
    repository: registry.mycompany.internal/tabby/minio
    tag: "2025-03-12"
```

### Step D — Deploy from local chart

```bash
helm upgrade --install tabby ./browser-hitl-1.3.6.tgz \
  --namespace browser-hitl \
  --create-namespace \
  --values values-onprem.yaml \
  --wait \
  --timeout 15m
```

For air-gapped IdP validation: if the IdP JWKS endpoint is reachable within your network (on-prem Keycloak, etc.), no additional configuration is needed. If the IdP is completely unreachable, JWT validation will fail after the 5-minute JWKS cache expires. In that case, JWKS caching TTL can be extended via `EXTERNAL_JWKS_CACHE_TTL_SECONDS` env (contact the Tabby team for support).

---

## Post-Installation Checklist

- [ ] All pods in `browser-hitl` namespace show `Running` or `Completed`
- [ ] `GET /health/ready` returns `200` with all components `up`
- [ ] Admin UI loads at `https://tabby-admin.mycompany.local/`
- [ ] Admin login works (`admin@browser-hitl.local` + bootstrap password)
- [ ] IdP registered and JWKS test passes
- [ ] A real platform JWT validates successfully via `/auth/token-exchange`
- [ ] A test session reaches `HEALTHY` state
- [ ] Worker pod appears during session creation, disappears after termination
- [ ] `networkPolicies.enabled: true` confirmed
- [ ] `nats.auth.enabled: true` confirmed
- [ ] `egressPolicyFailClosed: "true"` confirmed
- [ ] `secrets.tenantEncryptionKey` is 64 hex characters
- [ ] Backup CronJob enabled (`backup.enabled: true`)
- [ ] `config.apiDocsEnabled: "false"` for production
- [ ] TLS enabled on both Ingress hosts
- [ ] `values-onprem.yaml` is **not** committed to any git repository
