# Tabby — Cluster Sizing & Capacity Planning

Guide for provisioning a Kubernetes cluster to run Tabby. Covers resource requirements, scaling math, and capacity planning for different concurrency levels.

For configuration and setup steps, see `tabby-setup-guide.md`.

---

## What Tabby Deploys

Tabby is a self-contained Helm chart. Version 1 bundles all infrastructure — no external managed services are required.

### Permanent services (always running)


| Service          | Pods | Purpose                                                          |
| ---------------- | ---- | ---------------------------------------------------------------- |
| **API**          | 1-2  | REST API, token exchange, credential resolution, WebSocket proxy |
| **Controller**   | 1-2  | Session lifecycle management, worker pod creation/destruction    |
| **PostgreSQL**   | 1    | Session state, users, applications, audit log                    |
| **Redis**        | 1    | Token cache, stream tokens, circuit breaker markers              |
| **NATS**         | 1    | HITL event bus (session state changes, notifications)            |
| **MinIO**        | 1    | Encrypted credential artifact storage                            |
| **Egress Proxy** | 1    | Outbound HTTP traffic control for worker pods                    |


### Dynamic services (created per user session)


| Service           | Pods          | Purpose                                        |
| ----------------- | ------------- | ---------------------------------------------- |
| **Worker**        | 1 per session | Chromium browser + Playwright automation       |
| **noVNC sidecar** | 1 per worker  | WebSocket-to-VNC relay (inside the worker pod) |


Each active user session = 1 worker pod. Pods are created on demand and destroyed after idle timeout or session end.

---

## Baseline Resource Consumption (No Active Sessions)

With zero user sessions, only the permanent services are running:


| Service            | CPU request   | Memory request | Storage  |
| ------------------ | ------------- | -------------- | -------- |
| API (×1)           | 500m          | 512Mi          | —        |
| Controller (×1)    | 500m          | 512Mi          | —        |
| PostgreSQL         | 500m          | 1Gi            | 20Gi PVC |
| Redis              | 250m          | 256Mi          | 5Gi PVC  |
| NATS               | 250m          | 256Mi          | 10Gi PVC |
| MinIO              | 250m          | 512Mi          | 50Gi PVC |
| Egress Proxy       | 100m          | 128Mi          | —        |
| **Total baseline** | **2.35 vCPU** | **3.2 Gi**     | **85Gi** |


With 2 replicas for API and Controller (production):


| **Total baseline (prod)** | **3.35 vCPU** | **4.2 Gi** | **85Gi** |
| ------------------------- | ------------- | ---------- | -------- |


---

## Per-Session Resource Consumption

Each concurrent user session adds one worker pod:


| Component             | CPU request  | Memory request |
| --------------------- | ------------ | -------------- |
| Worker (Chromium)     | 1000m        | 2Gi            |
| noVNC sidecar         | 100m         | 128Mi          |
| **Per session total** | **1.1 vCPU** | **~2.1 Gi**    |


### Why these numbers

- **Chromium in a container** uses 400-600 MB idle, peaks at 800 MB-1.2 GB during active page navigation (Salesforce Lightning, Workday). The 2Gi request covers typical usage; the 3Gi limit provides headroom for V8 garbage collection spikes.
- **CPU** is bursty: ~1 core during page load/JS execution, near-zero during HITL wait (user is logging in). Most of the session lifetime is spent waiting for human input with minimal CPU usage.
- The `--disable-dev-shm-usage` Chromium flag is enabled by default, avoiding the Docker `/dev/shm` 64MB limit.

---

## Capacity Planning Table


| Concurrent sessions | Worker CPU | Worker memory | + Baseline           | Total cluster needed     |
| ------------------- | ---------- | ------------- | -------------------- | ------------------------ |
| 5                   | 5.5 vCPU   | 10.5 Gi       | + 3.35 vCPU / 4.2 Gi | **~9 vCPU / ~15 Gi**     |
| 10                  | 11 vCPU    | 21 Gi         | + 3.35 vCPU / 4.2 Gi | **~15 vCPU / ~25 Gi**    |
| 25                  | 27.5 vCPU  | 52.5 Gi       | + 3.35 vCPU / 4.2 Gi | **~31 vCPU / ~57 Gi**    |
| 50                  | 55 vCPU    | 105 Gi        | + 3.35 vCPU / 4.2 Gi | **~58 vCPU / ~109 Gi**   |
| 100                 | 110 vCPU   | 210 Gi        | + 3.35 vCPU / 4.2 Gi | **~113 vCPU / ~214 Gi**  |
| 200                 | 220 vCPU   | 420 Gi        | + 3.35 vCPU / 4.2 Gi | **~223 vCPU / ~424 Gi**  |
| 500                 | 550 vCPU   | 1050 Gi       | + 3.35 vCPU / 4.2 Gi | **~553 vCPU / ~1054 Gi** |


> **Important:** "Concurrent sessions" means simultaneously running Chromium instances, not registered users. Most users do not maintain active sessions continuously — sessions are idle-shutdown after a configurable period (default 30 min). Typical usage: a user triggers an action → session starts → HITL resolves → credentials extracted → session remains warm for subsequent requests → eventually idle-shutdown.

### Quick sizing formula

```
Cluster CPU  = 3.35 + (concurrent_sessions × 1.1)  vCPU
Cluster RAM  = 4.2  + (concurrent_sessions × 2.1)  Gi
Cluster Disk = 85 Gi (fixed, independent of session count)
```

Add ~20% headroom for scheduling overhead and node-level resources (kubelet, kube-proxy, etc.).

---

## Recommended Cluster Sizes

### Testing / Proof of Concept (≤10 sessions)


| Resource  | Value                           |
| --------- | ------------------------------- |
| Nodes     | 2-3 nodes                       |
| Node size | 4 vCPU / 16 Gi each             |
| Total     | 8-12 vCPU / 32-48 Gi            |
| Storage   | 100Gi SSD (single StorageClass) |


Suitable for initial deployment validation, template testing, and up to 10 concurrent user sessions.

### Production — Small (≤50 sessions)


| Resource  | Value                   |
| --------- | ----------------------- |
| Nodes     | 4-6 nodes               |
| Node size | 8 vCPU / 32 Gi each     |
| Total     | 32-48 vCPU / 128-192 Gi |
| Storage   | 200Gi SSD               |


Sufficient for moderate production usage with up to 50 concurrent sessions.

### Production — Medium (≤200 sessions)


| Resource  | Value                     |
| --------- | ------------------------- |
| Nodes     | 10-15 nodes               |
| Node size | 16 vCPU / 64 Gi each      |
| Total     | 160-240 vCPU / 640-960 Gi |
| Storage   | 200Gi SSD                 |


For high-concurrency deployments. Consider using a node auto-scaler (Karpenter, Cluster Autoscaler) at this scale.

### Production — Large (≤500 sessions)


| Resource  | Value                 |
| --------- | --------------------- |
| Nodes     | Auto-scaled node pool |
| Node size | 16 vCPU / 64 Gi each  |
| Min nodes | 10                    |
| Max nodes | 40                    |
| Storage   | 500Gi SSD             |


At this scale, a node auto-scaler is strongly recommended. Worker pods come and go — fixed-size node pools lead to either wasted capacity or scheduling failures.

---

## Network Requirements

**The Tabby API must have a public DNS entry and external ingress.** The platform sends token exchange and credential requests to the API, and end-user browsers connect to it for VNC/CDP WebSocket streaming. Without a publicly reachable URL (e.g., `https://tabby-api.customer.com`), Tabby cannot function. The ingress must support WebSocket upgrades with long timeouts (3600s recommended).


| Direction             | Target                                       | Purpose                                                     | Required?                            |
| --------------------- | -------------------------------------------- | ----------------------------------------------------------- | ------------------------------------ |
| **Outbound HTTPS**    | IdP (e.g., `auth.adopt.ai`)                  | JWKS key fetch for JWT validation                           | Yes                                  |
| **Outbound HTTPS**    | Target SaaS sites (e.g., `*.salesforce.com`) | Worker browsers navigate to these for credential extraction | Yes                                  |
| **Inbound HTTPS**     | Platform backend                             | Token exchange, credential requests                         | Yes                                  |
| **Inbound HTTPS/WSS** | End-user browsers                            | VNC/CDP viewer WebSocket connections                        | Yes (if using Tabby's direct viewer) |
| **Internal**          | Inter-pod communication                      | All Tabby services communicate within the namespace         | Automatic (K8s DNS)                  |


The egress proxy controls outbound traffic from worker pods. Target domains must be added to the allowlist in the Helm values.

---

## Storage


| PVC        | Default size | Purpose                        | Growth pattern                                              |
| ---------- | ------------ | ------------------------------ | ----------------------------------------------------------- |
| PostgreSQL | 20Gi         | Session state, audit log       | Slow — audit events auto-purge after 90 days                |
| Redis      | 5Gi          | Ephemeral cache                | Stable — all keys have TTLs                                 |
| NATS       | 10Gi         | JetStream message store        | Stable — max age 8h, auto-purge                             |
| MinIO      | 50Gi         | Encrypted credential artifacts | Moderate — artifacts auto-purge after 7 days (configurable) |


Storage requirements are **independent of concurrent session count**. The PVCs hold persistent data for the permanent services. Worker pods use ephemeral storage only (no PVC).

All PVCs require `ReadWriteOnce` SSD-backed volumes. The default StorageClass is used unless overridden via `global.storageClass` or per-service `persistence.storageClass`.

---

## Infrastructure Note

Version 1 of the Tabby chart bundles all infrastructure dependencies (PostgreSQL, Redis, NATS, MinIO) as embedded StatefulSets. No external managed services are required.

This simplifies initial deployment — the chart is fully self-contained. Support for external managed services (AWS RDS, ElastiCache, Amazon S3, etc.) is available through configuration but not the primary deployment path for version 1.

---

## What Affects Startup Time

When a user triggers their first action, Tabby creates a worker pod. The time from request to "session ready" depends on:


| Factor                          | Typical time | Controlled by                        |
| ------------------------------- | ------------ | ------------------------------------ |
| K8s scheduling                  | 2-10s        | Cluster capacity, node availability  |
| Image pull (first time on node) | 10-60s       | Registry speed, image size (~1.5 GB) |
| Image pull (cached)             | 0s           | Docker image cache on node           |
| Chromium launch                 | 2-5s         | Worker resources                     |
| Login DSL execution             | 5-15s        | Target site speed                    |
| **Total (cold start)**          | **20-90s**   | —                                    |
| **Total (warm, image cached)**  | **10-30s**   | —                                    |


### How to minimize startup time

- **Pre-pull images:** Use a DaemonSet or Karpenter's `EC2NodeClass.amiPolicy` to ensure worker images are cached on all nodes before users need them.
- **Node headroom:** Keep 1-2 spare nodes warm so the scheduler doesn't wait for a new node to provision.
- **Idle shutdown tuning:** Increase `IDLE_SHUTDOWN_SECONDS` (default 1800) to keep sessions alive longer, reducing re-starts.

### Subsequent requests

Once a session is running, credential requests resolve instantly (no pod creation needed). The session stays warm until the idle timeout. Users making multiple requests in sequence experience sub-second response times after the initial session warmup.

---

## Monitoring Recommendations


| Metric                                     | What to watch                   | Action if concerning                           |
| ------------------------------------------ | ------------------------------- | ---------------------------------------------- |
| `kube_pod_status_phase{phase="Pending"}`   | Worker pods stuck in Pending    | Cluster needs more nodes or resources          |
| `container_memory_working_set_bytes`       | Worker memory approaching limit | Increase worker memory limit                   |
| `container_cpu_throttled_seconds_total`    | CPU throttling on workers       | Increase worker CPU limit                      |
| `kube_pod_container_status_restarts_total` | Frequent restarts (OOMKill)     | Increase memory limits, check for memory leaks |
| `pg_stat_activity` count                   | DB connection saturation        | Increase `DB_POOL_SIZE`                        |
| NATS reconnect logs                        | Frequent NATS disconnects       | Check NATS pod health, network policies        |


---

## Quick Reference

```
Baseline (no sessions):     ~3.5 vCPU / ~4 Gi RAM / 85 Gi disk
Per concurrent session:     +1.1 vCPU / +2.1 Gi RAM
Add 20% headroom for scheduling overhead.

Example: 50 concurrent sessions
  = 3.5 + (50 × 1.1) = 58.5 vCPU
  = 4 + (50 × 2.1)   = 109 Gi RAM
  + 20% headroom      ≈ 70 vCPU / 131 Gi RAM
  → 5 nodes × 16 vCPU / 32 Gi each
```

