# Tabby Security Architecture — Infosec Overview

```mermaid
graph TB
    subgraph "Client Layer"
        Platform["Platform / MCP / Admin UI"]
    end

    subgraph "Tabby API (port 8000)"
        Auth["Authentication Gate"]
        RBAC["RBAC Enforcement<br/>Admin | Operator | Agent"]
        TokenBlacklist["Token Blacklist<br/>(Redis, TTL-matched)"]
        AuditLog["Audit Log<br/>SHA-256 hash chain<br/>90-day retention"]
        RevocationAPI["Revocation API<br/>DELETE /vnc/:id/stream-access"]
    end

    subgraph "VNC Access Gate"
        OAuthGate["OAuth / Email Verification"]
        CookieCheck["tabby_vnc Cookie<br/>HttpOnly · Secure · SameSite<br/>1h TTL · owner_user_id match"]
        StreamToken["Stream Token<br/>10 min TTL · single-use"]
    end

    subgraph "Session Lifecycle"
        Controller["Controller<br/>Reconcile loop ~15s"]
        ScaleAPI["POST /apps/:id/sessions/scale<br/>Immediate termination"]
    end

    subgraph "Worker Pod (ephemeral)"
        Browser["Playwright / Chromium"]
        ArtifactEnc["Artifact Encryption<br/>AES-256-GCM<br/>per-tenant key"]
    end

    subgraph "Storage"
        Postgres["PostgreSQL<br/>Sessions · Audit · Users"]
        Redis["Redis<br/>Token blacklist · Revocation markers<br/>Human input (300s) · Stream tokens (600s)"]
        MinIO["MinIO (S3)<br/>Encrypted artifacts<br/>7-day default retention"]
    end

    subgraph "Monitoring"
        Sentry["Sentry<br/>All 4 services<br/>SENTRY_ENABLED + SENTRY_DSN"]
        Logs["Structured JSON → stdout<br/>Ready for Sumo Logic<br/>K8s collector (no code change)"]
    end

    Platform -->|"JWT (24h TTL)"| Auth
    Auth --> RBAC
    Auth -->|"Revoked?"| TokenBlacklist
    RBAC -->|"Every action logged"| AuditLog
    RBAC --> ScaleAPI
    ScaleAPI -->|"desired_count = 0"| Controller
    Controller -->|"Destroys pod ~15s"| Browser

    Platform -->|"Stream token (10 min)"| StreamToken
    StreamToken --> OAuthGate
    OAuthGate -->|"Sets cookie"| CookieCheck
    CookieCheck -->|"owner mismatch → 403"| Platform

    Browser -->|"AES-256-GCM encrypt"| ArtifactEnc
    ArtifactEnc -->|"Encrypted blob"| MinIO
    RBAC -->|"Decrypt on /credentials/request"| MinIO

    Auth --> RevocationAPI
    RevocationAPI -->|"Redis marker"| Redis

    Browser --> Logs
    Auth --> Logs
    Controller --> Logs
    Logs --> Sentry
```

## Secrets & Keys Reference

| Secret | Purpose | Where Used | Rotation |
| --- | --- | --- | --- |
| `TENANT_ENCRYPTION_KEY` | AES-256-GCM key for artifact encryption/decryption | Worker (encrypt) + API (decrypt) | Single deployment-wide key, must match on both pods |
| `JWT_SIGNING_KEY` | Signs all Tabby-issued JWTs (login, service auth, VNC cookies) | API | Shared across API replicas |
| `AGENT_SECRET_HMAC_KEY` | HMAC for agent client_secret generation | API | Change invalidates all agent credentials |
| `SENTRY_DSN` | Sentry error reporting endpoint | All services | Non-sensitive, can be rotated freely |

## Token TTLs

| Token | TTL | Single-use? | Revocable? |
| --- | --- | --- | --- |
| User JWT | 24h | No | Yes (Redis blacklist) |
| VNC cookie (`tabby_vnc`) | 1h | No | Yes (session termination) |
| Stream token | 10 min | Yes | Yes (DELETE endpoint) |
| Short link (Redis) | 10 min | No | Yes (session termination) |
| Human input (Redis) | 300s | No | N/A (expires naturally) |
| OAuth state (Redis) | 5 min | Yes (GETDEL) | N/A |

## Data Retention

| Data | Default Retention | Env Var | Cleanup Schedule |
| --- | --- | --- | --- |
| Artifacts | 7 days | `LIFECYCLE_ARTIFACT_RETENTION_DAYS` | Daily 3:15 AM |
| Sessions (terminated) | 14 days | `LIFECYCLE_SESSION_RETENTION_DAYS` | Daily 3:15 AM |
| Interventions | 30 days | `LIFECYCLE_INTERVENTION_RETENTION_DAYS` | Daily 3:15 AM |
| Apps (zero sessions) | 30 days | `LIFECYCLE_APP_RETENTION_DAYS` | Daily 3:15 AM |
| Audit events | 90 days | Hardcoded (per-tenant planned) | Daily 2:00 AM |
