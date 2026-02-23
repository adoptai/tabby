# E2E Smoke Test Suite — Full Credential Delivery Chain

End-to-end smoke tests for the browser-based authentication delegation system.
Tests the complete flow from worker login through credential extraction to agent consumption.

## Architecture

```
Test Harness (Salesforce-like)
    ^
    | Chromium login + OTP
Worker Pod ──extract──> AES-256-GCM blob ──> MinIO
    ^                                           |
    | OTP relay (Redis)                    decrypt
Mock HITL Auto-Responder                        |
    ^                                      API envelope
    | NATS hitl.otp-requested                   |
Controller                              Mock Agent Consumer
                                           |
                                    Use credentials against
                                    Test Harness /api/me
```

## Quick Start

### Prerequisites

- Kind cluster with Helm release deployed
- Port-forwards to API (8080), NATS (4222), Redis (6379), PostgreSQL (15432)
- Test harness deployed in cluster

### Run Happy Path

```bash
# Port-forwards
kubectl -n browser-hitl port-forward svc/browser-hitl-api 8080:8080 &
kubectl -n browser-hitl port-forward svc/browser-hitl-nats 4222:4222 &
kubectl -n browser-hitl port-forward svc/browser-hitl-redis 6379:6379 &
kubectl -n browser-hitl port-forward svc/browser-hitl-postgresql 15432:5432 &

# Run with mock HITL (auto-responds to OTP requests)
python3 e2e_smoke_test/orchestrator.py --hitl-mode mock --scenarios A

# Run with real Slack HITL
python3 e2e_smoke_test/orchestrator.py --hitl-mode manual --timeout 600

# Run all scenarios
python3 e2e_smoke_test/orchestrator.py --hitl-mode mock --scenarios A,C,E
```

## Test Scenarios

| Category | ID | Test | HITL Mode |
|----------|----|------|-----------|
| **A: Happy Path** | A1 | Full login → OTP → HEALTHY → credential request → verify | mock |
| | A2 | Agent OAuth → credential request | mock |
| | A3 | Force-refresh returns new artifact | mock |
| **B: HITL Variations** | B1 | Delayed OTP (30s) | mock (delayed) |
| | B2 | Wrong OTP → session FAILED | mock (wrong) |
| | B3 | OTP timeout → session FAILED | mock (timeout) |
| **C: Freshness** | C1 | Repeat request returns CACHED | mock |
| | C2 | Force-refresh returns EXTRACTED | mock |
| | C3 | include_volatile=false omits VOLATILE | mock |
| **D: Lifecycle** | D1 | Keepalive maintains HEALTHY | mock |
| | D2 | Short TTL → session expires | mock |
| **E: Security** | E1 | Wrong profile → 403/404 | mock |
| | E2 | Invalid JWT → 401 | mock |
| | E3 | No session → 404 | mock |
| **F: Rate Limiting** | F1 | Harness rate limits login | N/A |
| | F2 | Account lockout | N/A |
| | F3 | Admin unlock | N/A |
| **G: Adversarial** | G1 | 10 concurrent credential requests | mock |

## File Structure

```
e2e_smoke_test/
  README.md                         # This file
  orchestrator.py                   # Main test runner
  mock-hitl/
    auto-responder.js               # NATS→Redis OTP bridge
    package.json                    # Dependencies
  helpers/
    http_client.py                  # Shared HTTP utilities
    canary-bypass.js                # DB helper for canary gate
  results/
    .gitkeep                        # Evidence output directory
    run_YYYYMMDDTHHMMSSZ/           # Per-run evidence (auto-created)
```

## Evidence Output

Each run creates a timestamped directory in `results/` with:
- `summary.json` — overall pass/fail, all check results, timing
- `*.json` — every HTTP request/response pair
- `mock_hitl.log` — NATS events received by auto-responder

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_URL` | `http://localhost:8080` | API base URL |
| `ADMIN_EMAIL` | `admin@browser-hitl.local` | Admin login email |
| `ADMIN_PASSWORD` | `e2e-admin-password` | Admin login password |
| `CREDENTIAL_REF` | `k8s:secret/e2e-smoke-creds` | Worker credential K8s secret |
| `HITL_MODE` | `mock` | mock, manual, or api |
| `NATS_URL` | `nats://localhost:4222` | NATS server for mock HITL |
| `REDIS_URL` | `redis://localhost:6379` | Redis server for mock HITL |
| `DATABASE_URL` | `postgresql://...@localhost:15432/...` | Postgres for canary bypass |
| `HARNESS_URL` | `http://localhost:18000` | Test harness URL for credential verification |
