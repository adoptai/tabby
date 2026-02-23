# Contributing to Browser HITL

## Prerequisites

- **Node.js** 20+
- **pnpm** 10+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Docker** (for local infrastructure)

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Start local infrastructure (PostgreSQL, Redis, NATS, MinIO)
docker compose up -d

# 3. Build all packages
pnpm nx run-many --target=build --all --parallel=3

# 4. Run the API (dev mode)
pnpm --filter @browser-hitl/api start:dev

# 5. Run tests
pnpm nx run-many --target=test --all --parallel=3
```

## Project Structure

```
apps/
  api/           NestJS API server (auth, sessions, HITL, streaming)
  controller/    Kubernetes session reconciler
  worker/        Browser automation worker (Playwright)
  slack-bot/     Slack HITL bridge
  teams-bot/     Teams HITL bridge
  admin-ui/      Next.js admin dashboard
packages/
  shared/        Shared constants, types, utilities
charts/
  browser-hitl/  Helm chart for Kubernetes deployment
infra/
  docker/        Dockerfiles for each service
```

## Development Workflow

### Running Tests

```bash
# All tests
pnpm nx run-many --target=test --all --parallel=3

# Single package
pnpm --filter @browser-hitl/api test

# Specific test file (from package directory)
cd apps/api && npx jest account-lockout
```

### Building

```bash
# All packages
pnpm nx run-many --target=build --all --parallel=3

# Single package
pnpm --filter @browser-hitl/api build
```

### Linting

```bash
# All packages (runs tsc --noEmit)
pnpm nx run-many --target=lint --all --parallel=3
```

Pre-commit hooks (husky + lint-staged) run lint automatically on staged `.ts` files.

## Environment Variables

Copy `.env.example` to `.env.local` for local development. Key variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://browser_hitl:localdev@localhost:5432/browser_hitl` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `NATS_URL` | NATS connection string | `nats://localhost:4222` |
| `JWT_SIGNING_KEY` | JWT signing key (32+ chars) | - |
| `JWT_SIGNING_KEY_ID` | Key ID for JWT header | `key-1` |
| `LOG_FORMAT` | `json` or `text` | `text` (local), `json` (production) |
| `LOG_LEVEL` | `debug`, `log`, `warn`, `error` | `log` |

See `packages/shared/src/env.ts` for the full env spec with validation.

## Helm Deployment

```bash
# Local (Kind/minikube)
helm upgrade --install browser-hitl charts/browser-hitl \
  -f charts/browser-hitl/values-local.yaml \
  --namespace browser-hitl --create-namespace

# Production
helm upgrade --install browser-hitl charts/browser-hitl \
  -f charts/browser-hitl/values-production.yaml \
  --namespace browser-hitl --create-namespace \
  --set secrets.postgresPassword=$PG_PASSWORD \
  --set secrets.jwtSigningKey=$JWT_KEY
```

See `charts/browser-hitl/values-local.yaml` and `values-production.yaml` for tier differences.

## Pull Request Conventions

- Branch from `main`, target `main`
- Keep PRs focused — one feature or fix per PR
- All tests must pass (`pnpm nx run-many --target=test --all`)
- Build must succeed (`pnpm nx run-many --target=build --all`)
- Include tests for new functionality

## Security

- Never commit secrets or `.env` files (`.env.*` is gitignored)
- Use `class-validator` DTOs for all controller inputs
- All endpoints require JWT auth except `/auth/login`, `/health/*`, and `/metrics`
- See `docs/internal/CLAUDE_RED_TEAM_REMEDIATIONS.md` for the full security hardening audit trail
