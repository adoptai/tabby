# Phase 9: Deployment + Compliance

## Status: COMPLETE

## Tasks

### Task 60: Helm Charts - COMPLETE
Created Helm umbrella chart at `charts/browser-hitl/` with 23 files:
- `Chart.yaml` - Chart metadata (apiVersion v2, type application)
- `values.yaml` - All configurable values with spec-compliant defaults
- `templates/_helpers.tpl` - Template helper functions (fullname, labels, image, storageClass)
- `templates/api-deployment.yaml` - API Deployment with health probes, resource limits, env from configmap/secret
- `templates/api-service.yaml` - API ClusterIP Service on port 8080
- `templates/controller-deployment.yaml` - Controller Deployment + ServiceAccount + RBAC (Role/RoleBinding for pod/secret/configmap/networkpolicy management)
- `templates/controller-service.yaml` - Controller ClusterIP Service on port 8090
- `templates/worker-template-configmap.yaml` - ConfigMap containing pod template for dynamic worker creation by controller (two containers: worker + noVNC sidecar, shared emptyDir volume)
- `templates/slack-bot-deployment.yaml` - Slack Bot Deployment (conditionally enabled)
- `templates/teams-bot-deployment.yaml` - Teams Bot Deployment (conditionally enabled)
- `templates/admin-ui-deployment.yaml` - Admin UI Deployment (conditionally enabled)
- `templates/admin-ui-service.yaml` - Admin UI ClusterIP Service on port 3000
- `templates/postgres-statefulset.yaml` - PostgreSQL StatefulSet with PVC (20Gi default)
- `templates/postgres-service.yaml` - PostgreSQL ClusterIP Service on port 5432
- `templates/redis-deployment.yaml` - Redis StatefulSet with PVC (5Gi default)
- `templates/redis-service.yaml` - Redis ClusterIP Service on port 6379
- `templates/nats-statefulset.yaml` - NATS StatefulSet with PVC (10Gi default) + NATS config ConfigMap
- `templates/nats-service.yaml` - NATS ClusterIP Service on port 4222 + monitor 8222
- `templates/minio-statefulset.yaml` - MinIO StatefulSet with PVC (50Gi default)
- `templates/minio-service.yaml` - MinIO ClusterIP Service on port 9000 + console 9001
- `templates/ingress.yaml` - NGINX Ingress with routes for /api, /events, /auth, /health, /, /api/messages
- `templates/configmap.yaml` - All env vars from spec section 15.4
- `templates/secrets.yaml` - All sensitive values (base64-encoded)

Resource baselines per spec section 15.7:
- Worker: request 1 vCPU/2GB, limit 2 vCPU/3GB
- Controller: request 0.5 vCPU/512MB
- API: request 0.5 vCPU/512MB
- Bots: request 0.25 vCPU/256MB

### Task 61: Stateful Service Defaults - COMPLETE
PVC definitions included in StatefulSet volumeClaimTemplates:
- PostgreSQL: 20Gi PVC, configurable storageClass
- Redis: 5Gi PVC, configurable storageClass
- NATS JetStream: 10Gi PVC, configurable storageClass, sync_interval: always (MANDATORY)
- MinIO: 50Gi PVC, configurable storageClass

All sizes, storage classes, and access modes are configurable via values.yaml.

### Task 62: SBOM Pipeline - COMPLETE
Created `infra/ci/sbom.sh`:
- Generates CycloneDX SBOM per Docker image using syft
- Signs SBOM with cosign (supports both key-based and keyless signing)
- Verifies signatures after signing
- Supports attaching SBOMs to OCI registry alongside images
- Three commands: generate, verify, attach
- Processes all 7 service images

### Task 63: CI/CD Pipeline - COMPLETE
Created `.github/workflows/ci.yml` with 6-stage pipeline:
1. **lint** - pnpm + NX lint across all packages
2. **test** - pnpm + NX test with PostgreSQL + Redis service containers
3. **build** - Docker image builds for all 7 services using matrix strategy
4. **sbom** - Syft CycloneDX generation + cosign keyless signing + registry attachment
5. **e2e** - k3d ephemeral cluster creation, Helm deployment, E2E test execution
6. **publish** - Tag + sign release images (main branch only)

## Decisions
- Used StatefulSets (not Deployments) for all stateful services (postgres, redis, nats, minio) for proper PVC management
- Worker pods are dynamically created by the controller using a pod template stored in a ConfigMap, not a static Deployment
- Controller gets its own ServiceAccount with RBAC for pod/secret/configmap/networkpolicy management
- NATS config uses a separate ConfigMap with sync_interval: always in nats.conf
- Slack/Teams bots are conditionally enabled via values.yaml flags
- E2E stage uses k3d (not kind) per spec requirement
- CI uses GitHub Actions concurrency groups to cancel stale runs
