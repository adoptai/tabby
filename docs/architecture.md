# Tabby (Browser HITL) — Architecture Reference

**Version:** 1.3.6  
**Audience:** Enterprise infosec review, infrastructure teams, security auditors  
**Last updated:** 2026-05-05

> **Note:** Section 11 at the end of this document covers planned improvements and future roadmap.

---

## 1. System Overview

Tabby is a Kubernetes-native platform that maintains persistent authenticated browser sessions on behalf of AI agents and automation platforms. Each session runs a dedicated Chromium instance in an ephemeral Kubernetes pod. When automation encounters a challenge it cannot defeat — MFA, CAPTCHA, device verification, or any custom human input — the system pauses, notifies a human operator via Slack or VNC Link on response, provides a live browser stream (VNC or CDP), and resumes once the challenge is resolved.

**Primary use case:** An AI agent or external platform calls `POST /credentials/request`. Tabby checks whether a live, healthy session exists for that application. If yes, it returns cached credentials (cookies, headers, tokens) immediately. If no live session exists, it orchestrates a fresh browser login, escalating to a human only when the automated login hits a wall it cannot pass.

**What Tabby is not:** It is not an identity provider. It does not issue OAuth tokens for users. It does not perform SAML or OIDC federation. It is a browser session manager that acts as an OAuth Resource Server — it validates JWTs issued by a third-party IdP (Frontegg, Okta, Azure AD, etc.) and scopes all data access to the authenticated tenant and user.

---

## 2. Component Diagram

```mermaid
graph TB
    subgraph External["External Actors"]
        Agents["AI Agents / MCP / Platform API"]
        Humans["Human Operators"]
    end

    subgraph Ingress["Ingress Layer"]
        NG["NGINX / Istio - TLS termination"]
    end

    subgraph TabbyNS["browser-hitl namespace"]
        subgraph APItier["API Tier"]
            API["Tabby API - NestJS :8000"]
        end

        subgraph NotifTier["Notification Tier - optional"]
            SlackBot["Slack Bot - NATS subscriber"]
        end

        subgraph OrchTier["Orchestration Tier"]
            Controller["Controller - NestJS :8090"]
        end

        subgraph WorkerTier["Worker Tier - ephemeral"]
            Worker["Worker Pod - Playwright + Chromium"]
            NoVNC["noVNC Sidecar :6080"]
        end

        subgraph EgressTier["Egress Tier"]
            EgressProxy["Egress Proxy :3128 - FQDN allowlist"]
        end

        subgraph Stores["Backing Stores"]
            PG[("PostgreSQL :5432")]
            Redis[("Redis :6379")]
            NATS[("NATS JetStream :4222")]
            MinIO[("MinIO :9000")]
        end
    end

    subgraph Internet["Internet"]
        ExtSites["Enterprise SaaS"]
        IdP["External IdP"]
    end

    Agents -->|"HTTPS + Bearer JWT"| NG
    Humans -->|"HTTPS"| NG
    NG --> API

    API <-->|"SQL"| PG
    API <-->|"Redis"| Redis
    API -->|"pub"| NATS
    API -->|"S3"| MinIO

    Controller <-->|"SQL"| PG
    Controller <-->|"Redis"| Redis
    Controller -->|"pub"| NATS
    Controller -->|"K8s API"| K8sAPI["Kubernetes API"]

    NATS -.->|"hitl.* events"| SlackBot
    SlackBot -->|"POST /input"| API

    Worker <-->|"SQL"| PG
    Worker <-->|"Redis"| Redis
    Worker -->|"S3"| MinIO
    Worker -->|"pub"| NATS
    Worker -->|"CONNECT"| EgressProxy
    EgressProxy -->|"FQDN-filtered HTTPS"| ExtSites

    Humans -.->|"WebSocket VNC"| API
    NoVNC <-.->|"VNC localhost"| Worker

    API <-.->|"JWKS fetch"| IdP
```



> **Note:** Admin UI exists in the chart (`adminUi.enabled`) but is currently disabled. A full management UI is planned — see Section 11.

---

## 3. Data Flow Diagrams

### 3.1 Session Lifecycle

```mermaid
sequenceDiagram
    participant Platform as Platform / Agent / MCP
    participant API as Tabby API
    participant PG as PostgreSQL
    participant NATS as NATS JetStream
    participant Controller as Controller
    participant K8s as Kubernetes API
    participant Worker as Worker Pod

    Platform->>API: POST /credentials/request\n{appId, tenantId}
    API->>PG: Check existing HEALTHY session
    alt No healthy session
        API->>PG: Create session record\nstate=STARTING
        API->>NATS: session.state.changed
        NATS-->>Controller: event received
        Controller->>K8s: Create worker pod
        K8s-->>Worker: Pod starts
        Worker->>Worker: Launch Chromium\nRun Login DSL
        Worker->>PG: Update state=HEALTHY
        Worker->>MinIO: Upload encrypted\nartifact bundle
        Worker->>NATS: auth.bundle.exported
    end
    API->>MinIO: Fetch artifact bundle
    API->>Platform: Return credential envelope\n{cookies, headers, tokens, freshness}
```



### 3.2 HITL Flow (Human Intervention)

HITL can be triggered and resolved through multiple channels: Slack bot, MCP (via VNC link in tool response), or direct VNC access. The notification channel is configurable — Slack is optional.

```mermaid
sequenceDiagram
    participant Worker as Worker Pod
    participant PG as PostgreSQL
    participant NATS as NATS JetStream
    participant Controller as Controller
    participant API as Tabby API
    participant Redis as Redis
    participant Channel as Notification Channel
    participant Human as Human Operator

    Worker->>Worker: Login DSL hits MFA / CAPTCHA
    Worker->>PG: Write pending_input_request
    Worker->>NATS: AUTH_FAIL signal
    NATS-->>Controller: event received
    Controller->>PG: state=LOGIN_NEEDED
    Controller->>PG: Create Intervention record
    Controller->>NATS: hitl.started

    alt Slack Bot (configured)
        NATS-->>Channel: hitl.started event
        Channel->>Human: Slack message with dynamic buttons
    else MCP / Agent flow
        API-->>Channel: Return HITL response with VNC URL
        Channel->>Human: LLM shows VNC link in chat
    else Direct API
        API-->>Human: VNC stream URL via /sessions/:id/stream
    end

    alt Human submits value (OTP, password, URL)
        Human->>API: POST /sessions/:id/input
        API->>Redis: SET human_input:{sessionId}:{stepIndex}
        Worker->>Redis: POLL for value
        Worker->>Worker: Fill value, continue DSL
    else Human resolves via VNC (confirm type)
        Human->>API: VNC stream + Mark as Resolved button
        API->>Redis: SET human_input (type=confirm)
        Worker->>Redis: POLL, receives confirmation
    end

    Worker->>Worker: Login succeeds
    Worker->>PG: state=HEALTHY
    Controller->>NATS: hitl.completed
```



### 3.3 Credential Request Flow

```mermaid
sequenceDiagram
    participant Platform as Platform / Agent / MCP
    participant API as Tabby API
    participant PG as PostgreSQL
    participant Redis as Redis
    participant MinIO as MinIO
    participant Worker as Worker Pod

    Platform->>API: POST /credentials/request\n{appId, tenantId, force_refresh?}
    API->>API: Validate JWT (Bearer token)\nResolve tenant + user
    API->>Redis: Acquire distributed lock\n(prevent concurrent logins)
    API->>PG: SELECT...FOR UPDATE\n(serialization gate)
    API->>PG: Check session state + artifact TTL
    
    alt Credentials are fresh (within export_policy TTL)
        API->>MinIO: Fetch encrypted bundle
        API->>API: Decrypt with tenant AES-256 key
        API->>Platform: credential_envelope\n{freshness: CACHED}
    else Session healthy, re-extraction needed
        API->>Worker: Trigger artifact re-extraction
        Worker->>MinIO: Upload fresh bundle
        API->>MinIO: Fetch bundle
        API->>Platform: credential_envelope\n{freshness: EXTRACTED}
    else No healthy session
        API->>PG: Create session (STARTING)
        Note over API,Worker: Full session lifecycle (see 3.1)
        API->>Platform: credential_envelope\n{freshness: ON_DEMAND}
    end
```



### 3.4 OAuth / Multi-Tenant Auth Flow

```mermaid
sequenceDiagram
    participant User as User / Agent
    participant IdP as External IdP\n(Okta / Azure AD / Frontegg)
    participant Platform as Calling Platform
    participant API as Tabby API
    participant JWKS as IdP JWKS Endpoint
    participant PG as PostgreSQL

    User->>IdP: Authenticate (user login)
    IdP-->>Platform: JWT (iss=IdP, sub=user, tenantId=org)

    alt Direct bearer path
        Platform->>API: GET /sessions\nAuthorization: Bearer <idp_jwt>
        API->>API: Decode JWT header (unverified)\nExtract iss claim
        API->>PG: Find IdP registration by issuer_url
        API->>JWKS: GET {iss}/.well-known/jwks.json\n(cached 5 min)
        JWKS-->>API: Public keys
        API->>API: Verify signature + exp + aud (if configured)
        API->>PG: Resolve or auto-provision\ntenant + user
        API-->>Platform: 200 Response (scoped to tenant/user)
    else Token exchange path
        Platform->>API: POST /auth/token-exchange\n{subject_token: <idp_jwt>,\nsubject_token_type: "oidc_jwt"}
        API->>API: Validate IdP JWT (same as above)
        API->>API: Issue short-lived Tabby JWT\n(HS256, jti blacklist, TTL=3600s)
        API-->>Platform: {access_token: <tabby_jwt>}
        Platform->>API: Subsequent calls with Tabby JWT
    end
```



---

## 4. Session State Machine

```mermaid
stateDiagram-v2
    [*] --> STARTING : Controller creates worker pod

    STARTING --> HEALTHY : Login DSL completes, health check passes
    STARTING --> LOGIN_NEEDED : DSL signals AUTH_FAIL
    STARTING --> FAILED : DSL errors, retries exhausted
    STARTING --> TERMINATED : Max age reached

    HEALTHY --> UNHEALTHY : Health check fails
    HEALTHY --> TRANSIENT_FAIL : Temporary extraction error
    HEALTHY --> TERMINATED : Max session age or idle shutdown

    TRANSIENT_FAIL --> HEALTHY : Next health check passes
    TRANSIENT_FAIL --> UNHEALTHY : Consecutive failures
    TRANSIENT_FAIL --> FAILED : Retries exhausted

    UNHEALTHY --> HEALTHY : Health check recovers
    UNHEALTHY --> LOGIN_NEEDED : Auth failure detected

    LOGIN_NEEDED --> LOGIN_IN_PROGRESS : Controller queues login

    LOGIN_IN_PROGRESS --> HEALTHY : Login DSL succeeds
    LOGIN_IN_PROGRESS --> FAILED : Login fails, retries exhausted
    LOGIN_IN_PROGRESS --> TERMINATED : 10-min HITL timeout exceeded

    FAILED --> STARTING : Operator acknowledges + retries
    FAILED --> TERMINATED : Operator acknowledges + terminates

    TERMINATED --> [*]
```



**Baton state machine** (concurrent with session state during HITL):

```mermaid
stateDiagram-v2
    [*] --> AUTOMATION_CONTROL : Session created
    AUTOMATION_CONTROL --> HUMAN_REQUESTED : Worker requests HITL
    HUMAN_REQUESTED --> HUMAN_CONTROL : Operator takes over (POST /takeover)
    HUMAN_CONTROL --> HUMAN_RELEASED : Operator releases (POST /release)
    HUMAN_RELEASED --> AUTOMATION_CONTROL : Worker resumes
```



---

## 5. Deployment Topology

```mermaid
graph TB
    subgraph Cluster["Kubernetes Cluster"]
        subgraph NSbh["Namespace: browser-hitl"]
            subgraph Permanent["Permanent Workloads"]
                API_D["Deployment: api\n(1–N replicas)"]
                CTL_D["Deployment: controller\n(1 replica only)"]
                SLACK_D["Deployment: slack-bot\n(optional)"]
                EGRESS_D["Deployment: egress-proxy"]
                REDIS_D["Deployment: redis"]
            end

            subgraph StatefulSets["StatefulSets"]
                PG_SS["StatefulSet: postgres\nPVC: 20Gi (ReadWriteOnce)"]
                NATS_SS["StatefulSet: nats\nPVC: 10Gi"]
                MINIO_SS["StatefulSet: minio\nPVC: 50Gi"]
            end

            subgraph Ephemeral["Ephemeral (created on demand)"]
                W1["Worker Pod\n(1 per session)"]
                W2["Worker Pod\n(1 per session)"]
                WN["Worker Pod\n(1 per session)"]
            end

            subgraph RBAC["RBAC"]
                SA["ServiceAccount:\ntabby-controller"]
                Role["Role: pod-manager\ncreate/delete/get/list/watch\npods, services, networkpolicies"]
                RB["RoleBinding"]
                SA --- RB
                RB --- Role
            end

            subgraph Secrets["Secrets"]
                SEC["Secret: tabby-browser-hitl-secrets\npostgresPassword\njwtSigningKey\ntenantEncryptionKey\nminioAccessKey / secretKey\nslackBotToken (if enabled)"]
            end

            subgraph ConfigMaps["ConfigMaps"]
                CM["ConfigMap: tabby-browser-hitl\nDB URL, Redis URL, NATS URL\nPublic base URL, tuning params"]
                EGCM["ConfigMap: egress-proxy-config\nFQDN allowlist"]
            end
        end

        subgraph IngressNS["Namespace: ingress-nginx (or istio-system)"]
            ING["NGINX Ingress Controller\nor Istio Gateway"]
        end
    end

    ING --> API_D
    CTL_D -->|"K8s API"| W1
    CTL_D -->|"K8s API"| W2
    CTL_D -->|"K8s API"| WN
    SEC -.->|"env injection"| API_D
    SEC -.->|"env injection"| CTL_D
    SEC -.->|"env injection"| W1
    CM -.->|"env injection"| API_D
    CM -.->|"env injection"| CTL_D
```



### Pod Lifecycle


| Pod Type                | Created By           | Lifetime                                                | Count                        |
| ----------------------- | -------------------- | ------------------------------------------------------- | ---------------------------- |
| API                     | Helm / Deployment    | Permanent                                               | 1–N (stateless, scalable)    |
| Controller              | Helm / Deployment    | Permanent                                               | **Always exactly 1**         |
| Admin UI                | Helm / Deployment    | **Currently disabled**                                  | 0 (planned — see Section 11) |
| Slack Bot               | Helm / Deployment    | Permanent, optional                                     | 0 or 1                       |
| Egress Proxy            | Helm / Deployment    | Permanent                                               | 1                            |
| Postgres / NATS / MinIO | Helm / StatefulSet   | Permanent                                               | 1 each                       |
| Redis                   | Helm / Deployment    | Permanent                                               | 1                            |
| Worker                  | Controller (dynamic) | Ephemeral — exists only for the duration of one session | 0 to N                       |


---

## 6. Network Diagram

```mermaid
graph LR
    subgraph External["External (Internet)"]
        Browser["Operator Browser"]
        PlatformClient["Platform / Agent"]
        IdPExternal["External IdP\nJWKS endpoint"]
        EntSaaS["Enterprise SaaS\n(Salesforce, Workday...)"]
    end

    subgraph ClusterIngress["Cluster Ingress (HTTPS :443)"]
        IngressCtl["NGINX or Istio\nTLS termination\nTwo hosts required:\ntabby-api.*\ntabby-admin.*"]
    end

    subgraph NS["browser-hitl namespace"]
        API8000["API :8000"]
        Controller8090["Controller :8090"]
        Worker8091["Worker :8091 (health)"]
        VNC5900["VNC :5900 (localhost only)"]
        NoVNC6080["noVNC :6080"]
        EgressProxy3128["Egress Proxy :3128"]
        PG5432["Postgres :5432"]
        Redis6379["Redis :6379"]
        NATS4222["NATS :4222"]
        MinIO9000["MinIO :9000"]
    end

    Browser -->|"HTTPS :443"| IngressCtl
    PlatformClient -->|"HTTPS :443"| IngressCtl
    IngressCtl -->|"HTTP :8000"| API8000

    API8000 --> PG5432
    API8000 --> Redis6379
    API8000 --> NATS4222
    API8000 --> MinIO9000
    API8000 -.->|"WebSocket proxy"| NoVNC6080

    Controller8090 --> PG5432
    Controller8090 --> Redis6379
    Controller8090 --> NATS4222
    Controller8090 -->|"HTTPS :443/:6443"| K8sAPIServer["K8s API Server"]

    NATS4222 -.->|"sub hitl.*"| SlackBot["Slack Bot"]
    SlackBot -->|"POST /input"| API8000

    Worker8091 --> PG5432
    Worker8091 --> Redis6379
    Worker8091 --> MinIO9000
    Worker8091 --> NATS4222
    Worker8091 -->|"CONNECT :3128"| EgressProxy3128
    VNC5900 <-.->|"shared pod network"| NoVNC6080
    EgressProxy3128 -->|"HTTPS — FQDN-filtered"| EntSaaS

    API8000 -.->|"HTTPS JWKS fetch"| IdPExternal
```



### Port Reference


| Service            | Port | Protocol       | Exposed Externally?              | Notes                               |
| ------------------ | ---- | -------------- | -------------------------------- | ----------------------------------- |
| API                | 8000 | HTTP/WebSocket | Yes (via Ingress)                | REST API + VNC WebSocket proxy      |
| Admin UI           | 8000 | HTTP           | Yes (via Ingress, separate host) | Currently disabled — see Section 11 |
| Controller         | 8090 | HTTP           | No — in-cluster only             | Health check only                   |
| Worker (health)    | 8091 | HTTP           | No — in-cluster only             | Kubernetes liveness/readiness       |
| Worker (VNC)       | 5900 | VNC            | No — localhost only              | x11vnc, binds 127.0.0.1 only        |
| noVNC sidecar      | 6080 | HTTP/WebSocket | No — proxied via API             | WebSocket VNC client                |
| Egress Proxy       | 3128 | HTTP CONNECT   | No — in-cluster only             | Workers use as HTTP proxy           |
| Egress Proxy admin | 8095 | HTTP           | No — in-cluster only             | Allowlist management API            |
| Postgres           | 5432 | TCP            | No — in-cluster only             |                                     |
| Redis              | 6379 | TCP            | No — in-cluster only             |                                     |
| NATS               | 4222 | TCP            | No — in-cluster only             |                                     |
| NATS monitor       | 8222 | HTTP           | No — in-cluster only             | Debug endpoint                      |
| MinIO API          | 9000 | HTTP           | No — in-cluster only             | S3-compatible                       |
| MinIO console      | 9001 | HTTP           | No — in-cluster only             | Admin console (disable in prod)     |


---

## 7. Security Model

### 7.1 Authentication Chain

```mermaid
graph TD
    A["Client sends\nAuthorization: Bearer JWT"] --> B{JWT iss claim\nrecognized?}
    B -->|"External IdP"| C["Decode header\nExtract kid"]
    C --> D["Fetch public key from\nIdP JWKS endpoint\n(cached 5 min)"]
    D --> E["Verify RS256 signature\nverify exp\nverify aud (if configured)"]
    E --> F["Resolve tenant from\ntenant_id_claim"]
    F --> G["Auto-provision tenant/user\n(if allow_auto_provision=true)"]
    G --> H["Attach role from\nemail domain match\nvs admin_domains"]
    B -->|"Tabby-issued JWT\n(iss=tabby)"| I["Verify HS256\nwith JWT signing key\nCheck Redis blacklist\n(jti revocation)"]
    I --> J["Resolve user from\nsub claim"]
    H --> K["RBAC enforcement\n@Roles decorator +\nRolesGuard on all endpoints"]
    J --> K
    K --> L["Scope data to\nowner_user_id / tenant_id"]
```



### 7.2 Data Encryption


| Data                                      | Encryption                                             | Key                                                   |
| ----------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| Credentials and artifacts at rest (MinIO) | AES-256-GCM                                            | `TENANT_ENCRYPTION_KEY` — 32-byte key, per deployment |
| Passwords in DB                           | bcrypt cost 12                                         | N/A (one-way hash)                                    |
| NATS events                               | No payload encryption; subject names contain no PII    | TLS in transit (optional)                             |
| Postgres data at rest                     | Rely on disk/volume encryption at infrastructure layer | —                                                     |
| JWT signing                               | HS256                                                  | `JWT_SIGNING_KEY` — symmetric, ≥32 chars              |


**Critical:** `TENANT_ENCRYPTION_KEY` must be present on **both** API and Worker pods. If missing from either, credential extraction silently returns empty values.

### 7.3 Container Security

All containers run with:

- `runAsNonRoot: true`
- `allowPrivilegeEscalation: false`
- `capabilities.drop: [ALL]`


| Service                                                         | runAsUser (UID)                                    |
| --------------------------------------------------------------- | -------------------------------------------------- |
| API, Admin UI, Controller, Slack Bot, Egress Proxy, NATS, MinIO | 1000                                               |
| Postgres, Redis                                                 | 999                                                |
| Worker                                                          | `pwuser` (non-root, part of Playwright base image) |


No privileged containers. No host network access. No host PID.

### 7.4 Network Policies

When `networkPolicies.enabled: true`, Kubernetes NetworkPolicies enforce the following allowed traffic matrix:


| Source             | Destination              | Port     | Allowed?                          |
| ------------------ | ------------------------ | -------- | --------------------------------- |
| Ingress controller | API                      | 8000     | Yes                               |
| Ingress controller | Admin UI                 | 8000     | Yes                               |
| API                | Postgres                 | 5432     | Yes                               |
| API                | Redis                    | 6379     | Yes                               |
| API                | NATS                     | 4222     | Yes                               |
| API                | MinIO                    | 9000     | Yes                               |
| Controller         | Postgres                 | 5432     | Yes                               |
| Controller         | Redis                    | 6379     | Yes                               |
| Controller         | NATS                     | 4222     | Yes                               |
| Controller         | K8s API server           | 443/6443 | Yes                               |
| Slack Bot          | NATS                     | 4222     | Yes                               |
| Slack Bot          | API                      | 8000     | Yes                               |
| Worker             | Postgres                 | 5432     | Yes                               |
| Worker             | Redis                    | 6379     | Yes                               |
| Worker             | NATS                     | 4222     | Yes                               |
| Worker             | MinIO                    | 9000     | Yes                               |
| Worker             | Egress Proxy             | 3128     | Yes                               |
| Egress Proxy       | Internet (FQDN-filtered) | 443      | Configured allowlist              |
| API                | External IdP (JWKS)      | 443      | Yes (required for JWT validation) |
| Everything else    | Everything else          | Any      | **Denied**                        |


**Network policies are disabled by default** (`networkPolicies.enabled: false`). Enable in production.

### 7.5 RBAC


| Role         | Permissions                                                                              |
| ------------ | ---------------------------------------------------------------------------------------- |
| **Admin**    | Full access — all tenants, all sessions, IdP management, template management             |
| **Operator** | Own tenant only — sessions, HITL actions (takeover, release, input), credential requests |
| **Viewer**   | Own tenant, read-only — sessions list, session status, stream access                     |
| **Agent**    | Service-to-service — credential requests, session creation (no human-facing endpoints)   |


Role is resolved at login time from the JWT `email` claim domain vs. the `admin_domains` list on the IdP registration. No per-user configuration required.

### 7.6 Audit Trail

All write operations produce append-only audit events in PostgreSQL:

- SHA-256 hash chain — each event includes the hash of the previous event
- `pg_advisory_lock(42)` serializes chain writes
- Daily anchor records for integrity verification
- Retention: 30 days (configurable via `lifecycleInterventionRetentionDays`)

### 7.7 Rate Limiting and Account Lockout

- API rate limiting via `@nestjs/throttler`
- Password auth: 5 failed attempts → 15-minute lockout (`users.locked_until`)
- Login request coalescing: Redis distributed lock (one login per app/tenant, 5-min TTL) + PostgreSQL `SELECT ... FOR UPDATE` — prevents concurrent login storms that could lock target accounts
- Worker-level login rate: minimum 60-second gap between attempts

### 7.8 Secret Management

Secrets flow:

1. Operator sets values in `values-onprem.yaml` (never committed to git)
2. Helm renders them into a Kubernetes Secret (`tabby-browser-hitl-secrets`)
3. API and Controller pods mount the Secret as environment variables
4. Controller injects `TENANT_ENCRYPTION_KEY` into each worker pod it creates at runtime

Supported external secret managers: any operator that writes a Kubernetes Secret with the expected keys (e.g., External Secrets Operator, Vault Agent Injector, AWS Secrets Manager CSI driver).

---

## 8. Technology Stack

### Application


| Component    | Runtime | Version  | Language              |
| ------------ | ------- | -------- | --------------------- |
| Tabby API    | Node.js | 20 (LTS) | TypeScript            |
| Controller   | Node.js | 20 (LTS) | TypeScript            |
| Worker       | Node.js | 20 (LTS) | TypeScript            |
| Slack Bot    | Node.js | 20 (LTS) | TypeScript            |
| Admin UI     | Next.js | 15.1.6   | TypeScript / React 19 |
| Egress Proxy | Node.js | 20.18.1  | TypeScript            |


### Application Frameworks


| Package                 | Version  | Purpose                      |
| ----------------------- | -------- | ---------------------------- |
| NestJS                  | ^10.4.15 | API and Controller framework |
| Playwright              | 1.50.0   | Browser automation           |
| TypeORM                 | ^0.3.20  | Database ORM                 |
| @slack/bolt             | ^3.18.0  | Slack integration            |
| botbuilder              | ^4.23.3  | Teams Bot Framework          |
| passport-jwt            | ^4.0.1   | JWT auth                     |
| prom-client             | ^15.1.3  | Prometheus metrics           |
| @kubernetes/client-node | ^1.0.0   | K8s pod management           |


### Infrastructure (in-cluster defaults)


| Service        | Image                        | Version                      |
| -------------- | ---------------------------- | ---------------------------- |
| PostgreSQL     | postgres                     | 16.8-alpine                  |
| Redis          | redis                        | 7.4-alpine                   |
| NATS JetStream | nats                         | 2.10.24-alpine               |
| MinIO          | minio/minio                  | RELEASE.2025-03-12T18-04-18Z |
| noVNC          | python                       | 3.11-slim                    |
| Worker base    | mcr.microsoft.com/playwright | v1.58.2-noble                |
| Egress proxy   | node                         | 20.18.1-alpine               |


### Helm Chart


| Property                   | Value                                       |
| -------------------------- | ------------------------------------------- |
| Chart name                 | `browser-hitl`                              |
| Chart version              | `1.3.6`                                     |
| OCI registry               | `oci://ghcr.io/adoptai/charts/browser-hitl` |
| Application image registry | `ghcr.io/adoptai/tabby/{service}:{tag}`     |
| Templates                  | 26                                          |


### Kubernetes Requirements


| Requirement         | Value                                                                         |
| ------------------- | ----------------------------------------------------------------------------- |
| Minimum K8s version | 1.27                                                                          |
| Tested on           | 1.28 – 1.30                                                                   |
| Required APIs       | `apps/v1`, `networking.k8s.io/v1`, `rbac.authorization.k8s.io/v1`, `batch/v1` |
| StorageClass        | Required (ReadWriteOnce PVCs)                                                 |
| Ingress             | NGINX Ingress Controller **or** Istio + Gateway                               |


---

## 9. NATS Event Topology

### Streams


| Stream           | Subjects                                                | Purpose                                  |
| ---------------- | ------------------------------------------------------- | ---------------------------------------- |
| `HITL_EVENTS`    | `hitl.*.{tenantId}.{sessionId}`                         | HITL lifecycle events                    |
| `SESSION_EVENTS` | `session.state.changed.*.`*, `auth.bundle.exported.*.*` | Session state + credential export events |


### Subject Patterns


| Subject                                        | Publisher  | Subscribers   |
| ---------------------------------------------- | ---------- | ------------- |
| `hitl.started.{tenantId}.{sessionId}`          | Controller | Slack Bot     |
| `hitl.completed.{tenantId}.{sessionId}`        | Controller | Slack Bot     |
| `session.state.changed.{tenantId}.{sessionId}` | Controller | Internal only |
| `auth.bundle.exported.{tenantId}.{appId}`      | Worker     | Internal only |


**Durability:** `sync_interval: always` is mandatory. Removing it risks data loss on pod restart.

---

## 10. Database Schema Overview

```
tenants
  └── identity_providers (OIDC/SAML IdP registrations, JWKS config)
  └── users (email, role, failed_login_count, locked_until)
       └── user_identities (external IdP sub claims)
  └── agent_clients (OAuth 2.0 service accounts)
  └── applications (app config: DSL, export_policy, browser_policy)
       └── service_profiles (versioned credential profile: STAGING→CANARY→ACTIVE→RETIRED)
            └── sessions (state machine, baton_state, pending_input_request)
                 └── session_batons (baton ownership log)
                 └── interventions (HITL records, input_request_metadata)
                 └── artifact_bundles (pointer to MinIO, encryption metadata)
                      └── artifact_consumptions (access log)
  └── audit_events (hash-chained, append-only)
  └── audit_anchors (daily integrity records)
  └── app_templates (reusable DSL templates)
  └── login_queue (serializes concurrent login attempts)
```

**Migrations:** 17 TypeORM migrations, run automatically on API startup. `synchronize: false`. Rollback via `down()` methods.

**Row-Level Security:** All tenant-scoped tables enforce RLS. Operator/Viewer roles see only records matching their `owner_user_id`. Admin sees all records within their tenant.

---

## 11. Future Improvements

### Management UI

The Admin UI exists in the chart but is currently disabled. The immediate priority is building a full management interface for configuring applications, service profiles, credentials, and monitoring sessions without requiring direct API calls or database access.

### Worker Resource Optimization

Each worker pod currently runs a full Chromium instance (~800MB-1GB memory). For deployments with hundreds of service profiles, this adds up quickly. We are actively investigating:

- **Multi-session pods** — running multiple isolated browser contexts within a single Chromium process, sharing the base memory footprint across sessions
- **Lightweight browser alternatives** — evaluating lighter headless engines for sites that don't require full Chromium rendering
- **Session pooling** — reusing warm browser instances across sequential credential extractions instead of cold-starting per session

### Autonomous Site Exploration

Currently, adding a new website requires manually authoring a Login DSL script and mapping egress proxy domains. The goal is to automate both: Tabby explores the login flow, auto-generates the DSL, and discovers the required domains for the egress allowlist.

### Credential Injection API

Not all credentials come from browser automation. A `POST /credentials/inject` endpoint would allow agents or external systems (e.g., Chrome extensions, token managers) to push credentials into Tabby for centralized management and distribution.

