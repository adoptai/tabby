# Quick Start

Get the Browser HITL stack running locally in under 5 minutes.

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Node.js | 20+ | `node -v` |
| pnpm | 10+ | `pnpm -v` |
| Docker | 20+ | `docker --version` |
| Docker Compose | v2 | `docker compose version` |

Enable corepack if pnpm is not installed:

```bash
corepack enable && corepack prepare pnpm@latest --activate
```

## 1. Clone & Install

```bash
git clone <repo-url> && cd browser-hitl
pnpm install
```

## 2. Start Infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL, Redis, NATS (with JetStream), and MinIO.

> **NATS & JetStream:** JetStream is a built-in persistence layer within NATS, not a separate service. The `nats:2.10-alpine` image starts with `--jetstream` enabled. CLI commands like `nats stream info` and `nats consumer info` are standard NATS tooling. The codebase uses `sync_interval: always` for Jepsen-validated durability.

Verify services are running:

```bash
docker compose ps
```

## 3. Configure Environment

```bash
cp .env.example .env.local
```

Edit `.env.local` to set required secrets. See `packages/shared/src/env.ts` for the full environment spec with validation.

## 4. Build

```bash
pnpm nx run-many --target=build --all --parallel=3
# or
make build
```

## 5. Run Tests

```bash
pnpm nx run-many --target=test --all --parallel=3
# or
make test
```

Expected: **640 tests** across **34 suites** in 4 packages:

| Package | Suites | Tests |
|---------|--------|-------|
| `@browser-hitl/shared` | 4 | 78 |
| `@browser-hitl/api` | 24 | 460 |
| `@browser-hitl/controller` | 3 | 50 |
| `@browser-hitl/worker` | 3 | 52 |

## 6. Start the API

```bash
pnpm --filter @browser-hitl/api start:dev
```

Verify it's running:

```bash
curl http://localhost:8080/health/live
# {"status":"ok"}
```

Swagger UI is available at `http://localhost:8080/api/docs` in development mode.

## What Next?

| Goal | Document |
|------|----------|
| Understand the architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Deploy to Kubernetes | [RUNBOOK.md](RUNBOOK.md) |
| Run E2E tests | [TEST_EXECUTION.md](TEST_EXECUTION.md) |
| Contribute code | [CONTRIBUTING.md](CONTRIBUTING.md) |
| AI agent implementation guide | [AGENT.md](AGENT.md) |
| Security posture & audit | [SECURITY.md](SECURITY.md) |

## Makefile Reference

Key targets (run `make help` for the full list):

| Target | Description |
|--------|-------------|
| `make build` | Build all packages |
| `make test` | Run all tests |
| `make test-api` | Run API tests only |
| `make lint` | Type-check all packages |
| `make docker-build` | Build Docker images |
| `make infra-up` | Start local infrastructure |
| `make infra-down` | Stop local infrastructure |
| `make smoke` | Build + test + lint verification |
