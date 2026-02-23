# Test Execution Playbook

Validation playbook for Browser HITL covering unit tests, integration tests, and E2E scenarios.

## 1. Test Levels

| Level | Scope | Tools | Tests |
|-------|-------|-------|-------|
| **L0: Static** | Type checking, linting | `tsc --noEmit`, husky pre-commit | All `.ts` files |
| **L1: Unit** | Service logic, guards, validators | Jest, source verification | 385 tests |
| **L2: Integration** | Module interactions, DB queries | Jest + mocks | Included in L1 |
| **L3: E2E Smoke** | API health, auth flow, session CRUD | `scripts/e2e-smoke.sh` | CI pipeline |
| **L4: E2E Batch** | Full workflow scenarios | Python scripts, kubectl | 4 batches |
| **L5: Agent** | `/agent/run-url` endpoint | curl, automation scripts | Manual |

## 2. Unit Tests (L1)

### Running

```bash
# All packages (385 tests, ~15s)
pnpm nx run-many --target=test --all --parallel=3

# Individual packages
pnpm --filter @browser-hitl/shared test     # 78 tests
pnpm --filter @browser-hitl/api test        # 230 tests
pnpm --filter @browser-hitl/controller test # 50 tests
pnpm --filter @browser-hitl/worker test     # 27 tests

# Specific test file
cd apps/api && npx jest account-lockout
cd apps/api && npx jest critical-services
```

### Test Suites by Package

#### `@browser-hitl/shared` (4 suites, 78 tests)
| Suite | Focus |
|-------|-------|
| `state-machine.spec.ts` | Session + baton state transitions, retry matrix |
| `dsl.validator.spec.ts` | DSL step validation, variable interpolation |
| `env.spec.ts` | Environment validation, batch errors, defaults, patterns |
| `health.types.spec.ts` | Health policy evaluation (all/any/quorum) |

#### `@browser-hitl/api` (17 suites, 230 tests)
| Suite | Focus |
|-------|-------|
| `auth.service.spec.ts` | Login, JWT generation, password validation |
| `account-lockout.spec.ts` | Lockout threshold, timing, password complexity (18 tests) |
| `token-blacklist.service.spec.ts` | Redis blacklist, TTL, revocation, fail-open |
| `bot-credential-fallback.spec.ts` | No admin fallback, service creds required (12 tests) |
| `apps-dto.spec.ts` | DTO validation, partial updates, injection prevention (20 tests) |
| `metrics-auth.spec.ts` | Bearer token auth, timing-safe, open-when-unset (9 tests) |
| `security-headers.spec.ts` | Helmet, CORS, trust proxy source verification |
| `health.spec.ts` | Health endpoints, shutdown, error boundary, probes (10 tests) |
| `infra-scaffolding.spec.ts` | Helm values, network policies, configs (20 tests) |
| `observability-phase5.spec.ts` | prom-client, JSON logger, alerting rules (25 tests) |
| `critical-services.spec.ts` | RolesGuard, ThrottlerGuard, HitlService, HitlController (41 tests) |
| `stream-token.service.spec.ts` | Stream token generation, validation |
| `vnc-ws-proxy.service.spec.ts` | WebSocket proxy setup |
| `artifact-pipeline.integration.spec.ts` | Encryption, MinIO upload, presigned URLs |
| `audit-chain.integration.spec.ts` | Hash chain integrity, anchors |
| `agent.service.spec.ts` | Agent endpoint validation |
| `lifecycle-retention.service.spec.ts` | Retention policy enforcement |

#### `@browser-hitl/controller` (3 suites, 50 tests)
| Suite | Focus |
|-------|-------|
| `pod-manager.service.spec.ts` | Pod creation, deletion, status |
| `reconcile.service.spec.ts` | Desired vs actual reconciliation |
| `state-machine.service.spec.ts` | State transition orchestration |

#### `@browser-hitl/worker` (2 suites, 27 tests)
| Suite | Focus |
|-------|-------|
| `login-dsl-runner.spec.ts` | DSL execution, variable interpolation |
| `otp-relay.spec.ts` | OTP delivery and timeout |

### Security Test Categories

The test suite includes adversarial tests that **fail if the security fix is reverted**:

- **Token revocation**: Blacklisted tokens rejected, TTL expiry, Redis failure handling
- **Account lockout**: Lockout at threshold, rejection during lock, auto-recovery
- **Password complexity**: Rejects weak patterns (no uppercase, no digit, too short, etc.)
- **Input validation**: Non-whitelisted fields stripped, injection payloads rejected
- **Credential fallback**: Admin email/password removed from bot bridge
- **Metrics auth**: Wrong/missing/malformed tokens rejected, timing-safe comparison
- **Infrastructure**: Network policies exist, production values differ from local

## 3. E2E Batches (L4)

### Prerequisites

```bash
# Local cluster with all services deployed
kind create cluster --name browser-hitl
# ... build, load, helm install (see RUNBOOK.md section 2)

# Port-forward API
kubectl -n browser-hitl port-forward svc/browser-hitl-api 8080:8080 &
```

### Batch A: Stream, Replay, Takeover

```bash
API_URL=http://localhost:8080 \
ADMIN_EMAIL=admin@browser-hitl.local \
ADMIN_PASSWORD="YOUR_PASSWORD" \
python3 scripts/e2e_batch_a.py
```

Covers: login, session creation, stream URL, takeover, release, OTP submission.

### Batch B: Egress Proxy

```bash
python3 scripts/e2e_batch_b_egress.py
```

Covers: FQDN allowlist enforcement, blocked domain rejection.

### Batch C: In-Cluster

```bash
python3 scripts/e2e_batch_c_incluster.py
```

Covers: Pod creation, NATS event propagation, session state transitions.

### Batch D: Data Plane + UAT

```bash
python3 scripts/e2e_batch_d_incluster_dataplane.py
python3 scripts/e2e_uat_22_4.py
```

Covers: Artifact extraction, encryption verification, presigned URL access, full user acceptance.

## 4. CI Pipeline

The GitHub Actions pipeline (`ci.yml`) runs:

```
lint → sca → test → build → sbom → e2e → publish
```

| Stage | What | Blocking |
|-------|------|----------|
| **Lint** | `pnpm nx run-many --target=lint` | Yes |
| **SCA** | `pnpm audit --audit-level=high` | No (logs only) |
| **Test** | `pnpm nx run-many --target=test` (with PostgreSQL + Redis services) | Yes |
| **Build** | Docker images for all 7 services | Yes |
| **SBOM** | CycloneDX generation + cosign signing | Push only |
| **E2E** | k3d ephemeral cluster + Helm deploy + smoke tests | Push only |
| **Publish** | Tag + sign release images | Main branch only |

## 5. Proof-of-Life Checklist

| # | Check | Command | Expected |
|---|-------|---------|----------|
| 1 | API responds | `curl localhost:8080/health/live` | `{"status":"ok"}` |
| 2 | DB connected | `curl localhost:8080/health/ready` | `{"status":"ok","db":"connected"}` |
| 3 | Login works | `curl -X POST localhost:8080/auth/login -d '...'` | JWT token returned |
| 4 | Tests pass | `pnpm nx run-many --target=test --all` | 385 passed, 0 failed |
| 5 | Build clean | `pnpm nx run-many --target=build --all` | 7 projects succeeded |
| 6 | Metrics up | `curl localhost:8080/metrics` | Prometheus text format |
| 7 | Swagger docs | `curl localhost:8080/api/docs` | HTML page |
| 8 | NATS connected | `nats server ping --server=nats://localhost:4222` | Pong |
| 9 | Pods running | `kubectl -n browser-hitl get pods` | All Running/Ready |
| 10 | Helm deployed | `helm ls -n browser-hitl` | browser-hitl deployed |
