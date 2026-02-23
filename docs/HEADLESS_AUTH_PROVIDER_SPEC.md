# Headless Authentication Provider — Solution Architecture Specification

**Version:** 0.1.0-draft
**Status:** RFC (Request for Comments)
**Authors:** Solution Architecture
**Date:** 2026-02-21

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Workflow Taxonomy](#3-workflow-taxonomy)
4. [Headless Auth Provider — Conceptual Model](#4-headless-auth-provider--conceptual-model)
5. [Canonical Interaction Sequences](#5-canonical-interaction-sequences)
6. [Service Provider Onboarding](#6-service-provider-onboarding)
7. [Credential Lifecycle Management](#7-credential-lifecycle-management)
8. [Failure Modes & Recovery](#8-failure-modes--recovery)
9. [Orchestration & Ensemble Management](#9-orchestration--ensemble-management)
10. [Security Architecture](#10-security-architecture)
11. [Tenancy & Isolation Model](#11-tenancy--isolation-model)
12. [Open Questions & Architectural Decisions](#12-open-questions--architectural-decisions)
13. [Appendix: Glossary](#13-appendix-glossary)

---

## 1. Executive Summary

This specification formalizes the evolution of Browser HITL from a proof-of-concept Slack OTP relay into a **production headless authentication provider** for agentic workflows.

**Core value proposition:** Agents consuming browser-action APIs today require users to keep a live browser tab open per service for authentication context. This system eliminates that requirement by maintaining persistent authenticated browser sessions in isolated containers, performing login and MFA negotiation autonomously, and exporting authentication credentials to locations agents can consume.

**Operating model:** One authenticated browser session per service per credential-set per organization, running in its own compartmentalized container with strict network egress controls. The system proactively maintains session health, detects authentication degradation, and re-authenticates — escalating to human operators only when automation fails.

---

## 2. Problem Statement

### 2.1 Current State

The company converts browser interactions into APIs via HAR recording. Agents invoke these APIs on behalf of users to interact with enterprise web applications (Salesforce, Siebel, ServiceNow, etc.).

**Authentication bottleneck:** Each target service requires an active, authenticated browser session. Today this means:

- Users keep a browser tab open per service
- N services = N tabs + the agent UI tab
- Tab closure, session timeout, or MFA re-prompt breaks the agent workflow
- Users manually re-authenticate when sessions expire
- No programmatic way for agents to recover from "auth required" states

### 2.2 Desired State

When an agent encounters an "auth required" response from a browser-action API:

1. Agent calls the Headless Auth Provider API
2. The system provides fresh authentication credentials (cookies, CSRF tokens, headers)
3. If credentials are cached and fresh, they are returned immediately
4. If credentials are stale or missing, the system performs authentication autonomously
5. The agent resumes its workflow with the new credentials
6. The system continuously maintains session health — re-authenticating proactively before agents encounter stale credentials

**Zero tabs. Zero user intervention (in the common case).**

### 2.3 Constraints

| Constraint | Rationale |
|-----------|-----------|
| One container per service session | Blast radius containment; compromised session cannot access other services |
| Per-organization isolation | Tenant data sovereignty; no cross-org credential leakage |
| Human escalation path must exist | Not all MFA can be automated (push notifications, hardware keys, CAPTCHAs) |
| Audit trail for all credential access | Compliance; who requested what credentials when |
| No credential persistence in plaintext | AES-256-GCM encryption at rest; memory-only in browser context |

---

## 3. Workflow Taxonomy

A **workflow** is a canonical interaction pattern that the Browser HITL system supports. Each workflow defines:

- **Purpose:** What problem it solves
- **Actors:** Who/what participates
- **Trigger conditions:** What initiates the workflow
- **Sequence of operations:** The ordered steps
- **Terminal states:** Success and failure outcomes
- **Escalation paths:** When human intervention is required

### 3.1 Workflow Registry

| ID | Workflow | Status | Description |
|----|----------|--------|-------------|
| `WF-001` | Slack OTP Proof-of-Life | Implemented (PoC) | Demonstrates HITL baton handoff, VNC streaming, and OTP relay via Slack |
| `WF-002` | Headless Auth Provider | **This specification** | Autonomous authentication maintenance for agentic API consumption |
| `WF-003` | Service Provider Onboarding | **This specification** | Process to add a new target service (Salesforce, Siebel, etc.) |

### 3.2 Service Profile

A **service profile** is a concrete instantiation of `WF-002` for a specific target application. It inherits the Headless Auth Provider workflow and adds provider-specific configuration:

```
Workflow: WF-002 (Headless Auth Provider)
  └── Service Profile: "Salesforce"
        ├── target_url: https://login.salesforce.com
        ├── login_dsl: [goto, fill#username, fill#password, click#login, ...]
        ├── mfa_strategy: { type: "totp", otp_field_selector: "#otp-input" }
        ├── health_predicates: [url_check(/home), dom_check(#user-nav)]
        ├── keepalive_actions: [goto(/home), wait_for(#dashboard)]
        ├── credential_extraction: { cookies: [sid, oid], headers: [Authorization], csrf: true }
        ├── auth_ttl: 3600s
        └── keepalive_interval: 300s
```

### 3.3 Relationship Hierarchy

```
Organization (Tenant)
  └── K8s Namespace (isolation boundary)
        └── Service Profile Instance ("Salesforce for Acme Corp")
              ├── Credential Set A (service-account@acme.com)
              │     └── Worker Pod (isolated container)
              │           ├── Browser session (Playwright + Chromium)
              │           ├── Keepalive runner
              │           ├── Health predicate evaluator
              │           └── Artifact extractor
              ├── Credential Set B (api-user@acme.com)  ← if multiple accounts needed
              │     └── Worker Pod (separate container)
              └── Exported Credentials → Secret Store / API Response
```

> **Critical distinction:** The isolation unit is **one container per credential-set per service per org** — not just per service. If an organization uses two Salesforce service accounts, that's two containers.

---

## 4. Headless Auth Provider — Conceptual Model

### 4.1 System Actors

| Actor | Type | Role |
|-------|------|------|
| **Agent** | Machine | Consumes browser-action APIs; triggers auth requests when credentials are stale |
| **Auth Provider API** | System | Receives auth requests, orchestrates credential provisioning |
| **Session Controller** | System | Reconciles desired vs actual session state; provisions/destroys worker pods |
| **Worker Pod** | System | Runs headless browser; executes login DSL, keepalive, health checks, artifact extraction |
| **Secret Store** | System | Stores exported credentials (Vault, K8s Secrets, or API-served) |
| **Human Operator** | Human | Intervenes when automated auth fails (CAPTCHA, push MFA, novel challenges) |
| **Platform Admin** | Human | Onboards service profiles, manages organizations, monitors system health |

### 4.2 Auth Request Lifecycle States

```
                                        ┌──────────────┐
                         ┌─────────────→│   CACHED     │──── return credentials
                         │              └──────────────┘
                         │ (fresh)
┌──────────┐     ┌──────┴───────┐       ┌──────────────┐
│ RECEIVED │────→│ CREDENTIAL   │──────→│ IN_PROGRESS  │──── login flow running
└──────────┘     │ CHECK        │ stale └──────┬───────┘
                 └──────────────┘              │
                                        ┌──────┴───────┐
                                        │ MFA_REQUIRED │──── OTP/HITL escalation
                                        └──────┬───────┘
                                               │
                                   ┌───────────┴───────────┐
                                   │                       │
                            ┌──────┴──────┐        ┌──────┴──────┐
                            │  COMPLETED  │        │   FAILED    │
                            │ (return     │        │ (retry or   │
                            │  creds)     │        │  escalate)  │
                            └─────────────┘        └─────────────┘
```

### 4.3 Credential Delivery Models

| Model | Flow | Use Case |
|-------|------|----------|
| **Synchronous Pull** | Agent calls `POST /auth/request` → waits → receives credentials in response | Simple; agent blocks until credentials ready |
| **Async Pull** | Agent calls `POST /auth/request` → receives `request_id` → polls `GET /auth/request/{id}` | Non-blocking; agent can do other work |
| **Push to Secret Store** | System pushes to Vault/K8s Secret on every refresh → agent reads from store | Decoupled; credentials always fresh at known location |
| **Event-Driven** | System publishes `auth.credentials.refreshed.{tenantId}.{profileId}` → agent subscribes | Real-time; zero-latency notification |

> **Recommendation:** Implement **Synchronous Pull** as the primary model (simplest for agent developers), with **Push to Secret Store** as secondary for high-throughput organizations. Event-driven can layer on top of either.

---

## 5. Canonical Interaction Sequences

### 5.1 Sequence: Agent Auth Request (Cache Hit — Happy Path)

```
Agent                API                CredentialCache     SecretStore
  │                   │                      │                  │
  │ POST /auth/request│                      │                  │
  │ {profile_id,      │                      │                  │
  │  org_id}          │                      │                  │
  │──────────────────→│                      │                  │
  │                   │                      │                  │
  │                   │ GET cached creds     │                  │
  │                   │─────────────────────→│                  │
  │                   │                      │                  │
  │                   │ HIT (age < auth_ttl) │                  │
  │                   │←─────────────────────│                  │
  │                   │                      │                  │
  │ 200 OK            │                      │                  │
  │ {cookies, headers,│                      │                  │
  │  csrf_token,      │                      │                  │
  │  expires_at,      │                      │                  │
  │  freshness: "cached"}                    │                  │
  │←──────────────────│                      │                  │
  │                   │                      │                  │
  │                   │ audit: credential_served                │
  │                   │─────────────────────────────────────────→
```

**Latency target:** < 50ms for cache hit.

### 5.2 Sequence: Agent Auth Request (Cache Miss — Login Required)

```
Agent              API             Controller        Worker Pod        NATS           SecretStore
  │                 │                  │                 │               │                │
  │ POST /auth/     │                  │                 │               │                │
  │ request         │                  │                 │               │                │
  │────────────────→│                  │                 │               │                │
  │                 │                  │                 │               │                │
  │                 │ cache MISS       │                 │               │                │
  │                 │                  │                 │               │                │
  │                 │ check session    │                 │               │                │
  │                 │ health           │                 │               │                │
  │                 │─────────────────→│                 │               │                │
  │                 │                  │                 │               │                │
  │                 │                  │ session: STARTING               │                │
  │                 │                  │ provision pod   │               │                │
  │                 │                  │────────────────→│               │                │
  │                 │                  │                 │               │                │
  │                 │                  │                 │ execute        │                │
  │                 │                  │                 │ login DSL      │                │
  │                 │                  │                 │               │                │
  │                 │                  │                 │ login SUCCESS  │                │
  │                 │                  │                 │──────────────→│                │
  │                 │                  │                 │               │                │
  │                 │                  │                 │ extract creds  │                │
  │                 │                  │                 │ (cookies,      │                │
  │                 │                  │                 │  headers,      │                │
  │                 │                  │                 │  csrf)         │                │
  │                 │                  │                 │               │                │
  │                 │                  │                 │ encrypt +      │                │
  │                 │                  │                 │ store artifact │                │
  │                 │                  │                 │──────────────────────────────→ │
  │                 │                  │                 │               │                │
  │                 │                  │                 │ publish:       │                │
  │                 │                  │                 │ auth.bundle.   │                │
  │                 │                  │                 │ exported       │                │
  │                 │                  │                 │──────────────→│                │
  │                 │                  │                 │               │                │
  │                 │ NATS: auth.bundle.exported         │               │                │
  │                 │←──────────────────────────────────────────────────│                │
  │                 │                  │                 │               │                │
  │                 │ decrypt creds    │                 │               │                │
  │                 │ from artifact    │                 │               │                │
  │                 │                  │                 │               │                │
  │ 200 OK          │                  │                 │               │                │
  │ {cookies,        │                  │                 │               │                │
  │  headers,        │                  │                 │               │                │
  │  csrf_token,     │                  │                 │               │                │
  │  expires_at,     │                  │                 │               │                │
  │  freshness:      │                  │                 │               │                │
  │  "extracted"}    │                  │                 │               │                │
  │←────────────────│                  │                 │               │                │
```

**Latency target:** < 60s for cold-start login (provider-dependent).

### 5.3 Sequence: MFA/OTP Negotiation During Auth

```
Worker Pod         OTP Relay       NATS           Slack/Teams Bot     Human Operator
  │                   │              │                  │                   │
  │ login DSL step:   │              │                  │                   │
  │ OTP field detected│              │                  │                   │
  │                   │              │                  │                   │
  │ publish:          │              │                  │                   │
  │ hitl.otp-requested│              │                  │                   │
  │──────────────────────────────────→                  │                   │
  │                   │              │                  │                   │
  │                   │              │ deliver event    │                   │
  │                   │              │─────────────────→│                   │
  │                   │              │                  │                   │
  │                   │              │                  │ "OTP needed for   │
  │                   │              │                  │  Salesforce       │
  │                   │              │                  │  (Acme Corp)"     │
  │                   │              │                  │──────────────────→│
  │                   │              │                  │                   │
  │                   │              │                  │                   │ enters OTP
  │                   │              │                  │                   │
  │                   │              │                  │ POST /sessions/   │
  │                   │              │                  │ {id}/otp          │
  │                   │              │                  │←──────────────────│
  │                   │              │                  │                   │
  │                   │ Redis SET     │                  │                   │
  │                   │ otp:{sid}     │                  │                   │
  │                   │←───────────────────────────────│                   │
  │                   │              │                  │                   │
  │ poll Redis        │              │                  │                   │
  │ (1s interval)     │              │                  │                   │
  │──────────────────→│              │                  │                   │
  │                   │              │                  │                   │
  │ OTP received      │              │                  │                   │
  │←──────────────────│              │                  │                   │
  │                   │              │                  │                   │
  │ fill OTP field    │              │                  │                   │
  │ continue login DSL│              │                  │                   │
  │                   │              │                  │                   │
  │ login SUCCESS     │              │                  │                   │
  │ → extract creds   │              │                  │                   │
```

### 5.4 Sequence: Proactive Re-Authentication (Keepalive Failure)

```
Worker Pod           Health Runner      Controller        NATS           API/Cache
  │                      │                  │               │               │
  │ keepalive cycle      │                  │               │               │
  │ (every 300s)         │                  │               │               │
  │                      │                  │               │               │
  │ execute health       │                  │               │               │
  │ predicates           │                  │               │               │
  │─────────────────────→│                  │               │               │
  │                      │                  │               │               │
  │ result: AUTH_FAIL    │                  │               │               │
  │ (401 on url_check    │                  │               │               │
  │  OR auth redirect    │                  │               │               │
  │  detected)           │                  │               │               │
  │←─────────────────────│                  │               │               │
  │                      │                  │               │               │
  │ state → UNHEALTHY    │                  │               │               │
  │──────────────────────────────────────────────────────→ │               │
  │                      │                  │               │               │
  │                      │                  │ reconcile:    │               │
  │                      │                  │ UNHEALTHY →   │               │
  │                      │                  │ LOGIN_NEEDED  │               │
  │                      │                  │ (after 2min)  │               │
  │                      │                  │               │               │
  │                      │                  │ trigger login │               │
  │                      │                  │ DSL re-exec   │               │
  │                      │                  │──────────────→│               │
  │                      │                  │               │               │
  │ re-execute login DSL │                  │               │               │
  │ (with stored creds)  │                  │               │               │
  │                      │                  │               │               │
  │ login SUCCESS        │                  │               │               │
  │ state → HEALTHY      │                  │               │               │
  │                      │                  │               │               │
  │ extract fresh creds  │                  │               │               │
  │ store artifact       │                  │               │               │
  │──────────────────────────────────────────────────────────────────────→ │
  │                      │                  │               │               │
  │                      │                  │               │ invalidate    │
  │                      │                  │               │ old cache     │
  │                      │                  │               │ entry         │
  │                      │                  │               │──────────────→│
```

### 5.5 Sequence: Concurrent Auth Requests (Request Coalescing)

```
Agent A              Agent B              API                    Worker Pod
  │                     │                  │                        │
  │ POST /auth/request  │                  │                        │
  │ {profile: SF}       │                  │                        │
  │────────────────────────────────────────→                        │
  │                     │                  │                        │
  │                     │                  │ cache MISS             │
  │                     │                  │ create auth_request    │
  │                     │                  │ record (IN_PROGRESS)   │
  │                     │                  │                        │
  │                     │                  │ trigger login          │
  │                     │                  │───────────────────────→│
  │                     │                  │                        │
  │                     │ POST /auth/request                       │
  │                     │ {profile: SF}    │                        │
  │                     │─────────────────→│                        │
  │                     │                  │                        │
  │                     │                  │ cache MISS             │
  │                     │                  │ BUT auth_request       │
  │                     │                  │ already IN_PROGRESS    │
  │                     │                  │                        │
  │                     │                  │ COALESCE: subscribe    │
  │                     │                  │ to same request        │
  │                     │                  │                        │
  │                     │                  │                  login │
  │                     │                  │                SUCCESS │
  │                     │                  │←───────────────────────│
  │                     │                  │                        │
  │ 200 OK {creds}      │                  │                        │
  │←───────────────────────────────────────│                        │
  │                     │                  │                        │
  │                     │ 200 OK {creds}   │                        │
  │                     │←─────────────────│                        │
```

**Key behavior:** The second request does NOT trigger a second login flow. It subscribes to the completion event of the already-in-progress request. This prevents login storms.

### 5.6 Sequence: Service Provider Unavailable — Re-establishment

```
Controller          Worker Pod (crashed)    K8s API          NATS           Alert Manager
  │                       ╳                   │                │                │
  │                                           │                │                │
  │ reconcile loop (15s)                      │                │                │
  │ detect: pod missing                       │                │                │
  │ for active session                        │                │                │
  │                                           │                │                │
  │ session state → FAILED                    │                │                │
  │──────────────────────────────────────────────────────────→│                │
  │                                           │                │                │
  │ retry count < MAX?                        │                │                │
  │ YES → session → STARTING                  │                │                │
  │                                           │                │                │
  │ provision new pod                         │                │                │
  │──────────────────────────────────────────→│                │                │
  │                                           │                │                │
  │                  ┌─────────────────┐      │                │                │
  │                  │ New Worker Pod   │      │                │                │
  │                  └────────┬────────┘      │                │                │
  │                           │               │                │                │
  │ trigger login DSL         │               │                │                │
  │──────────────────────────→│               │                │                │
  │                           │               │                │                │
  │                    login SUCCESS           │                │                │
  │                    state → HEALTHY         │                │                │
  │                           │               │                │                │
  │                                           │                │                │
  │ ── IF retry count >= MAX ──               │                │                │
  │                                           │                │                │
  │ circuit breaker: OPEN                     │                │                │
  │──────────────────────────────────────────────────────────→│                │
  │                                           │                │                │
  │                                           │                │ fire alert:    │
  │                                           │                │ service_       │
  │                                           │                │ unavailable    │
  │                                           │                │───────────────→│
  │                                           │                │                │
  │ incoming auth requests                    │                │                │
  │ during circuit break:                     │                │                │
  │ → 503 Service Unavailable                 │                │                │
  │   {retry_after: 300,                      │                │                │
  │    reason: "circuit_breaker_open",        │                │                │
  │    profile_id: "salesforce"}              │                │                │
```

---

## 6. Service Provider Onboarding

### 6.1 Onboarding Workflow (`WF-003`)

Adding a new target service (e.g., Salesforce) requires the following pipeline:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    SERVICE PROVIDER ONBOARDING PIPELINE                  │
│                                                                         │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐           │
│  │ 1. RECON │──→│ 2. RECORD│──→│ 3. BUILD │──→│ 4. TEST  │           │
│  │          │   │          │   │          │   │          │           │
│  │ Analyze  │   │ Capture  │   │ Create   │   │ Validate │           │
│  │ auth flow│   │ HAR file │   │ service  │   │ in       │           │
│  │ manually │   │ or manual│   │ profile  │   │ staging  │           │
│  └──────────┘   │ DSL write│   │ config   │   └────┬─────┘           │
│                 └──────────┘   └──────────┘        │                 │
│                                                     │                 │
│                                              ┌──────┴─────┐          │
│                                              │ 5. DEPLOY  │          │
│                                              │            │          │
│                                              │ Register   │          │
│                                              │ profile in │          │
│                                              │ production │          │
│                                              └────────────┘          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Step 1: Reconnaissance

A human administrator (or assisted by an AI agent) analyzes the target service's authentication flow:

| Analysis Item | Details | Example (Salesforce) |
|--------------|---------|---------------------|
| Login URL | Entry point for authentication | `https://login.salesforce.com` |
| Auth mechanism | Form-based, OAuth, SAML, SSO federation | Form-based with optional SSO redirect |
| MFA type(s) | TOTP, SMS, push notification, email, CAPTCHA, hardware key | Salesforce Authenticator (push) or TOTP |
| Redirect chain | How many domains are traversed during login | `login.salesforce.com` → corporate IdP → back to SF |
| Session indicators | How to detect an authenticated session | Presence of `sid` cookie; `/home` returns 200 |
| Session lifetime | How long before re-auth is needed | 2 hours (default), configurable per org |
| Anti-automation | CAPTCHAs, device fingerprinting, behavioral analysis | Lightning Login, device verification |
| Egress domains | All domains the browser must reach | `login.salesforce.com`, `*.salesforce.com`, `*.force.com` |

**Output:** Onboarding assessment document capturing the above. Stored as `docs/profiles/{provider}/ASSESSMENT.md`.

### 6.3 Step 2: Record & Build Login DSL

Two paths:

**Path A — HAR Recording:**
1. Record browser interactions as HAR file
2. Convert HAR to Login DSL steps (automated tooling, manual refinement)
3. Parameterize credentials: replace literal values with `${USERNAME}`, `${PASSWORD}`

**Path B — Manual DSL Authoring:**
1. Write Login DSL steps directly from reconnaissance analysis
2. Preferred for complex SSO federation chains where HAR is noisy

**Example Login DSL for Salesforce:**

```json
{
  "steps": [
    { "action": "goto", "url": "https://login.salesforce.com" },
    { "action": "fill", "selector": "#username", "value": "${USERNAME}" },
    { "action": "fill", "selector": "#password", "value": "${PASSWORD}", "sensitive": true },
    { "action": "click", "selector": "#Login" },
    { "action": "wait_for_url", "pattern": "**/lightning/**", "timeout_ms": 15000 },
    {
      "action": "wait_for",
      "selector": "#otp-input",
      "timeout_ms": 5000,
      "optional": true,
      "_comment": "MFA challenge detection — may or may not appear"
    },
    {
      "action": "fill",
      "selector": "#otp-input",
      "value": "${OTP}",
      "sensitive": true,
      "conditional": "element_visible",
      "_comment": "Only executes if OTP field is present"
    },
    {
      "action": "click",
      "selector": "#save",
      "conditional": "element_visible"
    },
    { "action": "wait_for", "selector": "#oneHeader", "timeout_ms": 10000 }
  ]
}
```

### 6.4 Step 3: Build Service Profile Configuration

```json
{
  "profile_id": "salesforce-standard",
  "display_name": "Salesforce (Standard Login)",
  "version": "1.0.0",
  "target": {
    "login_url": "https://login.salesforce.com",
    "egress_domains": [
      "login.salesforce.com",
      "*.salesforce.com",
      "*.force.com",
      "*.lightning.force.com"
    ]
  },
  "login_config": {
    "dsl_steps": "/* as above */",
    "credential_ref": "k8s:secret/salesforce-creds",
    "max_login_attempts_per_hour": 5,
    "login_timeout_ms": 60000
  },
  "mfa_config": {
    "strategy": "totp_or_hitl",
    "totp_field_selector": "#otp-input",
    "hitl_escalation_after_ms": 10000,
    "max_otp_wait_ms": 120000
  },
  "health_config": {
    "predicates": [
      {
        "type": "url_check",
        "url": "https://*.lightning.force.com/lightning/page/home",
        "expected_status": 200
      },
      {
        "type": "dom_check",
        "selector": "#oneHeader",
        "condition": "visible"
      }
    ],
    "policy": "all",
    "check_interval_ms": 300000
  },
  "keepalive_config": {
    "actions": [
      { "action": "goto", "url": "https://*.lightning.force.com/lightning/page/home" },
      { "action": "wait_for", "selector": "#oneHeader", "timeout_ms": 10000 }
    ],
    "interval_ms": 300000
  },
  "extraction_config": {
    "cookies": ["sid", "oid", "sfdc-stream"],
    "headers": ["Authorization"],
    "csrf": {
      "type": "meta_tag",
      "selector": "meta[name='_csrf']",
      "attribute": "content"
    },
    "include_local_storage": false,
    "include_session_storage": false
  },
  "export_policy": {
    "auth_ttl_seconds": 3600,
    "refresh_interval_seconds": 1800,
    "push_to_secret_store": false,
    "secret_store_path": "secret/data/browser-hitl/{tenant_id}/salesforce"
  }
}
```

### 6.5 Step 4: Validation in Staging

| Test | Pass Criteria |
|------|--------------|
| Login DSL executes without errors | Session reaches HEALTHY state |
| MFA negotiation works | OTP relay completes within timeout |
| Health predicates pass after login | All predicates return PASS |
| Keepalive maintains session | Session remains HEALTHY for 2× keepalive interval |
| Credential extraction returns expected artifacts | cookies, headers, and/or CSRF token present |
| Re-authentication after forced logout | Session recovers to HEALTHY after simulated auth failure |
| Concurrent agent requests are coalesced | Second request does not trigger second login |
| Container crash recovery | Controller re-provisions pod and re-establishes session |

### 6.6 Step 5: Deploy & Register

1. Register service profile via `POST /admin/service-profiles`
2. Store credentials in K8s Secret (`salesforce-creds-{tenant_id}`)
3. Configure egress allowlist for the profile's target domains
4. Controller reconcile loop picks up new profile and provisions session on demand

---

## 7. Credential Lifecycle Management

### 7.1 Credential States

```
┌────────────┐     ┌────────────┐     ┌────────────┐     ┌────────────┐
│  ABSENT    │────→│ EXTRACTING │────→│   FRESH    │────→│   STALE    │
│            │     │            │     │            │     │            │
│ No creds   │     │ Login in   │     │ age <      │     │ age >=     │
│ exist yet  │     │ progress   │     │ auth_ttl   │     │ auth_ttl   │
└────────────┘     └────────────┘     └──────┬─────┘     └──────┬─────┘
                                             │                   │
                                             │                   │ re-auth
                                             │                   │ triggers
                                             │                   ↓
                                             │            ┌────────────┐
                                             └───────────→│ REFRESHING │
                                                          │            │
                                                          │ Re-extract │
                                                          │ in progress│
                                                          └────────────┘
```

### 7.2 Freshness Determination

| Signal | Weight | Description |
|--------|--------|-------------|
| `extracted_at` + `auth_ttl` | Primary | Time-based TTL from service profile configuration |
| Health predicate result | Override | AUTH_FAIL immediately invalidates regardless of TTL |
| Session state | Override | Session not in HEALTHY state → credentials untrusted |
| Manual invalidation | Override | Admin can force-invalidate via API |

### 7.3 Credential Cache Architecture

```
┌───────────────────────────────────────────────────────┐
│                   Credential Cache                     │
│                                                       │
│  Key: {tenant_id}:{profile_id}:{credential_set_id}   │
│                                                       │
│  Value: {                                             │
│    cookies: [...],                                    │
│    headers: {...},                                    │
│    csrf_token: "...",                                 │
│    extracted_at: ISO8601,                             │
│    expires_at: ISO8601,                               │
│    session_id: UUID,                                  │
│    artifact_bundle_id: UUID,                          │
│    freshness: "fresh" | "stale" | "extracting"        │
│  }                                                    │
│                                                       │
│  Storage: Redis (encrypted at rest)                   │
│  TTL: auth_ttl + grace_period (60s)                   │
└───────────────────────────────────────────────────────┘
```

### 7.4 Proactive vs Reactive Refresh

| Strategy | Trigger | Behavior |
|----------|---------|----------|
| **Proactive** | `extracted_at + (auth_ttl × 0.8)` elapsed | Re-extract credentials before expiry. Agents never see stale creds. |
| **Reactive** | Agent requests creds, TTL expired | Trigger re-extraction on demand. Agent waits for fresh creds. |
| **Forced** | Health predicate AUTH_FAIL | Immediate re-authentication regardless of TTL |

> **Recommendation:** Proactive refresh as default (80% TTL threshold). Reactive as fallback. Forced on auth failure.

---

## 8. Failure Modes & Recovery

### 8.1 Failure Taxonomy

| ID | Failure | Detection | Impact | Recovery | Escalation |
|----|---------|-----------|--------|----------|------------|
| `F-001` | Worker pod crash/OOM | K8s liveness probe / Controller reconcile detects missing pod | Session lost; credentials stale | Controller re-provisions pod; re-login | After 3 failures → circuit breaker |
| `F-002` | Login DSL fails (site changed) | Login DSL step throws; session → FAILED | Cannot authenticate | Retry with backoff; after MAX retries → alert for DSL update | Human: update Login DSL |
| `F-003` | MFA timeout (no human response) | OTP relay timeout (120s) | Login stalled | Retry login (MFA may not re-prompt); re-escalate if needed | After 3 MFA timeouts → alert |
| `F-004` | Target service outage | Health predicates all TRANSIENT_FAIL | Cannot verify health; cannot re-auth | Maintain last-known-good creds; mark as `degraded` | Alert after 5min continuous failure |
| `F-005` | Secret store unavailable | Push to Vault fails; API response still works | Push-model consumers cannot get fresh creds | Queue pushes; retry with backoff | Alert; pull-model unaffected |
| `F-006` | Anti-bot detection (CAPTCHA) | Login DSL encounters unknown element / redirect | Cannot automate login | HITL escalation: human solves CAPTCHA via VNC | If frequent → assess provider profile |
| `F-007` | Credential set invalid (password changed) | Login DSL: wrong credentials error | Cannot authenticate at all | Alert admin; mark profile as `credential_invalid` | Human: update K8s Secret |
| `F-008` | Network partition (pod ↔ services) | Health server unreachable; NATS disconnect | Worker isolated | K8s restarts pod (liveness failure); Controller reconciles | If persistent → check NetworkPolicy / CNI |
| `F-009` | Concurrent login storm | Multiple agents trigger simultaneous auth requests | Wasted resources; potential account lockout on target service | Request coalescing (§5.5); debounce at API layer | Never allow parallel logins for same credential set |
| `F-010` | Session recycling race | Container terminated during active credential extraction | Partial credential set | Atomic extraction: all-or-nothing; retry on new session | None needed if atomic |

### 8.2 Circuit Breaker Configuration

| Level | Failure Threshold | Window | Cooldown | Behavior |
|-------|-------------------|--------|----------|----------|
| Credential-set | 3 login failures | 15 min | 5 min | Stop login attempts; serve 503 |
| Service Profile (all cred-sets) | 5 failures across all cred-sets | 15 min | 10 min | Pause all sessions for profile |
| Organization | 15 failures across all profiles | 15 min | 15 min | Alert; all new auth requests → 503 |

### 8.3 Degraded Mode

When a session enters a failure state but last-known-good credentials exist:

```
Agent                 API                Cache
  │                    │                   │
  │ POST /auth/request │                   │
  │───────────────────→│                   │
  │                    │                   │
  │                    │ session: FAILED   │
  │                    │ circuit: OPEN     │
  │                    │                   │
  │                    │ check cache       │
  │                    │──────────────────→│
  │                    │                   │
  │                    │ HIT (stale, but   │
  │                    │ exists)           │
  │                    │←──────────────────│
  │                    │                   │
  │ 200 OK             │                   │
  │ {creds,            │                   │
  │  freshness: "degraded",               │
  │  warning: "session unhealthy, creds may be expired",
  │  extracted_at: ...,│                   │
  │  session_state: "FAILED"}             │
  │←───────────────────│                   │
```

> **Policy decision:** Should degraded credentials be served at all? The agent can decide. The response includes `freshness: "degraded"` and the original `extracted_at` timestamp. Some agents may accept stale creds for read-only operations.

---

## 9. Orchestration & Ensemble Management

### 9.1 Ensemble Definition

An **ensemble** is the complete set of active service sessions for an organization. For example, Acme Corp's ensemble might be:

| # | Service Profile | Credential Set | Session State | Container |
|---|----------------|----------------|---------------|-----------|
| 1 | Salesforce | svc-account@acme | HEALTHY | `worker-sf-acme-001` |
| 2 | Siebel | api-user@acme | HEALTHY | `worker-siebel-acme-001` |
| 3 | ServiceNow | integration@acme | LOGIN_IN_PROGRESS | `worker-snow-acme-001` |
| 4 | SAP | rfc-user@acme | FAILED (circuit open) | `worker-sap-acme-001` |

### 9.2 Ensemble Lifecycle

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ PROVISIONING │────→│   HEALTHY    │────→│  DEGRADED    │
│              │     │              │     │              │
│ ≥1 session   │     │ All sessions │     │ ≥1 session   │
│ starting     │     │ HEALTHY      │     │ not HEALTHY  │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
                                           ┌──────┴───────┐
                                           │  CRITICAL    │
                                           │              │
                                           │ >50% sessions│
                                           │ FAILED       │
                                           └──────────────┘
```

### 9.3 Ensemble Reconciliation

The Controller already runs a reconcile loop every 15 seconds. For the Headless Auth Provider, extend it:

1. **Desired State:** For each org, for each registered service profile with `auto_provision: true`, ensure a session exists
2. **Drift Detection:** If a session is missing (pod deleted externally), re-provision
3. **Demand-Driven Provisioning:** If `auto_provision: false`, provision only on first auth request (lazy startup)
4. **Resource Quotas:** Enforce per-org session limits (`max_sessions` on TenantEntity)
5. **Priority Ordering:** If at quota, prioritize sessions by last-access time (evict least-recently-used)

### 9.4 Session Demand Patterns

| Pattern | Description | Provisioning Strategy |
|---------|-------------|----------------------|
| **Always-On** | Session must be ready 24/7 (e.g., Salesforce for a busy team) | `auto_provision: true`, keepalive active |
| **On-Demand** | Session spun up only when agent needs it | `auto_provision: false`, provision on first request, terminate after idle timeout |
| **Scheduled** | Session needed during business hours only | CronJob to scale up/down; save resources off-hours |

---

## 10. Security Architecture

### 10.1 Threat Model

| Threat | Vector | Mitigation |
|--------|--------|------------|
| Credential leakage from worker pod | Pod compromise, memory dump | Container isolation; no credential persistence on disk; securityContext runAsNonRoot; read-only rootfs where possible |
| Cross-org credential access | API bug, NATS subject injection | Tenant ID in all queries; NATS ACL per tenant; artifact encryption with per-tenant key |
| Stolen auth response | Network sniff, MITM | TLS everywhere; response encryption in transit; short-lived credential tokens |
| Replay of exported credentials | Intercepted artifact token | Single-use tokens (Redis CAS); TTL enforcement; consumption audit |
| Account lockout on target service | Excessive login retries | Rate limiting: max_login_attempts_per_hour per credential set; circuit breaker |
| Insider credential theft | Admin queries credential cache | Audit log for all credential access; no plaintext in logs; decrypt only at point of delivery |
| Worker pod lateral movement | Compromised pod scans network | NetworkPolicy deny-all default; explicit egress allowlist per service profile; no inter-pod communication |
| Secret store compromise | Vault/K8s Secret breach | Per-tenant encryption keys; key rotation support; audit trail on secret access |

### 10.2 Credential Transport Security

```
Worker Pod                    API                       Agent
  │                            │                          │
  │ 1. Extract credentials     │                          │
  │    from browser context    │                          │
  │                            │                          │
  │ 2. Encrypt with            │                          │
  │    AES-256-GCM             │                          │
  │    (per-tenant key)        │                          │
  │                            │                          │
  │ 3. Store in MinIO          │                          │
  │    (encrypted blob)        │                          │
  │──────────────────────────→ │                          │
  │                            │                          │
  │                            │ 4. On auth request:      │
  │                            │    fetch from MinIO      │
  │                            │    decrypt with          │
  │                            │    tenant key            │
  │                            │                          │
  │                            │ 5. Re-encrypt for        │
  │                            │    transport (TLS)       │
  │                            │    include in response   │
  │                            │    body                  │
  │                            │─────────────────────────→│
  │                            │                          │
  │                            │ 6. Audit: credential     │
  │                            │    served to agent       │
  │                            │    {agent_id, profile,   │
  │                            │     timestamp}           │
```

### 10.3 Audit Events for Auth Provider

| Event | Logged Fields | Retention |
|-------|--------------|-----------|
| `auth.request.received` | agent_id, tenant_id, profile_id, timestamp | 90 days |
| `auth.credential.served` | agent_id, tenant_id, profile_id, freshness, extracted_at | 90 days |
| `auth.credential.served_degraded` | agent_id, tenant_id, profile_id, warning, session_state | 90 days |
| `auth.login.started` | tenant_id, profile_id, credential_set_id, trigger (demand/proactive/forced) | 90 days |
| `auth.login.completed` | tenant_id, profile_id, outcome (success/failure), duration_ms | 90 days |
| `auth.login.mfa_escalated` | tenant_id, profile_id, mfa_type, escalation_channel | 90 days |
| `auth.credential.refreshed` | tenant_id, profile_id, previous_extracted_at, new_extracted_at | 90 days |
| `auth.circuit_breaker.opened` | tenant_id, profile_id, failure_count, cooldown_until | 90 days |
| `auth.session.recovered` | tenant_id, profile_id, previous_failure, recovery_duration_ms | 90 days |

### 10.4 Target Service Account Lockout Prevention

This is a critical safety concern. Aggressive retries can lock out the service account on the target platform.

| Control | Implementation |
|---------|----------------|
| **Per-credential rate limit** | `max_login_attempts_per_hour: 5` (configurable per profile) |
| **Backoff** | Exponential: 30s, 60s, 120s, 240s, 480s between attempts |
| **Circuit breaker** | After 3 consecutive failures → stop all login attempts for 5 minutes |
| **Credential validation** | Pre-check: if credentials known-invalid (password changed), don't attempt login |
| **Lockout detection** | If target service returns lockout indicator (HTTP 429, specific error page), immediately stop and alert |
| **Cross-session coordination** | If multiple credential sets for same target, share rate limit budget |

---

## 11. Tenancy & Isolation Model

### 11.1 Organization Isolation Tiers

| Tier | Isolation Level | Infrastructure | Use Case |
|------|----------------|----------------|----------|
| **Standard** | K8s Namespace | Shared cluster, dedicated namespace per org | Most organizations |
| **Enhanced** | K8s Namespace + dedicated node pool | Shared cluster, org pods scheduled on dedicated nodes | Organizations with compliance requirements |
| **Dedicated** | Dedicated K8s Cluster | Full cluster per org | Regulated industries, large enterprises |

### 11.2 Namespace Architecture (Standard Tier)

```
K8s Cluster
├── namespace: browser-hitl-system
│   ├── API (shared, multi-tenant)
│   ├── Controller (shared, multi-tenant)
│   ├── PostgreSQL (shared, RLS isolation)
│   ├── Redis (shared, key-prefix isolation)
│   ├── NATS (shared, ACL isolation)
│   └── MinIO (shared, bucket-per-tenant)
│
├── namespace: browser-hitl-acme
│   ├── worker-salesforce-acme-001
│   ├── worker-siebel-acme-001
│   ├── worker-servicenow-acme-001
│   ├── NetworkPolicies (per-pod egress allowlist)
│   └── Secrets (credential sets, encryption keys)
│
├── namespace: browser-hitl-globex
│   ├── worker-salesforce-globex-001
│   ├── worker-sap-globex-001
│   ├── NetworkPolicies
│   └── Secrets
│
└── namespace: browser-hitl-initech
    ├── worker-salesforce-initech-001
    └── ...
```

### 11.3 Cross-Namespace Networking

Worker pods in tenant namespaces need to reach shared services in `browser-hitl-system`:

| Source | Destination | Protocol | Purpose |
|--------|------------|----------|---------|
| Worker | PostgreSQL | TCP 5432 | Read app config, write health status |
| Worker | Redis | TCP 6379 | OTP relay, credential cache |
| Worker | NATS | TCP 4222 | Event publishing |
| Worker | MinIO | TCP 9000 | Artifact storage |
| Worker | Egress Proxy | TCP 3128 | Target service access |
| Controller | Worker | TCP 8091 | Health probes |

All cross-namespace traffic governed by NetworkPolicies. Default deny; explicit allow per the table above.

### 11.4 Resource Quotas

Each tenant namespace enforces:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-quota
  namespace: browser-hitl-{tenant}
spec:
  hard:
    pods: "20"                    # max 20 concurrent sessions
    requests.cpu: "20"            # 20 vCPU total
    requests.memory: "40Gi"       # 40 GiB total
    limits.cpu: "40"
    limits.memory: "60Gi"
    persistentvolumeclaims: "0"   # no PVCs in tenant namespace
```

### 11.5 Dedicated Cluster Tier

For organizations requiring dedicated infrastructure:

```
Dedicated K8s Cluster (per org)
├── namespace: browser-hitl-system
│   ├── API (single-tenant)
│   ├── Controller (single-tenant)
│   ├── PostgreSQL (dedicated)
│   ├── Redis (dedicated)
│   ├── NATS (dedicated)
│   └── MinIO (dedicated)
│
└── namespace: browser-hitl-workers
    ├── worker-salesforce-001
    ├── worker-siebel-001
    └── ...
```

Provisioned via Terraform/Pulumi. Cluster lifecycle managed by platform team.

---

## 12. Open Questions & Architectural Decisions

> **Status:** All architectural decisions have been resolved and accepted. See `docs/ARCHITECTURE_DECISIONS.md` for the full ADR records.

### 12.1 Decisions — Resolved

| ID | Question | Resolution | ADR |
|----|----------|-----------|-----|
| `AD-001` | Per-user vs per-service-account auth? | **Service account model.** One session per service per org. | ADR-001 (ACCEPTED) |
| `AD-002` | Credential delivery: sync vs async? | **Synchronous pull (v1)** with 7-stage pipeline, subscriber wait pattern. Secret store push committed for v2. | ADR-006 (ACCEPTED), ADR-009 (ACCEPTED) |
| `AD-003` | Conditional DSL steps for MFA? | **Conditional field on DSL steps** with recovery blocks and error classification. | ADR-005 (ACCEPTED) |
| `AD-004` | Standard vs Dedicated cluster? | **Namespace-per-org (Standard)** as default, Dedicated for SOC2/HIPAA/PCI. 3-tier model. | ADR-008 (ACCEPTED) |
| `AD-005` | Secret store integration? | **API-only (v1).** Secret store push is v2 critical requirement with `CredentialPublisher` interface. | ADR-009 (ACCEPTED) |
| `AD-006` | Proactive refresh threshold? | **80% of auth_ttl**, configurable per service profile. Credential volatility model (stable/semi-stable/volatile). | ADR-007 (ACCEPTED), ADR-013 (ACCEPTED) |

### 12.1.1 Additional Decisions (from Gap Analysis)

| Gap | Decision | ADR |
|-----|----------|-----|
| Agent authentication | OAuth 2.0 Client Credentials with per-agent scoping | ADR-010 (ACCEPTED) |
| Redis SPOF | Tiered failure modes: SECURITY/CONSISTENCY/AVAILABILITY | ADR-011 (ACCEPTED) |
| Login serialization | Three-barrier defense-in-depth (Redis lock + PG row lock + worker rate guard) | ADR-012 (ACCEPTED) |
| Credential response schema | Standardized envelope with volatility model and force_refresh coalescing | ADR-013 (ACCEPTED) |
| Profile versioning | Staging → Canary → Active pipeline with minimum traffic threshold | ADR-014 (ACCEPTED) |
| Login coordination | PG-backed global login queue with per-domain rate limits and PG LISTEN/NOTIFY | ADR-015 (ACCEPTED) |
| Worker pod security | Mandatory security baseline (readOnlyRootFilesystem, drop ALL, seccomp, /dev/shm) | ADR-016 (ACCEPTED) |
| Extraction atomicity | All-or-nothing extraction + independent liveness heartbeat | ADR-017 (ACCEPTED) |
| Log sanitization | URL redaction, PII hashing, error scrubbing at logger level | ADR-018 (ACCEPTED) |
| Backup/DR | RPO/RTO per data store, Redis ephemeral-by-design, PG hourly backups | ADR-019 (ACCEPTED) |
| Observability | X-Request-Id propagation, stage-level metrics, Grafana dashboard spec | ADR-020 (ACCEPTED) |

### 12.2 Known Gotchas

| ID | Gotcha | Severity | Mitigation | Addressed By |
|----|--------|----------|------------|-------------|
| `G-001` | **SSO federation chains span multiple domains.** Login DSL must handle redirects across corporate IdPs (Okta, Azure AD, Ping). The browser follows redirects natively, but the egress allowlist must include ALL domains in the chain. | HIGH | Reconnaissance step (§6.2) must map the full redirect chain. Egress allowlist must be comprehensive. | ADR-003 |
| `G-002` | **Anti-bot detection is increasing.** Enterprise services use CAPTCHAs, device fingerprinting, and behavioral analysis. Headless Chrome is detectable. | HIGH | Use `--disable-blink-features=AutomationControlled`; set realistic user-agent; add human-like timing jitter to DSL steps. For CAPTCHAs: HITL escalation is the fallback. Monitor for increasing CAPTCHA frequency. | ADR-004 |
| `G-003` | **Session cookie scoping.** Some services issue cookies scoped to specific paths or subdomains. Extraction must capture the full cookie jar, not just top-level cookies. | MEDIUM | Playwright's `context.cookies()` returns all cookies for the browser context. Filter by domain allowlist from profile config. | ADR-013 |
| `G-004` | **CSRF tokens rotate on every page load.** Cached CSRF tokens may be invalid by the time the agent uses them. | MEDIUM | Volatile credentials never cached. force_refresh with coalescing. Agent re-requests on rejection. | ADR-013 (volatility model) |
| `G-005` | **Target service rate limits.** Some services rate-limit login attempts at the IP level, not just account level. Multiple orgs sharing an egress proxy could collectively trigger IP-based rate limits. | MEDIUM | Global login coordinator with per-domain rate limits. Cross-org coordination via PG-backed login queue. | ADR-012, ADR-015 |
| `G-006` | **Browser memory leaks over long sessions.** Chromium can leak memory in long-running sessions (hours/days). | LOW | Existing: session recycling at `MAX_SESSION_AGE_HOURS` (24h) and `MEMORY_WATERMARK_GB` (2.5GB). Sufficient for auth provider use case. | Existing code |
| `G-007` | **Time-zone and locale sensitivity.** Some login flows display locale-specific elements (date pickers, CAPTCHA in local language). Worker pod locale must match expectations. | LOW | Set `TZ` and `LANG` env vars in worker pod spec. Add `locale` to service profile config. | Service profile config |
| `G-008` | **Credential rotation coordination.** When a service account password is rotated in the target service, the K8s Secret must be updated and the session must re-authenticate. No automatic detection. | MEDIUM | Detect repeated credential-failure events. Alert admin. Future: integrate with credential rotation tools (CyberArk, etc.). | ADR-017 (health detection) |

---

## 13. Appendix: Glossary

| Term | Definition |
|------|-----------|
| **Agent** | An AI or automation system that consumes browser-action APIs on behalf of users |
| **Auth Request** | A request from an agent to obtain authentication credentials for a target service |
| **Baton** | The HITL control mechanism that transfers authority between automation and human operators |
| **Credential Set** | A username/password pair (and optionally MFA seed) used to authenticate to a target service |
| **Ensemble** | The complete set of active service sessions for an organization |
| **Freshness** | The age-based validity status of cached credentials (fresh, stale, degraded) |
| **Health Predicate** | A check that validates whether a browser session is still authenticated |
| **HITL** | Human-In-The-Loop — the process of involving a human operator for challenges automation cannot solve |
| **Keepalive** | Periodic browser actions that prevent session timeout on the target service |
| **Login DSL** | A declarative sequence of browser actions that performs authentication on a target service |
| **MFA** | Multi-Factor Authentication — additional verification beyond username/password |
| **Organization** | The top-level tenant entity; an enterprise customer. The principal security boundary. |
| **OTP** | One-Time Password — a time-limited code used for MFA |
| **Request Coalescing** | Combining multiple concurrent auth requests for the same credential set into a single login flow |
| **Service Profile** | A complete configuration for authenticating to a specific target service (Salesforce, Siebel, etc.) |
| **Worker Pod** | An isolated Kubernetes pod running a headless browser (Playwright + Chromium + Xvfb + noVNC) |
| **Workflow** | A canonical interaction pattern supported by the system (e.g., Headless Auth Provider, Slack OTP PoC) |

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1.0-draft | 2026-02-21 | Solution Architecture | Initial draft |
| 0.2.0-draft | 2026-02-21 | Solution Architecture | Resolved all open decisions (AD-001→AD-006) via ADRs. Gap analysis complete (14 gaps, all resolved). Cross-referenced ADR-010 through ADR-020. |
