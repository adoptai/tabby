# Internal Deployment Runbook — Tabby On-Prem

Internal-only. Written so another Adopt engineer can deploy Tabby to a customer on-prem environment.

---

## Repositories

| Repo | What it does | Branch |
|---|---|---|
| `helm-charts` | The Helm chart customers install. Subchart at `charts/adoptapp/charts/adopt-tabby/` | `dev` |
| `tabby` | Source code. CI builds Docker images → pushes to GHCR | `dev` (staging), `main` (prod) |

**The customer never touches the `tabby` repo.** They install the chart from `helm-charts` and pass a values file.

---

## How On-Prem Deploy Works

1. Adopt publishes the chart to `oci://ghcr.io/adoptai/charts/browser-hitl` (via CI on the `tabby` repo)
2. The `helm-charts` repo contains the subchart that the customer actually installs as part of the `adoptapp` umbrella chart
3. Customer runs `helm install` (or `helm upgrade`) with their own values file providing secrets, config, ingress, DNS
4. All runtime config reaches pods via a single K8s Secret mounted as `envFrom`

**Two secret paths:**
- **Chart-managed (default):** customer fills `secrets.*` and `config.*` in values → Helm creates the Secret
- **Pre-existing secret:** customer sets `secrets.existingSecret: "my-secret"` → Helm skips Secret creation, pods use the external Secret

---

## Pre-Deploy Checklist

### Helm Chart PRs (must be merged first)

- [ ] PR #174 — IDP client credentials fix (moves to secrets.yaml)
- [ ] PR #176 — Missing config vars (circuit breaker, retention, DB pool, etc.)

### Customer Values File

The customer must provide a values file with at minimum:

```yaml
# Required secrets
secrets:
  jwtSigningKey: "<openssl rand -base64 48>"
  tenantEncryptionKey: "<openssl rand -hex 32>"
  agentHmacKey: "<openssl rand -base64 32>"
  adminBootstrapPassword: "<strong password>"
  serviceAuthClientSecret: "<openssl rand -base64 32>"
  postgresPassword: "<openssl rand -base64 24>"
  minioAccessKey: "<openssl rand -base64 16>"
  minioSecretKey: "<openssl rand -base64 32>"
  # IDP creds — provided by Adopt after registering callback in Frontegg
  idpClientId: ""
  idpClientSecret: ""

# Required config
config:
  publicBaseUrl: "https://tabby-api.customer.com"

# Image tags (must match the Tabby release)
images:
  api:
    tag: "prod-abc1234"
  controller:
    tag: "prod-abc1234"
  worker:
    tag: "prod-abc1234"
  novnc:
    tag: "prod-abc1234"

# Ingress
ingress:
  enabled: true
  ingressClassName: nginx
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

### Platform Side (done by customer or Adopt)

- [ ] `tabby` feature flag enabled for the org
- [ ] Playground Profile configured with Tabby URL and IDP ID
- [ ] Token Manager entries created (TABBY storage type)
- [ ] Deployment rules: `use_tabby = true` for relevant actions
- [ ] App templates created in Tabby (Salesforce, Workday, etc.)

---

## Validation Commands

### Lint the chart

```bash
cd helm-charts
helm lint charts/adoptapp/charts/adopt-tabby/
```

### Render with test values (verify Secret content)

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ \
  --set secrets.jwtSigningKey=test \
  --set secrets.tenantEncryptionKey=test \
  --set secrets.agentHmacKey=test \
  --set secrets.adminBootstrapPassword=test \
  --set secrets.serviceAuthClientSecret=test \
  --set secrets.postgresPassword=test \
  --set secrets.minioAccessKey=test \
  --set secrets.minioSecretKey=test \
  --set config.publicBaseUrl=https://test.com \
  --set secrets.idpClientId=test-id \
  --set secrets.idpClientSecret=test-secret \
  -s templates/secrets.yaml | grep "IDP_CLIENT\|RECONCILE_BATCH\|DB_POOL\|CIRCUIT_BREAKER"
```

Expected: all vars present with values.

### Verify existingSecret path

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ \
  --set secrets.existingSecret=my-external-secret \
  --set config.publicBaseUrl=https://test.com \
  -s templates/api-deployment.yaml | grep "secretRef\|my-external-secret"
```

Expected: `name: my-external-secret` in the output.

### Verify resource defaults in deployment

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ \
  --set secrets.jwtSigningKey=test \
  --set secrets.tenantEncryptionKey=test \
  --set secrets.agentHmacKey=test \
  --set secrets.adminBootstrapPassword=test \
  --set secrets.serviceAuthClientSecret=test \
  --set secrets.postgresPassword=test \
  --set secrets.minioAccessKey=test \
  --set secrets.minioSecretKey=test \
  --set config.publicBaseUrl=https://test.com \
  -s templates/api-deployment.yaml | grep -A4 "resources:"
```

### Verify custom resources are applied

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ \
  --set secrets.jwtSigningKey=test \
  --set secrets.tenantEncryptionKey=test \
  --set secrets.agentHmacKey=test \
  --set secrets.adminBootstrapPassword=test \
  --set secrets.serviceAuthClientSecret=test \
  --set secrets.postgresPassword=test \
  --set secrets.minioAccessKey=test \
  --set secrets.minioSecretKey=test \
  --set config.publicBaseUrl=https://test.com \
  --set api.resources.requests.cpu=2000m \
  --set api.resources.requests.memory=2Gi \
  -s templates/api-deployment.yaml | grep -A4 "resources:"
```

Expected: `cpu: "2000m"` and `memory: "2Gi"`.

### Verify nodeSelector/tolerations/affinity are configurable

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ \
  --set secrets.jwtSigningKey=test \
  --set secrets.tenantEncryptionKey=test \
  --set secrets.agentHmacKey=test \
  --set secrets.adminBootstrapPassword=test \
  --set secrets.serviceAuthClientSecret=test \
  --set secrets.postgresPassword=test \
  --set secrets.minioAccessKey=test \
  --set secrets.minioSecretKey=test \
  --set config.publicBaseUrl=https://test.com \
  --set 'api.nodeSelector.disktype=ssd' \
  -s templates/api-deployment.yaml | grep "disktype"
```

Expected: `disktype: ssd` under nodeSelector.

---

## Troubleshooting

### Pod not scheduling

```bash
kubectl describe pod <pod-name> -n <namespace>
# Events section: Insufficient memory, Insufficient cpu, node selector mismatch
```

Fix: increase node pool, adjust resource requests, or check nodeSelector.

### VNC link not appearing

```bash
curl -s https://TABBY_URL/sessions/<id> -H "Authorization: Bearer $TOKEN" | jq .state
```

- `STARTING` → pod still scheduling, wait
- `FAILED` → check worker pod logs
- `LOGIN_NEEDED` / `LOGIN_IN_PROGRESS` → normal, waiting for HITL

### Credentials returning empty

```bash
kubectl exec <api-pod> -- env | grep TENANT_ENCRYPTION
kubectl exec <worker-pod> -- env | grep TENANT_ENCRYPTION
# Must be identical
```

### NATS connection issues

```bash
kubectl logs <api-pod> | grep "NATS"
# "NATS status: reconnecting" → transient, will recover
# "NATS permanently closed" → pod exits and restarts automatically
```

### Circuit breaker paused

```bash
kubectl exec <api-pod> -- psql $DATABASE_URL -c "SELECT * FROM circuit_breaker_state WHERE pause_until > now()"
```

If rows exist, reconciliation is paused for those apps/tenants. Wait for cooldown or delete the rows to force resume.

---

## Resource Defaults

| Component | CPU request | CPU limit | Mem request | Mem limit |
|---|---|---|---|---|
| API | 500m | 1000m | 512Mi | 1Gi |
| Controller | 500m | 1000m | 512Mi | 1Gi |
| Worker (Chromium) | 1000m | 2000m | 2Gi | 3Gi |
| noVNC sidecar | 100m | 250m | 128Mi | 256Mi |
| PostgreSQL | 500m | 1000m | 512Mi | 1Gi |
| Redis | 250m | 500m | 256Mi | 512Mi |
| NATS | 250m | 500m | 256Mi | 512Mi |
| MinIO | 250m | 500m | 256Mi | 512Mi |

All configurable via `<component>.resources.requests.cpu`, etc. in values.

### Capacity math

Each concurrent Tabby session = 1 worker pod (~1 CPU + 2 Gi memory).
Infrastructure overhead: ~2-3 Gi (API + Controller + Redis + NATS + Postgres + MinIO).

| Concurrent sessions | Worker memory | Total cluster memory needed |
|---|---|---|
| 5 | ~10 Gi | ~13 Gi |
| 10 | ~20 Gi | ~23 Gi |
| 50 | ~100 Gi | ~103 Gi |
| 100 | ~200 Gi | ~203 Gi |

---

## Known Risks

1. **Worker scheduling not propagated:** `worker.nodeSelector/tolerations/affinity` in Helm values are defined but NOT passed to dynamically spawned worker pods. The controller creates pods using its own namespace defaults. This is a known gap.
2. **Karpenter affinity in deploy.yaml:** The TrueFoundry deploy template has Karpenter-specific `nodeAffinity` for controller/postgres/redis/nats. On-prem customers without Karpenter should override these in their values file (`controller.affinity: {}`).
3. **Default inconsistency:** `MAX_SESSION_AGE_HOURS` defaults to "8" in helm-charts values.yaml but "24" in the Tabby code. The helm-charts value wins at runtime. Same for `IDLE_SHUTDOWN_SECONDS` (1800 in chart vs 3600 in code).
4. **External infra gaps:** When `redis.enabled=false`, `REDIS_URL` is not injected via inline env vars in the deployment. Customer must provide it via `env[]` or `envFrom[]`. Same for NATS and MinIO.
