# Phase 0: Test Harness + Repo Foundations

**Status**: COMPLETE
**Tasks**: 1-8
**Sprint**: 1 (S1-1 through S1-3, S1-9)
**Completed**: 2026-02-18

---

## Task Tracker

| Task # | Description | Status | Notes |
|--------|-------------|--------|-------|
| 1 | Build test harness app (Python/FastAPI) | COMPLETE | All acceptance criteria verified |
| 2 | Create monorepo structure (pnpm + NX) | COMPLETE | pnpm 10.12.1, NX 21.x |
| 3 | Create shared types and schemas package | COMPLETE | 8 source files, 69 tests passing |
| 4 | Define login DSL semantics and validation | COMPLETE | All 15 actions + validator |
| 5 | Define health predicate evaluation types | COMPLETE | Policy engine tested |
| 6 | Define BrowserStreamProvider interface | COMPLETE | In stream.types.ts |
| 7 | Define Chromium hardening flags | COMPLETE | In constants.ts |
| 8 | Document cluster defaults and sizing | COMPLETE | In constants.ts (code) |

---

## Implementation Summary

### Task 1: Test Harness App
- **Location**: `test-harness/`
- **Stack**: Python 3.11 + FastAPI + Jinja2
- **Verified flows**: login → OTP (123456) → dashboard (#user-menu) → /api/me → logout
- **Docker**: Dockerfile included, runs as `nobody` user

### Task 2: Monorepo
- **Structure**: pnpm workspaces + NX 21.x
- **Packages**: 7 workspace packages (api, controller, worker, slack-bot, teams-bot, admin-ui, shared)
- **Build**: `pnpm build` compiles shared package, NX orchestrates

### Tasks 3-6: Shared Package (`packages/shared`)
- **Files**: enums.ts, dsl.types.ts, config.types.ts, health.types.ts, stream.types.ts, state-machine.ts, nats.types.ts, api.types.ts, dsl.validator.ts, constants.ts
- **Tests**: 69 tests in 3 spec files (state-machine, dsl.validator, health.types)
- **Coverage**: All 15 DSL actions, all 11 session transitions, all 6 baton transitions, health policy engine (all/any/quorum), login config/keepalive/export/notification validators

### Tasks 7-8: Constants
- Chromium hardening flags (17 flags from spec section 13.2)
- Port constants, Redis key patterns, rate limits, defaults

---

## Decisions Made
1. Used `DOM` lib in shared tsconfig for URL validation (URL constructor)
2. TypeORM entities use `strictPropertyInitialization: false` (standard ORM pattern)
3. API tsconfig overrides paths to reference compiled dist of shared package

## Learnings
1. pnpm workspace links resolve to source, not dist — API tsconfig needs explicit paths override
2. botbuilder latest is 4.23.3, not 4.24.1 as initially specified
