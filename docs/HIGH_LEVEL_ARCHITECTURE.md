# Tabby — High-Level Architecture

## System Context

Tabby is a browser infrastructure service that provisions Chromium sessions, automates login flows, handles human-in-the-loop (HITL) intervention, and extracts credentials (cookies, tokens, headers) for AI agent consumption.

```mermaid
graph TB
    subgraph Callers
        PLAT["Adopt Platform<br/>(adoptwebui)"]
        MCP["MCP Server<br/>(python-mcp)"]
        NOUI["NoUI"]
        A3["ProjectA3 Executor<br/>(via:tabby WDL steps)"]
    end

    subgraph Tabby
        API["Tabby API<br/>NestJS · port 8000"]
        CTRL["Controller<br/>Reconcile loop · 15s"]
        WORKER["Worker Pods<br/>Playwright + Chromium"]
        SLACK["Slack Bot"]
        TEAMS["Teams Bot"]
        ADMIN["Admin UI<br/>React + Vite"]
    end

    subgraph Infrastructure
        PG[(PostgreSQL)]
        REDIS[(Redis)]
        NATS[NATS JetStream]
        MINIO[(MinIO)]
    end

    subgraph Human Access
        VNC["VNC / noVNC Viewer"]
        CDP["CDP Canvas Viewer"]
    end

    PLAT -->|"token exchange +<br/>credentials/request"| API
    MCP -->|"via platform<br/>direct-signal"| PLAT
    NOUI -->|"execute/browser +<br/>app templates"| API
    A3 -->|"execute/fetch"| API

    API --> PG
    API --> REDIS
    API --> MINIO
    CTRL --> PG
    CTRL --> NATS
    CTRL -->|"K8s API<br/>create/destroy"| WORKER
    SLACK --> NATS
    TEAMS --> NATS
    ADMIN --> API

    WORKER --> VNC
    WORKER --> CDP
    WORKER -->|"artifacts<br/>(encrypted)"| MINIO
```

## Internal Components

```mermaid
graph LR
    subgraph "apps/api"
        AUTH[Auth Module<br/>JWT · OAuth · Token Exchange]
        CRED[Credentials Module<br/>Decrypt · Deliver]
        HITL[HITL Module<br/>Baton · Input · Stream]
        EXEC[Execute Module<br/>fetch · browser commands]
        STREAM[Streaming Module<br/>VNC/CDP viewer · WS proxy]
        AGENT[Agent Module<br/>run-url · session-status]
        TMPL[App Templates Module<br/>Auto-provisioning blueprints]
        APPS[Apps Module<br/>Application CRUD]
        PROF[Profiles Module<br/>Service profile lifecycle]
        SESS[Sessions Module<br/>Session listing · scaling]
        EVENTS[Events Gateway<br/>NATS → WebSocket relay]
    end

    subgraph "apps/controller"
        RECON[Reconcile Service<br/>FOR UPDATE SKIP LOCKED]
        SM[State Machine<br/>Session transitions · HITL]
        POD[Pod Manager<br/>K8s pod/svc/netpol lifecycle]
        NATS_PUB[NATS Publisher<br/>hitl.started · session.state]
    end

    subgraph "apps/worker"
        DSL[Login DSL Runner<br/>16 step types]
        HEALTH[Health Predicate<br/>url_check · dom_check]
        EXTRACT[Artifact Extractor<br/>cookies · headers · custom JS]
        INPUT[Input Relay<br/>Redis poll for human input]
        CDPRELAY[CDP Relay Server<br/>port 9223]
        EXECHDL[Execute Handlers<br/>fetch · browser commands]
    end

    subgraph "packages/shared"
        TYPES[DSL Types · Enums<br/>State Machine · Constants<br/>Redis Keys · NATS Subjects<br/>Credential Envelope Types]
    end
```

## Session State Machine

```mermaid
stateDiagram-v2
    [*] --> STARTING: Controller creates session + pod
    STARTING --> HEALTHY: Health predicate PASS
    STARTING --> LOGIN_NEEDED: Health predicate AUTH_FAIL
    STARTING --> FAILED: TRANSIENT_FAIL (max retries)

    LOGIN_NEEDED --> LOGIN_IN_PROGRESS: Controller creates intervention
    LOGIN_IN_PROGRESS --> HEALTHY: Human resolves + health PASS
    LOGIN_IN_PROGRESS --> LOGIN_NEEDED: New input request (sequential)
    LOGIN_IN_PROGRESS --> FAILED: Timeout / max attempts

    HEALTHY --> UNHEALTHY: Keepalive health check fails
    HEALTHY --> TERMINATED: desired=0 / idle shutdown / max age

    UNHEALTHY --> HEALTHY: Health recovers
    UNHEALTHY --> LOGIN_NEEDED: AUTH_FAIL detected
    UNHEALTHY --> FAILED: Max retries exceeded

    FAILED --> TERMINATED: Cleanup
    TERMINATED --> [*]
```

## Baton State Machine

```mermaid
stateDiagram-v2
    AUTOMATION_CONTROL --> HUMAN_REQUESTED: Controller detects AUTH_FAIL
    HUMAN_REQUESTED --> HUMAN_CONTROL: Human takes over (VNC/Slack)
    HUMAN_CONTROL --> HUMAN_RELEASED: Human clicks resolve
    HUMAN_RELEASED --> AUTOMATION_CONTROL: Worker resumes
```

## Credential Request Flow

```mermaid
sequenceDiagram
    participant C as Caller
    participant API as Tabby API
    participant R as Redis
    participant W as Worker
    participant M as MinIO

    C->>API: POST /credentials/request {profile_id}
    API->>API: Resolve ACTIVE profile + HEALTHY session

    alt Session HEALTHY
        API->>M: Fetch encrypted artifact bundle
        M-->>API: AES-256-GCM bundle
        API->>API: Decrypt + buildCredentialSet
        API-->>C: CredentialResponseEnvelope
    else No session (auto-provision)
        API->>API: Find matching App Template
        API->>API: Clone → Application + Profile + Session
        Note over API: Controller picks up session on next reconcile
    else Session not HEALTHY
        API-->>C: 404 (caller polls session-status)
    end
```

## HITL Flow

```mermaid
sequenceDiagram
    participant W as Worker
    participant DB as Postgres
    participant CTRL as Controller
    participant NATS as NATS
    participant SB as Slack Bot
    participant H as Human
    participant R as Redis

    W->>DB: pending_input_request + AUTH_FAIL
    CTRL->>DB: Detect AUTH_FAIL → transition LOGIN_NEEDED
    CTRL->>DB: Create intervention + set baton HUMAN_REQUESTED
    CTRL->>DB: Transition → LOGIN_IN_PROGRESS
    CTRL->>NATS: hitl.started.{tenant}.{session}
    NATS->>SB: Deliver event
    SB->>H: Slack message with buttons

    alt OTP / Password
        H->>SB: Submit via Slack modal
        SB->>R: SET human_input:{session}:{step}
    else VNC Confirm
        H->>API: POST /sessions/:id/input {confirm, resolved}
        API->>R: SET human_input:{session}:{step}
    end

    W->>R: Poll human_input:{session}:{step}
    R-->>W: Value received
    W->>W: Continue DSL execution
    W->>DB: Health check PASS
    CTRL->>DB: Transition → HEALTHY
    CTRL->>NATS: hitl.completed.{tenant}.{session}
```

## Platform Integration

```mermaid
sequenceDiagram
    participant U as User
    participant FE as Platform Frontend
    participant BE as Platform Backend
    participant T as Tabby API
    participant TW as Temporal Workflows
    participant A3 as ProjectA3

    U->>FE: Execute action
    FE->>BE: POST /v1/conversations/{id}/message

    Note over BE: tabby_resolution_service.py

    BE->>BE: Check deployment rules (use_tabby?)
    BE->>BE: Check feature flag ("tabby" enabled?)
    BE->>T: POST /auth/token-exchange (Frontegg JWT)
    T-->>BE: Tabby JWT (cached ~59 min)
    BE->>T: POST /credentials/request

    alt HEALTHY
        T-->>BE: Credential envelope
        BE->>BE: Extract values via credential_path
        BE->>TW: Dispatch with resolved headers
        TW->>A3: Execute WDL
    else HITL needed
        T-->>BE: 404 → poll session-status
        BE-->>FE: tabby_hitl_required + VNC grant
        FE-->>U: Show VNC viewer
        U->>FE: Login + Mark as Resolved
        FE->>BE: POST /tabby-resolve-hitl
        BE->>T: POST /sessions/:id/input
    end
```

## Deployment Architecture

```mermaid
graph TB
    subgraph "Kubernetes Cluster"
        subgraph "Static Pods (Helm-managed)"
            API_POD["API Pod<br/>replicas: 1-4"]
            CTRL_POD["Controller Pod<br/>replicas: 1-3"]
            SLACK_POD["Slack Bot Pod"]
            TEAMS_POD["Teams Bot Pod"]
            ADMIN_POD["Admin UI Pod"]
            PG_POD["PostgreSQL"]
            REDIS_POD["Redis"]
            NATS_POD["NATS"]
            MINIO_POD["MinIO"]
        end

        subgraph "Dynamic Pods (Controller-managed)"
            W1["Worker Pod<br/>Chromium + noVNC sidecar"]
            W2["Worker Pod"]
            WN["Worker Pod N"]
        end
    end

    CTRL_POD -->|"K8s API"| W1
    CTRL_POD -->|"K8s API"| W2
    CTRL_POD -->|"K8s API"| WN
```

### Cloud vs On-Prem

| Aspect | Cloud (TrueFoundry) | On-Prem (Helm) |
|---|---|---|
| Deployment | `tfy apply` (ArgoCD) | `helm upgrade` |
| Chart | `adopt-tabby` subchart in `adoptapp` umbrella | Standalone `browser-hitl` chart |
| Images | `ghcr.io/adoptai/tabby/*` | Customer registry |
| Ingress | Istio VirtualService | Ingress / VirtualService |
| Hosts | `tabby-api.*` + `tabby-admin.*` (two-host required) | Same |
| IdP | Frontegg (shared) | Customer IdP (OIDC/SAML) |
| Infra | Embedded PG/Redis/NATS/MinIO | External managed services supported |

## Authentication

```mermaid
graph LR
    subgraph "Token Types"
        FED["Federated JWT<br/>Platform user via token-exchange"]
        AGENT["Agent JWT<br/>Bot via client credentials"]
        SVC["Service Token<br/>Internal service auth"]
        HUMAN["Human JWT<br/>Direct login (admin)"]
        VNC_TOK["VNC Cookie<br/>OAuth callback · 1h"]
        STREAM["Stream Token<br/>Single-use · 10min"]
    end

    subgraph "Roles (5)"
        ADMIN["Admin — full access"]
        EDITOR["Editor — apps, templates, profiles"]
        OPERATOR["Operator — sessions, VNC, HITL"]
        VIEWER["Viewer — read-only"]
        AGENT_R["Agent — scoped to allowed_profiles"]
    end

    FED --> EDITOR
    FED --> OPERATOR
    AGENT --> AGENT_R
    HUMAN --> ADMIN
    SVC --> OPERATOR
```

## Key Data Stores

| Store | What it holds |
|---|---|
| **PostgreSQL** | Tenants, users, applications, sessions, profiles, interventions, artifacts, audit log, circuit breaker, IdP config, agent clients, app templates |
| **Redis** | Human input relay, stream tokens, JWT blacklist, extract locks, OAuth state, short links, VNC auth, rate limits |
| **NATS JetStream** | `hitl.started.*`, `hitl.completed.*`, `session.state.changed.*`, `auth.bundle.exported.*` |
| **MinIO** | Encrypted credential artifact bundles (AES-256-GCM) |

## Key Ports

| Service | Port |
|---|---|
| API | 8000 |
| Controller health | 8090 |
| Worker health | 8091 |
| Admin UI | 8000 |
| noVNC sidecar | 6080 |
| CDP relay | 9223 |
