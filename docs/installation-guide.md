# Tabby (Browser HITL) — Installation Guide

**Chart:** `browser-hitl`
**OCI Registry:** `oci://ghcr.io/adoptai/charts/browser-hitl`
**Deployment method:** Replicated (managed Helm deployment)
**Last updated:** 2026-05-06

---

## Deployment Model

Tabby is deployed via **Replicated**, which manages the Helm chart lifecycle (install, upgrade, rollback). The infrastructure team does not run `helm install` directly — Replicated handles chart delivery, image mirroring (for air-gapped environments), and version management.

The Helm chart OCI reference is:

```
oci://ghcr.io/adoptai/charts/browser-hitl
```

Replicated pulls this chart and applies the customer-provided configuration values. This guide covers **what to configure**, not how to run the deployment command.

---

## Prerequisites

### Cluster Requirements


| Requirement        | Minimum                                                 | Recommended                                                    |
| ------------------ | ------------------------------------------------------- | -------------------------------------------------------------- |
| Kubernetes version | 1.27                                                    | 1.28–1.30                                                      |
| CPU available      | 8 vCPU                                                  | 16+ vCPU                                                       |
| RAM available      | 32 GiB                                                  | 64+ GiB                                                        |
| Storage            | Default StorageClass with ReadWriteOnce SSD-backed PVCs | `Retain` reclaim policy                                        |
| Ingress            | NGINX Ingress Controller or Istio + Gateway             | NGINX preferred                                                |
| Outbound HTTPS     | Required                                                | To IdP (JWKS fetches), to target SaaS sites (via egress proxy) |
| Pod Security       | Standard or restricted                                  | Chart is compatible with `restricted` PSA profile              |


The permanent services (API, Controller, Egress Proxy, Postgres, Redis, NATS, MinIO) consume a fixed baseline of resources. Worker pods are created dynamically — one per active service profile — and remain alive for continuous credential extraction. Ensure the cluster has sufficient headroom to schedule worker pods on demand.

### Namespace

Tabby deploys into a single namespace (default: `browser-hitl`). All RBAC is namespace-scoped — no cluster-admin privileges are needed after initial setup.

---

## Secrets

Generate all secrets before configuring values. Store them in your secret manager.

```bash
# AES-256-GCM key for credential encryption (exactly 64 hex chars = 32 bytes)
openssl rand -hex 32
# -> tenantEncryptionKey

# JWT signing key (HS256, minimum 32 chars)
openssl rand -base64 48 | tr -d '\n'
# -> jwtSigningKey

# Postgres password
openssl rand -base64 24
# -> postgresPassword

# MinIO credentials
openssl rand -base64 16 | tr -d '=' | tr '+/' 'az'   # accessKey
openssl rand -base64 32                                # secretKey

# Admin bootstrap password
openssl rand -base64 16
# -> adminBootstrapPassword

# Egress proxy tokens
openssl rand -hex 32   # egressProxyAdminToken
openssl rand -hex 32   # egressProxySessionKey

# Service auth secret (bots → API)
openssl rand -hex 32   # serviceAuthClientSecret

# NATS auth token
openssl rand -hex 32   # natsAuthToken
```

### Secret Reference


| Secret                    | Required         | Format           | Purpose                                                                                                          |
| ------------------------- | ---------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `tenantEncryptionKey`     | **yes**          | **64 hex chars** | AES-256-GCM key for credential/artifact encryption. **Most critical secret — loss = unrecoverable credentials.** |
| `jwtSigningKey`           | yes              | ≥32 chars        | Signs Tabby-issued JWTs (HS256)                                                                                  |
| `postgresPassword`        | yes              | string           | Postgres user password                                                                                           |
| `minioAccessKey`          | yes              | string           | MinIO root username                                                                                              |
| `minioSecretKey`          | yes              | ≥8 chars         | MinIO root password                                                                                              |
| `adminBootstrapPassword`  | yes              | strong password  | Initial admin user (`admin@browser-hitl.local`)                                                                  |
| `egressProxyAdminToken`   | yes              | hex string       | Authenticates allowlist management                                                                               |
| `egressProxySessionKey`   | yes              | hex string       | HMAC key for per-session proxy auth                                                                              |
| `serviceAuthClientSecret` | if bots enabled  | hex string       | Bot-to-API OAuth client secret                                                                                   |
| `natsAuthToken`           | recommended      | string           | NATS token auth                                                                                                  |
| `slackBotToken`           | if Slack enabled | `xoxb-...`       | Slack bot token                                                                                                  |
| `slackSigningSecret`      | if Slack enabled | hex              | Slack signing secret                                                                                             |
| `slackAppToken`           | if Slack enabled | `xapp-...`       | Slack Socket Mode token                                                                                          |
| `microsoftAppId`          | if Teams enabled | UUID             | Azure bot registration                                                                                           |
| `microsoftAppPassword`    | if Teams enabled | string           | Azure bot password                                                                                               |


> **About `tenantEncryptionKey`:** Injected automatically into API, Controller, and every Worker pod. Changing this key after deployment makes all previously-encrypted artifacts permanently unreadable.

---

## Configuration Values

These values are provided through Replicated's configuration interface or as a values file that Replicated applies during deployment.

### Core Configuration

```yaml
# =============================================================================
# API
# =============================================================================
api:
  replicas: 2                # ≥2 for production

# =============================================================================
# Controller — MUST be exactly 1 replica
# =============================================================================
controller:
  replicas: 1

# =============================================================================
# Admin UI — disabled by default
# =============================================================================
adminUi:
  enabled: false

# =============================================================================
# Notification bots — enable as needed
# =============================================================================
slackBot:
  enabled: false
teamsBot:
  enabled: false

# =============================================================================
# Worker resource sizing
# =============================================================================
worker:
  resources:
    requests:
      cpu: "1000m"
      memory: "2Gi"
    limits:
      cpu: "2000m"
      memory: "3Gi"
```

### Ingress (two-host topology)

The API and Admin UI require **separate hostnames**. A single shared hostname does not work.


| Host                   | Target           | Example                    |
| ---------------------- | ---------------- | -------------------------- |
| `tabby-api.<domain>`   | API (:8000)      | `tabby-api.customer.com`   |
| `tabby-admin.<domain>` | Admin UI (:8000) | `tabby-admin.customer.com` |


```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  host: tabby-admin.customer.com
  tls:
    enabled: true
    secretName: tabby-admin-tls

config:
  publicBaseUrl: "https://tabby-api.customer.com"
  streamHost: "tabby-api.customer.com"
  streamProtocol: "wss"
```

### In-Cluster Stateful Services

By default the chart deploys Postgres, Redis, NATS, and MinIO as in-cluster StatefulSets. To use external managed services, disable the in-cluster ones and provide connection URLs:

```yaml
# External services example
postgres:
  enabled: false
redis:
  enabled: false
nats:
  enabled: false
minio:
  enabled: false

config:
  databaseUrl: "postgresql://user:pass@your-db:5432/browser_hitl"
  redisUrl: "redis://your-redis:6379"
  natsUrl: "nats://your-nats:4222"
  minioEndpoint: "s3.your-domain.com"
```

In-cluster storage sizing (if using defaults):


| Service  | PVC Size | Type            |
| -------- | -------- | --------------- |
| Postgres | 50Gi     | SSD required    |
| Redis    | 5Gi      | Standard        |
| NATS     | 20Gi     | SSD required    |
| MinIO    | 100Gi    | SSD recommended |


### Egress Proxy

Controls all outbound browser traffic from worker pods. Configure the allowlist with the customer's target SaaS domains:

```yaml
egressProxy:
  enabled: true
  defaultAllowlist:
    - ".salesforce.com"
    - ".force.com"
    - ".workday.com"
    - ".myworkday.com"
    # Add target SaaS domains here.
    # Workers can ONLY reach domains in this list.
```

### Network Policies

```yaml
networkPolicies:
  enabled: true    # enable in production
```

### Runtime Settings


| Key                             | Default  | Notes                                                   |
| ------------------------------- | -------- | ------------------------------------------------------- |
| `config.publicBaseUrl`          | `""`     | **Required.** External API URL.                         |
| `config.streamHost`             | `""`     | **Required.** Hostname for VNC WebSocket streams.       |
| `config.streamProtocol`         | `""`     | `wss` for HTTPS, `ws` for HTTP.                         |
| `config.maxSessionAgeHours`     | `24`     | Sessions recycled after this.                           |
| `config.idleShutdownSeconds`    | `0`      | `0` = disabled. Set to `3600` to reclaim idle sessions. |
| `config.egressPolicyFailClosed` | `true`   | Workers blocked from non-allowlisted domains.           |
| `config.apiDocsEnabled`         | `true`   | Swagger UI. Disable in production (`"false"`).          |
| `nats.jetstream.syncInterval`   | `always` | **Mandatory — do not change.**                          |
| `nats.auth.enabled`             | `false`  | Set `true` in production.                               |
| `backup.enabled`                | `false`  | Set `true` in production (daily pg_dump to MinIO).      |


---

## Identity Provider Configuration

Tabby validates JWTs from a trusted IdP but does not initiate OAuth flows itself.

> **Important:** The IdP registered here should be the **platform's IdP** (e.g., Frontegg). End users authenticate to the platform first — Tabby validates the JWTs the platform produces.

After deployment, register the IdP via the API:

```bash
curl -s https://tabby-api.customer.com/admin/identity-providers \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Platform IdP",
    "provider_type": "oidc",
    "issuer_url": "https://your-idp.example.com",
    "tenant_id_claim": "org_id",
    "user_id_claim": "sub",
    "email_claim": "email",
    "admin_domains": ["yourcompany.com"],
    "allow_auto_provision": true
  }'
```


| Provider               | `issuer_url`                                      | `tenant_id_claim` |
| ---------------------- | ------------------------------------------------- | ----------------- |
| Frontegg (Adopt cloud) | `https://adoptai.frontegg.com`                    | `tenantId`        |
| Okta                   | `https://DOMAIN.okta.com/oauth2/default`          | Custom claim      |
| Azure AD               | `https://login.microsoftonline.com/{dir_id}/v2.0` | `tid`             |
| Keycloak               | `https://KEYCLOAK/realms/REALM`                   | Custom mapper     |


---

## Verification

After deployment, confirm:

```bash
# API health
curl -s https://tabby-api.customer.com/health/ready
# Expected: {"status":"ok","info":{"database":{"status":"up"},"redis":{"status":"up"},"nats":{"status":"up"}}}

# Admin login (bootstrap user)
curl -s https://tabby-api.customer.com/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@browser-hitl.local","password":"YOUR_BOOTSTRAP_PASSWORD"}'
# Expected: {"token": "eyJ..."}

# Token exchange with platform JWT
curl -s https://tabby-api.customer.com/auth/token-exchange \
  -H 'Content-Type: application/json' \
  -d '{"subject_token": "YOUR_IDP_JWT", "subject_token_type": "oidc_jwt"}'
# Expected: {"access_token": "...", "token_type": "Bearer"}
```

Check pods:

```bash
kubectl get pods -n browser-hitl
# Expected: API (2), Controller (1), Egress Proxy (1), Postgres (1), Redis (1), NATS (1), MinIO (1)
# Worker pods appear only when sessions are created.
```

---

## Troubleshooting

### Credentials return empty values

`TENANT_ENCRYPTION_KEY` missing or wrong on API pod. Check:

```bash
kubectl exec -n browser-hitl deploy/tabby-browser-hitl-api -- printenv TENANT_ENCRYPTION_KEY | wc -c
# Expected: 65 (64 chars + newline)
```

### Postgres password doesn't change after upgrade

`initdb` password is set once at PVC creation. To change:

```bash
kubectl exec -n browser-hitl tabby-browser-hitl-postgres-0 -- \
  psql -U browser_hitl -c "ALTER USER browser_hitl WITH PASSWORD 'new-password';"
```

### Controller restarts repeatedly

Usually NATS not ready yet. Wait 60s. If RBAC error:

```bash
kubectl describe rolebinding tabby-browser-hitl-controller -n browser-hitl
```

### Worker never reaches HEALTHY

Check worker logs:

```bash
kubectl logs -n browser-hitl <worker-pod> -c worker --tail=100
```

Common causes: target domain not in egress allowlist, MFA required (expected — triggers HITL), wrong login credentials.

### JWKS fetch fails

API can't reach IdP. Check DNS and outbound HTTPS from the pod:

```bash
kubectl exec -n browser-hitl deploy/tabby-browser-hitl-api -- \
  curl -sI https://YOUR_IDP/.well-known/openid-configuration
```

If private CA: set `NODE_EXTRA_CA_CERTS` in the API deployment.

---

## Post-Deployment Checklist

- All pods `Running`
- `GET /health/ready` returns all components `up`
- Admin login works
- IdP registered and JWKS reachable
- Platform JWT validates via `/auth/token-exchange`
- `networkPolicies.enabled: true`
- `nats.auth.enabled: true`
- `egressPolicyFailClosed: "true"`
- `tenantEncryptionKey` is 64 hex chars
- `backup.enabled: true`
- `apiDocsEnabled: "false"`
- TLS enabled on ingress
- Values file not committed to git

