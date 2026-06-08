# Helm Chart Validation — adopt-tabby

Run all commands from the `helm-charts` repository root.

---

## Prerequisites

```bash
# Ensure you have the test values file
ls test-values-validation.yaml
```

---

## 1. Lint

```bash
helm lint charts/adoptapp/charts/adopt-tabby/
helm lint charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml
```

Expected: `0 chart(s) failed` for both.

---

## 2. Secrets — required fields

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/secrets.yaml | grep "JWT_SIGNING\|TENANT_ENCRYPTION\|AGENT_SECRET\|ADMIN_BOOTSTRAP\|SERVICE_AUTH_CLIENT_SECRET\|POSTGRES_PASSWORD\|MINIO_ACCESS\|MINIO_SECRET"
```

Expected: all 10 required secrets present with test values.

---

## 3. Secrets — IDP client credentials

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/secrets.yaml | grep "IDP_CLIENT"
```

Expected: `IDP_CLIENT_ID: "test-idp-client-id"` and `IDP_CLIENT_SECRET: "test-idp-client-secret"`.

---

## 4. Secrets — new config vars (scaling, circuit breaker, retention, pool)

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/secrets.yaml | grep "RECONCILE_BATCH\|DB_POOL\|CIRCUIT_BREAKER\|LIFECYCLE_"
```

Expected: `RECONCILE_BATCH_SIZE: "100"`, `DB_POOL_SIZE: "30"`, all 4 circuit breaker values, all 4 lifecycle values.

---

## 5. Secrets — empty IDP when not provided

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ \
  --set secrets.jwtSigningKey=test --set secrets.tenantEncryptionKey=test \
  --set secrets.agentHmacKey=test --set secrets.adminBootstrapPassword=test \
  --set secrets.serviceAuthClientSecret=test --set secrets.postgresPassword=test \
  --set secrets.minioAccessKey=test --set secrets.minioSecretKey=test \
  --set config.publicBaseUrl=https://test.com \
  -s templates/secrets.yaml | grep "IDP_CLIENT"
```

Expected: `IDP_CLIENT_ID: ""` and `IDP_CLIENT_SECRET: ""` (empty but present, no error).

---

## 6. existingSecret — Secret template skipped

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ \
  --set secrets.existingSecret=my-external-secret \
  --set config.publicBaseUrl=https://test.com \
  -s templates/secrets.yaml 2>&1
```

Expected: `Error: could not find template templates/secrets.yaml in chart` (template skipped entirely).

---

## 7. existingSecret — deployment uses external secret name

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ \
  --set secrets.existingSecret=my-external-secret \
  --set config.publicBaseUrl=https://test.com \
  -s templates/api-deployment.yaml | grep "external-secret"
```

Expected: `name: my-external-secret`.

---

## 8. API — custom resources

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/api-deployment.yaml | grep -A5 "resources:"
```

Expected: `cpu: 1000m` request, `memory: 1Gi` request, `cpu: 2000m` limit, `memory: 2Gi` limit (from test values).

---

## 9. API — replicas

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/api-deployment.yaml | grep "replicas:"
```

Expected: `replicas: 2`.

---

## 10. API — nodeSelector

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/api-deployment.yaml | grep "workload-type"
```

Expected: `workload-type: tabby-api`.

---

## 11. Controller — resources and replicas

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/controller-deployment.yaml | grep -E "replicas:|cpu:|memory:" | head -6
```

Expected: `replicas: 2`, `cpu: 500m` request, `memory: 512Mi` request, `cpu: 1000m` limit, `memory: 1Gi` limit.

---

## 12. PostgreSQL — resources

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/postgresql-statefulset.yaml | grep -E "cpu:|memory:" | head -4
```

Expected: `cpu: 1000m` request, `memory: 1Gi` request, `cpu: 2000m` limit, `memory: 2Gi` limit.

---

## 13. Redis — resources

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/redis-statefulset.yaml | grep -E "cpu:|memory:" | head -4
```

Expected: `cpu: 500m` request, `memory: 512Mi` request, `cpu: 1000m` limit, `memory: 1Gi` limit.

---

## 14. NATS — resources

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/nats-statefulset.yaml | grep -E "cpu:|memory:" | head -4
```

Expected: same as Redis.

---

## 15. MinIO — resources

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/minio-statefulset.yaml | grep -E "cpu:|memory:" | head -4
```

Expected: same as Redis.

---

## 16. Egress proxy — resources

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/egress-proxy-deployment.yaml | grep -E "cpu:|memory:" | head -4
```

Expected: `cpu: 200m` request, `memory: 256Mi` request, `cpu: 1000m` limit, `memory: 1Gi` limit.

---

## 17. Ingress — host and TLS

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/ingress.yaml | grep -E "host:|secretName:|path:|pathType:"
```

Expected: `host: "tabby-api.test.com"`, `secretName: tabby-api-tls`, `path: /`, `pathType: Prefix`.

---

## 18. HPA — disabled by default

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  -s templates/hpa.yaml 2>&1
```

Expected: `Error: could not find template` (HPA not rendered when `autoscaling.enabled: false`).

---

## 19. HPA — enabled

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ -f test-values-validation.yaml \
  --set api.autoscaling.enabled=true \
  --set controller.autoscaling.enabled=true \
  -s templates/hpa.yaml | grep -E "kind:|name:|maxReplicas:|averageUtilization:"
```

Expected: two `HorizontalPodAutoscaler` resources (API and controller), with `maxReplicas: 4` / `maxReplicas: 3` and `averageUtilization: 70` / `80`.

---

## 20. Default values only (no test file) — verify safe defaults

```bash
helm template test charts/adoptapp/charts/adopt-tabby/ \
  --set secrets.jwtSigningKey=test --set secrets.tenantEncryptionKey=test \
  --set secrets.agentHmacKey=test --set secrets.adminBootstrapPassword=test \
  --set secrets.serviceAuthClientSecret=test --set secrets.postgresPassword=test \
  --set secrets.minioAccessKey=test --set secrets.minioSecretKey=test \
  --set config.publicBaseUrl=https://test.com \
  -s templates/secrets.yaml | grep "RECONCILE_BATCH\|DB_POOL\|CIRCUIT_BREAKER_TENANT"
```

Expected: `RECONCILE_BATCH_SIZE: "50"`, `DB_POOL_SIZE: "20"`, `CIRCUIT_BREAKER_TENANT_FAILURE_THRESHOLD: "50"` (chart defaults).

---

## Live Cluster Validation

After deploying to a cluster, verify the pods received the correct values.

Replace `<NAMESPACE>` with the actual namespace (e.g., `browser-hitl`, `tabby`, etc.).

### Verify env vars on API pod

```bash
kubectl exec -n <NAMESPACE> $(kubectl get pods -n <NAMESPACE> -l app.kubernetes.io/component=api -o name | head -1) -- env | grep -E "DB_POOL|RECONCILE_BATCH|CIRCUIT_BREAKER|IDP_CLIENT|PUBLIC_BASE_URL"
```

### Verify env vars on controller pod

```bash
kubectl exec -n <NAMESPACE> $(kubectl get pods -n <NAMESPACE> -l app.kubernetes.io/component=controller -o name | head -1) -- env | grep -E "DB_POOL|RECONCILE_BATCH|CIRCUIT_BREAKER"
```

### Verify DB connection pool is active

```bash
kubectl exec -n <NAMESPACE> $(kubectl get pods -n <NAMESPACE> -l app.kubernetes.io/component=postgres -o name | head -1) -- psql -U browser_hitl -d browser_hitl -c "SELECT count(*) as active_connections FROM pg_stat_activity WHERE datname = 'browser_hitl'"
```

### Verify resource limits applied

```bash
kubectl describe deployment -n <NAMESPACE> -l app.kubernetes.io/component=api | grep -A6 "Limits:\|Requests:"
kubectl describe deployment -n <NAMESPACE> -l app.kubernetes.io/component=controller | grep -A6 "Limits:\|Requests:"
```

### Verify HPA (if enabled)

```bash
kubectl get hpa -n <NAMESPACE>
```

### Verify ingress

```bash
kubectl get ingress -n <NAMESPACE>
```

### Verify secrets exist

```bash
kubectl get secret -n <NAMESPACE> | grep tabby
```

### Verify all pods are running

```bash
kubectl get pods -n <NAMESPACE> -l app.kubernetes.io/instance=<RELEASE_NAME>
```
