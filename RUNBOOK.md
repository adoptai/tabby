# Browser HITL Runbook

Operator guide for deploying, running, and troubleshooting Browser HITL.

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 20+ | Runtime |
| pnpm | 10+ | Package manager |
| Docker | 24+ | Local infrastructure |
| kubectl | 1.28+ | Kubernetes CLI |
| helm | 3.14+ | Chart deployment |
| kind | 0.22+ | Local K8s cluster (optional) |
| jq | 1.7+ | JSON processing (scripts) |

## 1. Local Development Setup

### 1.1 Infrastructure

```bash
# Start PostgreSQL, Redis, NATS (JetStream), MinIO
docker compose up -d

# Verify all services are healthy
docker compose ps
```

Services exposed:
- PostgreSQL: `localhost:5432` (user: `browser_hitl`, password: `localdev`, db: `browser_hitl`)
- Redis: `localhost:6379`
- NATS: `localhost:4222` (monitoring: `localhost:8222`)
- MinIO: `localhost:9000` (console: `localhost:9001`, user: `minioadmin`)

### 1.2 Environment

```bash
cp .env.example .env.local
```

Required variables for local dev:
```
DATABASE_URL=postgresql://browser_hitl:localdev@localhost:5432/browser_hitl
REDIS_URL=redis://localhost:6379
NATS_URL=nats://localhost:4222
JWT_SIGNING_KEY=localdev-jwt-key-at-least-32-characters-long
JWT_SIGNING_KEY_ID=key-1
```

### 1.3 Build and Run

```bash
pnpm install
pnpm nx run-many --target=build --all --parallel=3
pnpm --filter @browser-hitl/api start:dev
```

API available at `http://localhost:8080`. Swagger docs at `http://localhost:8080/api/docs`.

### 1.4 Run Tests

```bash
# Full suite (385 tests)
pnpm nx run-many --target=test --all --parallel=3

# Single package
pnpm --filter @browser-hitl/api test

# Specific test
cd apps/api && npx jest account-lockout
```

## 2. Kubernetes Deployment

### 2.1 Build Docker Images

```bash
SERVICES=(api controller worker novnc slack-bot teams-bot admin-ui)
for svc in "${SERVICES[@]}"; do
  docker build -f infra/docker/Dockerfile.${svc} -t browser-hitl/${svc}:latest .
done
```

### 2.2 Local Cluster (Kind)

```bash
# Create cluster
kind create cluster --name browser-hitl

# Load images
for svc in "${SERVICES[@]}"; do
  kind load docker-image browser-hitl/${svc}:latest --name browser-hitl
done

# Deploy
helm upgrade --install browser-hitl charts/browser-hitl \
  -f charts/browser-hitl/values-local.yaml \
  --namespace browser-hitl --create-namespace

# Verify
kubectl -n browser-hitl get pods
kubectl -n browser-hitl wait --for=condition=ready pod --all --timeout=300s
```

### 2.3 Production Deployment

```bash
helm upgrade --install browser-hitl charts/browser-hitl \
  -f charts/browser-hitl/values-production.yaml \
  --namespace browser-hitl --create-namespace \
  --set secrets.postgresPassword="$(openssl rand -base64 32)" \
  --set secrets.jwtSigningKey="$(openssl rand -base64 48)" \
  --set secrets.natsAuthToken="$(openssl rand -hex 32)" \
  --set secrets.metricsAuthToken="$(openssl rand -hex 32)" \
  --set secrets.tenantEncryptionKey="$(openssl rand -hex 32)" \
  --set secrets.minioAccessKey="$(openssl rand -base64 16)" \
  --set secrets.minioSecretKey="$(openssl rand -base64 32)" \
  --set secrets.adminBootstrapPassword="$(openssl rand -base64 24)" \
  --set ingress.host=browser-hitl.example.com
```

Production enables: TLS (cert-manager), NATS auth, network policies, alerting, daily backups, HA replicas.

### 2.4 Port Forwarding (Local Access)

```bash
kubectl -n browser-hitl port-forward svc/browser-hitl-api 8080:8080 &
kubectl -n browser-hitl port-forward svc/browser-hitl-nats 4222:4222 &
```

## 3. Health Checks

### 3.1 API Health

```bash
# Liveness (always 200 if process is running)
curl -s http://localhost:8080/health/live | jq

# Readiness (checks database connectivity)
curl -s http://localhost:8080/health/ready | jq
```

### 3.2 Prometheus Metrics

```bash
# Without auth (local dev)
curl -s http://localhost:8080/metrics

# With auth (production)
curl -s -H "Authorization: Bearer $METRICS_AUTH_TOKEN" http://localhost:8080/metrics
```

Metrics include Node.js runtime (GC, event loop, memory) and application counters/histograms (session lifecycle, HITL latency, OTP submissions).

### 3.3 NATS JetStream

```bash
# Stream info
nats stream info HITL_EVENTS --server=nats://localhost:4222
nats stream info SESSION_EVENTS --server=nats://localhost:4222

# Consumer status
nats consumer ls HITL_EVENTS --server=nats://localhost:4222
```

## 4. Operational Tasks

### 4.1 Bootstrap First Tenant

On first startup, the API auto-creates a bootstrap tenant and admin user from environment variables:
- `ADMIN_BOOTSTRAP_EMAIL` (default: `admin@browser-hitl.local`)
- `ADMIN_BOOTSTRAP_PASSWORD` (from secrets)

### 4.2 Create Additional Users

```bash
TOKEN=$(curl -s http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@browser-hitl.local","password":"YOUR_PASSWORD"}' | jq -r .token)

curl -s http://localhost:8080/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"operator@example.com","password":"SecureP@ssw0rd!","role":"Operator","tenant_id":"TENANT_UUID"}'
```

Password requirements: 12+ characters, uppercase, lowercase, digit, special character.

### 4.3 Application Management

```bash
# Create application
curl -s http://localhost:8080/apps \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Example App",
    "target_urls": ["https://example.com/login"],
    "login_config": { "login_url": "https://example.com/login", "steps": [] },
    "keepalive_config": { "interval_seconds": 300, "actions": [], "health_checks": [], "policy": "all" },
    "export_policy": { "artifact_types": ["cookies"], "encryption": { "algo": "AES-256-GCM", "key_ref": "k8s:secret/tenant-key" }, "ttl_seconds": 3600 },
    "notification_config": { "channels": ["slack:C12345"] }
  }'

# Scale sessions
curl -s http://localhost:8080/sessions/scale \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"app_id": "APP_UUID", "desired_sessions": 2}'
```

### 4.4 Generate Encryption Key

```bash
openssl rand -hex 32
# Output: 64-char hex string for AES-256-GCM
```

### 4.5 Slack Bot Setup

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_SIGNING_SECRET="..."
export SLACK_APP_TOKEN="xapp-..."
export API_BASE_URL="http://localhost:8080"
export SERVICE_AUTH_CLIENT_ID="slack-bot"
export SERVICE_AUTH_CLIENT_SECRET="..."

pnpm --filter @browser-hitl/slack-bot start
```

## 5. Troubleshooting

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| API won't start | Missing env vars | Check `validateEnv()` output — it reports ALL missing vars at once |
| 401 on all requests | JWT key mismatch | Ensure `JWT_SIGNING_KEY` matches across API and bots |
| Account locked | 5 failed logins | Wait 15 minutes or reset `failed_login_count` and `locked_until` in DB |
| OTP not delivered | Redis down | Check Redis connectivity, OTP stored at `otp:{sessionId}` with 60s TTL |
| Metrics returns 401 | Token mismatch | Check `METRICS_AUTH_TOKEN` env var matches Bearer header |
| Pods not starting | Image not loaded | `kind load docker-image` or check `imagePullPolicy` |
| NATS auth failure | Token mismatch | Check `secrets.natsAuthToken` in Helm values |
| Health/ready fails | DB unreachable | Check PostgreSQL connectivity, `DATABASE_URL` env var |

### Log Analysis

```bash
# API logs (structured JSON in production)
kubectl -n browser-hitl logs -l app.kubernetes.io/component=api --tail=100

# Controller logs
kubectl -n browser-hitl logs -l app.kubernetes.io/component=controller --tail=100

# Worker pod logs
kubectl -n browser-hitl logs POD_NAME --all-containers --tail=100
```

### Database Recovery

```bash
# Connect to PostgreSQL
kubectl -n browser-hitl exec -it statefulset/browser-hitl-postgres -- psql -U browser_hitl

# Check session states
SELECT state, count(*) FROM sessions GROUP BY state;

# Unlock a user
UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = 'user@example.com';

# Check audit chain integrity
SELECT id, prev_hash IS NOT NULL as has_chain FROM audit_events ORDER BY id DESC LIMIT 10;
```

### Graceful Shutdown

Both API and Controller implement graceful shutdown:
- Listen for SIGTERM/SIGINT
- Configurable timeout via `SHUTDOWN_TIMEOUT_MS` (default: 10s)
- Force exit on timeout

## 6. Teardown

```bash
# Local infrastructure
docker compose down        # Stop containers (keep data)
docker compose down -v     # Stop and wipe volumes

# Kind cluster
kind delete cluster --name browser-hitl

# Helm release
helm uninstall browser-hitl -n browser-hitl
kubectl delete namespace browser-hitl
```
