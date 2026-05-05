# Tabby (Browser HITL) — Production DevOps Requirements

**Chart:** `oci://ghcr.io/adoptai/charts/browser-hitl`
**Image registry:** `ghcr.io/adoptai/tabby/{service}`
**Target scale:** ~500 users, production on-premises deployment

---

## Cluster Node Requirements

### Node pool

A single node pool handles all Tabby workloads (permanent services + ephemeral worker pods).

| Property | Recommendation |
|---|---|
| Instance type | General-purpose compute, 16+ vCPU, 32+ GiB RAM per node |
| Minimum nodes | 3 (HA — tolerate one node failure without downtime) |
| Storage | SSD-backed volumes (required for Postgres and NATS PVCs) |
| OS | Linux (Ubuntu 22.04 LTS or equivalent) |

Each active service profile creates one worker pod (~1.1 GiB memory request, 550m CPU). Ensure the cluster has enough headroom beyond the permanent services baseline to schedule worker pods as needed.

> **Optional:** For large-scale deployments, a dedicated worker node pool with `nodeSelector`/taints can isolate bursty browser workloads from permanent services. This is not required — all workloads run fine on a single pool.

### Storage class

SSD-backed `ReadWriteOnce` PVCs are required for Postgres, NATS, and MinIO. Ensure the cluster default `StorageClass` (or the one set in `global.storageClass`) provisions SSD volumes. Spinning-disk storage is not suitable for Postgres or NATS at production load.

---

## Permanent Services

### API (NestJS)

| Property | Production |
|---|---|
| Replicas | 2–3 (see Scaling section below) |
| CPU request | 1000m |
| CPU limit | 2000m |
| Memory request | 1Gi |
| Memory limit | 2Gi |
| Port | 8000 |
| Base image | `node:20-slim` |
| Run-time flag | `--max-old-space-size=1536` (Node heap) |

Stateless — safe to run multiple replicas behind the ingress. See [Scaling](#scaling) below.

### Controller (NestJS standalone)

| Property | Production |
|---|---|
| Replicas | 1 (single reconcile loop; do not run multiple instances) |
| CPU request | 500m |
| CPU limit | 1000m |
| Memory request | 512Mi |
| Memory limit | 1Gi |
| Port | 8090 |
| Base image | `node:20-slim` |

Requires namespace-scoped RBAC (`Role` + `RoleBinding`) to `create/delete/get/list/watch` pods, services, and NetworkPolicies.

### Admin UI (Next.js)

Disabled by default in production. Enable only if internal operators need the dashboard.

```yaml
adminUi:
  enabled: false   # set true to expose the dashboard
```

If enabled:

| Property | Production |
|---|---|
| Replicas | 1 |
| CPU request | 250m |
| CPU limit | 500m |
| Memory request | 256Mi |
| Memory limit | 512Mi |
| Port | 8000 |

### Slack Bot

Disabled by default. Enable only if the customer uses Slack for HITL notifications.

```yaml
slackBot:
  enabled: false   # set true to enable Slack integration
```

Required secrets when enabled:

| Secret | Description |
|---|---|
| `slackBotToken` | Bot User OAuth Token (`xoxb-…`) |
| `slackSigningSecret` | Request signing secret |
| `slackAppToken` | App-level token for Socket Mode (`xapp-…`) |

Also set `slackBot.slackDefaultChannel` to the Slack channel ID for HITL notifications.

### Teams Bot

Disabled by default. Enable only if the customer uses Microsoft Teams.

```yaml
teamsBot:
  enabled: false   # set true to enable Teams integration
```

Required secrets when enabled: `microsoftAppId`, `microsoftAppPassword`.

### Egress Proxy

| Property | Production |
|---|---|
| Enabled | true |
| Replicas | 1 |
| CPU request | 100m |
| CPU limit | 500m |
| Memory request | 128Mi |
| Memory limit | 512Mi |
| Ports | 3128 (proxy), 8095 (admin) |

Enforces FQDN allowlisting for all worker browser traffic. Required in production; must be enabled and configured with the customer's allowed domain list.

---

## Ephemeral Service: Worker Pod

Worker pods are **not a Deployment** — the controller creates and destroys one pod per active service profile. Each worker pod has two containers (worker + noVNC sidecar) sharing the pod network namespace.

### Worker container

| Property | Production |
|---|---|
| CPU request | 500m |
| CPU limit | 1000m |
| Memory request | 1Gi |
| Memory limit | 1.5Gi |
| Port | 8091 (health HTTP) |
| Internal VNC | 5900 (localhost only) |
| Base image | `mcr.microsoft.com/playwright:v1.58.2-noble` |

Includes Xvfb, x11vnc, and CloakBrowser stealth Chromium. Runs as `pwuser` (non-root). Worker pods remain alive for the lifetime of the service profile, continuously extracting tokens (cookies, CSRF, custom JS) on a configurable interval. Chromium + Node runtime need 800–1000 MiB for these workloads.

### noVNC sidecar

| Property | Production |
|---|---|
| CPU request | 50m |
| CPU limit | 150m |
| Memory request | 64Mi |
| Memory limit | 128Mi |
| Port | 6080 (noVNC web client) |
| Base image | `python:3.11-slim` |

### Total per worker pod

- **CPU:** 550m request / 1150m limit
- **Memory:** ~1.1 GiB request / ~1.6 GiB limit

Each active service profile requires one worker pod. Size the worker node pool based on the number of concurrent active profiles.

---

## Infrastructure Services

### PostgreSQL

| Property | Production |
|---|---|
| Image | `postgres:16.8-alpine` |
| CPU request | 1000m |
| CPU limit | 2000m |
| Memory request | 1Gi |
| Memory limit | 2Gi |
| Port | 5432 |
| PVC | **50Gi** SSD (ReadWriteOnce) |

At 500-user scale, Postgres stores sessions, interventions, service profiles, audit events, and application metadata accumulated over months. 50Gi provides substantial headroom; monitor and expand if growth exceeds 60% utilisation.

### Redis

| Property | Production |
|---|---|
| Image | `redis:7.4-alpine` |
| CPU request | 500m |
| CPU limit | 1000m |
| Memory request | 512Mi |
| Memory limit | 1Gi |
| Port | 6379 |
| PVC | **5Gi** (ReadWriteOnce, for AOF persistence) |

Used for human input relay (OTP/password values, 300s TTL), distributed locks, and session state caching.

### NATS JetStream

| Property | Production |
|---|---|
| Image | `nats:2.10.24-alpine` |
| CPU request | 500m |
| CPU limit | 1000m |
| Memory request | 512Mi |
| Memory limit | 1Gi |
| Ports | 4222 (client), 8222 (monitor) |
| PVC | **20Gi** SSD (ReadWriteOnce) |
| JetStream max memory | 512Mi |
| JetStream max storage | 20Gi |

`syncInterval: always` is **mandatory** — do not remove this setting. It ensures message durability in the event of a pod restart.

Enable NATS authentication (`nats.auth.enabled: true`) in production.

### MinIO

| Property | Production |
|---|---|
| Image | `minio/minio:RELEASE.2025-03-12T18-04-18Z` |
| CPU request | 500m |
| CPU limit | 1000m |
| Memory request | 512Mi |
| Memory limit | 1Gi |
| Ports | 9000 (API), 9001 (console) |
| PVC | **100Gi** SSD (ReadWriteOnce) |

Stores AES-256-GCM encrypted credential artifacts (screenshots, extracted tokens, VNC recordings). Volume grows with the number of service profiles and extraction frequency. Start at 100Gi and expand as needed.

---

## Total Permanent Pod Resources

The table below covers permanent services with the recommended production replica counts. Worker pods are additive on top of this.

| Service | CPU Request | CPU Limit | Memory Request | Memory Limit |
|---|---|---|---|---|
| API (×2 replicas) | 2000m | 4000m | 2Gi | 4Gi |
| Controller | 500m | 1000m | 512Mi | 1Gi |
| Admin UI (if enabled) | 250m | 500m | 256Mi | 512Mi |
| Slack/Teams Bot (if enabled) | 250m | 500m | 256Mi | 512Mi |
| Egress Proxy | 100m | 500m | 128Mi | 512Mi |
| Postgres | 1000m | 2000m | 1Gi | 2Gi |
| Redis | 500m | 1000m | 512Mi | 1Gi |
| NATS | 500m | 1000m | 512Mi | 1Gi |
| MinIO | 500m | 1000m | 512Mi | 1Gi |
| **Total (bots disabled)** | **~5100m (~5.1 vCPU)** | **~10500m (~10.5 vCPU)** | **~5.4 GiB** | **~10.5 GiB** |

Per additional concurrent worker pod, add: +550m CPU request / +1150m CPU limit / +1.1 GiB memory request / +1.6 GiB memory limit.

### Storage (PVCs)

| Service | Size | Type |
|---|---|---|
| Postgres | 50Gi | SSD |
| Redis | 5Gi | Standard |
| NATS | 20Gi | SSD |
| MinIO | 100Gi+ | SSD |
| **Total** | **175Gi+** | |

---

## Scaling

### API horizontal scaling

The API is stateless (no in-memory session state; all state is in Postgres/Redis). It is safe to run 2–3 replicas behind the ingress for availability and load distribution.

The chart does not include an HPA template. Scale the API manually via `api.replicas` in your values file. Start with 2 replicas; increase if p99 request latency rises under load.

```yaml
api:
  replicas: 3
```

### Controller

Run exactly **1 replica**. The controller owns the pod reconcile loop; multiple instances will conflict.

### Worker node pool

Workers are created on demand by the controller — no pre-provisioning is needed. Use cluster autoscaler on the worker node pool so nodes are added as active profiles increase and reclaimed when they decrease.

---

## Security Requirements

- **No privileged containers.** All containers drop all Linux capabilities. Workers run as non-root (`pwuser`). Compatible with `restricted` PodSecurityAdmission.
- **No GPU required.** Workers use CPU-only Chromium.
- **Controller RBAC:** Namespace-scoped `Role` + `RoleBinding` to manage pods, services, and NetworkPolicies dynamically. Cluster-scoped permissions are not required.
- **`TENANT_ENCRYPTION_KEY`** (64-char hex / 32 bytes, AES-256-GCM) must be present on both API **and** worker pods. If missing from the API pod, credential responses return empty values silently — no error is raised.
- **NetworkPolicies:** Disabled by default in the chart. Enable in production (`networkPolicies.enabled: true`) to restrict inter-service traffic.
- **NATS authentication:** Disabled by default. Enable (`nats.auth.enabled: true`) and set a strong token in production.
- **TLS at ingress:** Enable cert-manager and TLS termination at the ingress. Internal service-to-service traffic stays within the cluster network.
- **NATS `syncInterval: always`** is mandatory — removing it breaks message durability.
- **Ingress:** NGINX ingress controller by default. Production deployments using Istio should configure `virtualServices` in the chart values instead of the standard ingress.

---

## Operational Recommendations

- **Backup CronJob:** Disabled by default. Enable in production to run `pg_dump` to MinIO/S3 daily (chart default: 02:00 UTC, 30-day retention, 30-minute timeout).
- **PVC password changes:** Changing `postgresPassword` in values does **not** update the running Postgres instance. To change the DB password, delete the PVC and pod and allow Postgres to reinitialise. Plan this as a maintenance window.
- **MinIO growth:** Credential artifact volume grows with the number of service profiles and token extraction frequency. Set up storage utilisation alerts at 70% of the MinIO PVC.
- **Idle shutdown:** Set `config.idleShutdownSeconds` to a value greater than `config.defaultKeepaliveSeconds` (300s) to automatically reclaim worker pods that have been idle (no credential requests). Recommended for production: `1800` (30 minutes).
- **Two-host ingress (on-prem):** If deploying both the API and Admin UI, two separate hostnames are required — one for the API VirtualService (`tabby-api.*`) and one for the Admin UI (`tabby-admin.*`). A single shared hostname does not work with the chart's VirtualService rendering.
- **Swagger/OpenAPI docs:** Disable in production by setting `config.swaggerEnabled: false` to avoid exposing the API schema publicly.
