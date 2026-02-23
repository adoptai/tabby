# MVP Ticketized Sprint Plan

**Scope:** Browser HITL MVP
**Sprint length:** 2 weeks
**Date:** 2026-02-18 (v3 — final verification pass)
**Sprints:** 4 sprints (8 weeks total, includes buffer)
**Spec Reference:** `MVP_BROWSER_SPEC_CODEX.md` v6

---

## Sprint 1: Test Harness + Foundations + Data + Auth + API Skeleton

| Ticket | Task # | Description | Acceptance Criteria |
|---|---|---|---|
| S1-1 | 1 | **Build test harness app** | Login, OTP (123456), logout, protected page, /api/me, containerized. MUST BE FIRST. |
| S1-2 | 2 | Monorepo scaffold (pnpm + NX) | apps/, packages/shared, charts/, infra/, test-harness/ directories; build scripts run |
| S1-3 | 3-6 | Shared types, DSL validator, health types, StreamProvider interface | All 15 DSL actions typed and validated; health result types; BrowserStreamProvider interface |
| S1-4 | 9 | Postgres schema + TypeORM migrations | All 10 tables created; migrations run on startup with advisory lock |
| S1-5 | 10-11 | Admin auth + JWT + RBAC | /login returns JWT; bcrypt cost 12; RBAC guards on all endpoints; tenant scoping |
| S1-6 | 12 | Bootstrap flow | First-startup creates tenant + admin + MinIO bucket + encryption key; idempotent |
| S1-7 | 13-16 | Tenant/user/app/session CRUD APIs | All endpoints with pagination, validation, RBAC |
| S1-8 | 18-19 | HITL API + error format + rate limits | stream/takeover/release/otp/acknowledge endpoints; standard error format; rate limits |
| S1-9 | 8 | Cluster defaults + sizing docs | Bootstrap checklist, sizing table, encryption-at-rest verification |

---

## Sprint 2: Controller + Worker Core

| Ticket | Task # | Description | Acceptance Criteria |
|---|---|---|---|
| S2-1 | 21-22 | Controller reconcile loop + state machine | All 11 transitions (section 9.1); reads desired count; creates/terminates pods |
| S2-2 | 23-24 | Health status reading + backoff/retry | Reads health_result_type; distinguishes transient vs auth; retry matrix enforced |
| S2-3 | 25-26 | HITL triggers + failure acknowledgement | Publishes to NATS on LOGIN_NEEDED; acknowledge flow respects hitl_pause_until gate before FAILED->STARTING |
| S2-4 | 29 | Worker container build | Dockerfile, startup sequence (Xvfb, x11vnc, Playwright), lock cleanup |
| S2-5 | 30-31 | Login DSL runner + OTP relay | All 15 DSL actions; frame/popup context; OTP polling from Redis |
| S2-6 | 32-33 | Keepalive + health predicates | Time-sliced execution; url_check via HTTP client; dom_check; all result types |
| S2-7 | 37 | Worker health HTTP server | GET /health, GET /status on :8091 |
| S2-8 | 17, 20 | Artifact access API + WebSocket events | Presigned URL generation; artifact_consumptions; WS /events with NATS relay |

---

## Sprint 3: Streaming + Bots + Artifact Pipeline

| Ticket | Task # | Description | Acceptance Criteria |
|---|---|---|---|
| S3-1 | 40-41 | VncStreamProvider + noVNC sidecar | Implements BrowserStreamProvider; sidecar container built; stream reachable |
| S3-2 | 42-43 | Stream token generation + single-use | JWT with jti; Redis Lua CAS (issued->consumed); fail-closed |
| S3-3 | 44 | Viewer UX controls | Release button, timer, focus indicator, screenshot fallback display |
| S3-4 | 45 | **Slack bot HITL** | @slack/bolt; HITL request, OTP capture → Redis, release, human notes |
| S3-5 | 46 | **Teams bot HITL** | botbuilder; same flow as Slack |
| S3-6 | 34-36 | Artifact extraction + encryption + MinIO upload | cookies/headers/storage captured; AES-GCM with nonce; MinIO write |
| S3-7 | 50-52 | MinIO provisioning + NATS export + ACLs | Bucket per tenant; lifecycle rules; NATS publish; ACL isolation |
| S3-8 | 54 | Presigned URL single-use enforcement | Redis tracks consumption; replay rejected |
| S3-9 | 39 | Screenshot fallback mode | Degrades when VNC <1 FPS; captures screenshots at 2s interval |

---

## Sprint 4: Observability + Compliance + Network Policies + Tests + UAT

| Ticket | Task # | Description | Acceptance Criteria |
|---|---|---|---|
| S4-1 | 55-57 | Audit hash chain + anchors + verification | Serialized writes via advisory lock; daily anchors; verification job |
| S4-2 | 58 | Metrics + traces | OTel auto-instrumentation; manual spans; Prometheus metrics |
| S4-3 | 27 | NetworkPolicy generation | Deny-all + allowlist per pod; created/deleted with pod lifecycle |
| S4-4 | 28, 38 | Session recycling | Max age + memory watermark triggers; graceful recycle flow |
| S4-5 | 51 | Artifact expiration CronJob | Runs every 15 min; deletes expired objects; sub-day TTL |
| S4-6 | 60-63 | Helm charts + SBOM + CI/CD | Charts for all services; Syft + cosign; GitHub Actions pipeline |
| S4-7 | 64-66 | Unit + integration tests | State machines, DSL, health predicates, OTP relay, single-use tokens; pass in CI |
| S4-8 | 67 | E2E HITL test | Passes 5 consecutive times against test harness |
| S4-9 | 68-69 | Manual UAT + acceptance | All 8 UAT flows pass; written sign-off |

---

## Sprint Sizing Notes

- **Sprint 1:** Foundation-heavy. Mostly scaffolding, schema, and CRUD. Lower risk.
- **Sprint 2:** Core complexity. State machine + worker are the hardest components. Highest risk sprint.
- **Sprint 3:** Integration-heavy. VNC + bots + artifact pipeline. Second highest risk.
- **Sprint 4:** Polish + compliance + testing. Includes buffer for Sprint 2/3 overflow.

**Buffer strategy:** Sprint 4 intentionally includes both new work (observability, compliance) and testing. If Sprint 2 or 3 overflow, testing from Sprint 4 absorbs the slack. Add a Sprint 5 (1 week) if needed for remaining UAT.
