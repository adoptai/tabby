# Tabby — Customer Release Guide

Quick reference for deploying Tabby via Helm. For detailed setup steps, see `tabby-setup-guide.md`. For cluster sizing, see `cluster-sizing-guide.md`.

---

## Prerequisites

- Kubernetes 1.27+ cluster with sufficient resources (see cluster-sizing-guide.md)
- Helm 3.x
- NGINX Ingress Controller (or Istio with manual VirtualService)
- Public DNS entry for the Tabby API (e.g., `tabby-api.customer.com`)
- WebSocket support on ingress with 3600s timeout
- Outbound HTTPS to the IdP (JWKS endpoint) and target SaaS sites
- Docker Hub pull secret (to avoid rate limiting on infrastructure images)

---

## Secrets Reference

Generate these before deployment. All secrets go under `secrets:` in the values file.


| Secret                    | Required | How to generate           | Who provides                        | Description                                                                                                |
| ------------------------- | -------- | ------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `jwtSigningKey`           | **Yes**  | `openssl rand -hex 48`    | Customer generates                  | Signs all Tabby JWTs (login, service auth, VNC). Min 32 chars.                                             |
| `tenantEncryptionKey`     | **Yes**  | `openssl rand -hex 32`    | Customer generates                  | AES-256-GCM key for credential encryption. Exactly 64 hex chars. **Cannot be changed after first deploy.** |
| `agentHmacKey`            | **Yes**  | `openssl rand -hex 32`    | Customer generates                  | HMAC key for agent client_secret signing. Changing invalidates all agent credentials.                      |
| `adminBootstrapPassword`  | **Yes**  | Choose strong password    | Customer chooses                    | Initial admin user password. Uppercase + lowercase + digit + special char, min 12 chars.                   |
| `serviceAuthClientSecret` | **Yes**  | `openssl rand -hex 32`    | Customer generates                  | Service-to-service auth secret (platform → Tabby).                                                         |
| `postgresPassword`        | **Yes**  | `openssl rand -hex 16`    | Customer generates                  | PostgreSQL password (bundled instance).                                                                    |
| `minioAccessKey`          | **Yes**  | `openssl rand -hex 12`    | Customer generates                  | MinIO root access key.                                                                                     |
| `minioSecretKey`          | **Yes**  | `openssl rand -hex 24`    | Customer generates                  | MinIO root secret key.                                                                                     |
| `egressProxyAdminToken`   | **Yes**  | `openssl rand -hex 32`    | Customer generates                  | Egress proxy allowlist management token.                                                                   |
| `egressProxySessionKey`   | **Yes**  | `openssl rand -hex 32`    | Customer generates                  | Egress proxy session signing key.                                                                          |
| `idpClientId`             | **Yes**  | —                         | **Adopt provides**                  | OAuth client ID for VNC authentication.                                                                    |
| `idpClientSecret`         | **Yes**  | —                         | **Adopt provides**                  | Frontegg OAuth client secret.                                                                              |
| `sentryDsn`               | No       | —                         | Adopt provides (if needed)          | Sentry error reporting endpoint. Leave empty to disable.                                                   |
| `metricsAuthToken`        | No       | `openssl rand -base64 32` | Customer generates (optional)       | Bearer token for `/metrics` Prometheus endpoint. Empty = open.                                             |
| `serviceAuthClientId`     | No       | —                         | Set in `config.serviceAuthClientId` | OAuth client ID for bots → API auth. Only needed if bots are enabled.                                      |


> **Note on `idpClientId` / `idpClientSecret`:** These are Frontegg credentials, not the customer's Okta/Google credentials. The customer configures their IdP (Okta, Google, Azure AD) on the platform side. Tabby uses Frontegg under the hood for the VNC authentication gate. These values are provided by the Adopt team after registering the Tabby callback URL.

---

## Sample values.yaml

```yaml
# =============================================================================
# Images — use the release tag provided by Adopt
# =============================================================================
images:
  api:
    tag: "prod-a2cb522"
    repository: ghcr.io/adoptai/tabby/api
    pullPolicy: Always
  controller:
    tag: "prod-a2cb522"
    repository: ghcr.io/adoptai/tabby/controller
    pullPolicy: Always
  worker:
    tag: "prod-a2cb522"
    repository: ghcr.io/adoptai/tabby/worker
    pullPolicy: Always
  novnc:
    tag: "prod-a2cb522"
    repository: ghcr.io/adoptai/tabby/novnc
    pullPolicy: Always
  slackBot:
    tag: "prod-a2cb522"
    repository: ghcr.io/adoptai/tabby/slack-bot
    pullPolicy: Always
  teamsBot:
    tag: "prod-a2cb522"
    repository: ghcr.io/adoptai/tabby/teams-bot
    pullPolicy: Always

# =============================================================================
# Secrets — generate all values before deployment
# =============================================================================
secrets:
  jwtSigningKey: ""           # openssl rand -base64 48
  tenantEncryptionKey: ""     # openssl rand -hex 32 (64 hex chars)
  agentHmacKey: ""            # openssl rand -base64 32
  adminBootstrapPassword: ""  # strong password
  serviceAuthClientSecret: "" # openssl rand -base64 32
  postgresPassword: ""        # openssl rand -base64 24
  minioAccessKey: ""          # openssl rand -base64 16
  minioSecretKey: ""          # openssl rand -base64 32
  egressProxyAdminToken: ""   # openssl rand -hex 32
  egressProxySessionKey: ""   # openssl rand -hex 32
  idpClientId: ""             # provided by Adopt
  idpClientSecret: ""         # provided by Adopt
  metricsAuthToken: ""        # optional

# =============================================================================
# Core configuration
# =============================================================================
config:
  publicBaseUrl: "https://tabby-api.customer.com"  # REQUIRED — must be publicly reachable
  streamHost: "tabby-api.customer.com"
  streamProtocol: "wss"
  adminBootstrapEmail: "admin@browser-hitl.local"
  maxSessionAgeHours: "24"
  idleShutdownSeconds: "3600"
  dbPoolSize: "20"
  reconcileBatchSize: "50"
  apiDocsEnabled: "true"

# =============================================================================
# Docker Hub pull secret (avoid rate limiting)
# =============================================================================
global:
  imagePullSecrets:
    - name: dockerhub-pull-secret

# =============================================================================
# Ingress — public DNS entry required
# =============================================================================
ingress:
  enabled: true
  ingressClassName: nginx
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
  hosts:
    - host: tabby-api.customer.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: tabby-api-tls
      hosts:
        - tabby-api.customer.com

# =============================================================================
# Resource sizing (see cluster-sizing-guide.md for capacity planning)
# =============================================================================
api:
  replicas: 1
  resources:
    requests:
      cpu: "500m"
      memory: "512Mi"
    limits:
      cpu: "2000m"
      memory: "2Gi"

controller:
  replicas: 1
  resources:
    requests:
      cpu: "500m"
      memory: "512Mi"
    limits:
      cpu: "1000m"
      memory: "1Gi"

worker:
  resources:
    requests:
      cpu: "1000m"
      memory: "2Gi"
    limits:
      cpu: "2000m"
      memory: "3Gi"

postgresql:
  enabled: true
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2000m"
      memory: "2Gi"
  persistence:
    size: 20Gi

redis:
  enabled: true
  persistence:
    size: 5Gi

nats:
  enabled: true
  persistence:
    size: 20Gi

minio:
  enabled: true
  persistence:
    size: 50Gi

# =============================================================================
# Egress proxy — controls outbound traffic from worker browsers
# =============================================================================
egressProxy:
  enabled: true
  defaultAllowlist:
    # Target SaaS applications
    - ".salesforce.com"
    - ".force.com"
    - ".workday.com"
    - ".workdaycdn.com"
    - ".automationanywhere.digital"
    - ".automationanywhere.com"
    # Auth providers
    - ".microsoftonline.com"
    - ".login.live.com"
    - ".windows.net"
    - ".microsoft.com"
    - ".msauth.net"
    - ".msftauth.net"
    - ".b2clogin.com"
    - ".auth0.com"
    - ".recaptcha.net"
    - ".onmicrosoft.com"
    # CDNs and static assets
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
    - ".typekit.net"
    # Analytics (commonly loaded by target sites)
    - ".sentry.io"
    - ".datadoghq.com"
    - ".pendo.io"
    - ".rollbar.com"
    - ".dynatrace.com"
    - ".go-mpulse.net"
    - ".heap-api.com"

# =============================================================================
# Optional — bots (disabled by default)
# =============================================================================
slackBot:
  enabled: false
teamsBot:
  enabled: false
adminUi:
  enabled: false
```

---

## Docker Hub Pull Secret

Create the pull secret before deploying to avoid Docker Hub rate limits on infrastructure images (Postgres, Redis, NATS, MinIO):

```bash
kubectl create secret docker-registry dockerhub-pull-secret \
  --namespace <NAMESPACE> \
  --docker-server=https://index.docker.io/v1/ \
  --docker-username=<DOCKERHUB_USERNAME> \
  --docker-password=<DOCKERHUB_TOKEN>
```

---

## Post-Deploy Verification

```bash
# All pods running
kubectl get pods -n <NAMESPACE>

# API health
curl -s https://tabby-api.customer.com/health/live

# Admin login
curl -s https://tabby-api.customer.com/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@browser-hitl.local","password":"YOUR_ADMIN_PASSWORD"}'
```

---

## What Adopt Provides vs Customer Provides


| Item                                | Who                                |
| ----------------------------------- | ---------------------------------- |
| Helm chart + image tags             | Adopt                              |
| `idpClientId` / `idpClientSecret`   | Adopt                              |
| `sentryDsn` (if used)               | Adopt                              |
| All other secrets                   | Customer generates                 |
| Cluster + DNS + ingress             | Customer                           |
| Egress allowlist customization      | Customer (add target site domains) |
| IdP registration in Tabby           | Adopt (post-deploy)                |
| App templates (Salesforce, Workday) | Adopt (post-deploy)                |


