# Phase 1: Core Data + Auth + Bootstrap

**Status**: COMPLETE
**Tasks**: 9-12
**Sprint**: 1 (S1-4 through S1-6)
**Completed**: 2026-02-18

---

## Task Tracker

| Task # | Description | Status | Notes |
|--------|-------------|--------|-------|
| 9 | Postgres schema + TypeORM migrations | COMPLETE | 11 tables, 2 migrations |
| 10 | Admin auth (basic + JWT) | COMPLETE | bcrypt 12, JWT 24h TTL |
| 11 | RBAC middleware | COMPLETE | JwtAuthGuard + RolesGuard |
| 12 | Bootstrap flow | COMPLETE | Idempotent first-startup |

---

## Implementation Summary

### Task 9: Database Schema
- **Location**: `apps/api/src/entities/` (11 entity files) + `apps/api/src/migrations/`
- **Tables**: tenants, users, user_identities, applications, sessions, session_batons, interventions, artifact_bundles, artifact_consumptions, audit_events, audit_anchors
- **Migration 1** (InitialSchema): All 11 tables with enum types, indexes, foreign keys
- **Migration 2** (WorkerRLS): Dedicated `worker` role, RLS policies on sessions/artifact_bundles/audit_events
- **Concurrency**: state_version BIGINT for optimistic locking, session_batons.version for CAS
- **Advisory lock**: Migrations use advisory lock via TypeORM migrationsRun + pg_advisory_lock

### Task 10: Admin Auth
- **Location**: `apps/api/src/modules/auth/`
- **Auth flow**: POST /login → validate bcrypt(cost 12) → issue JWT (24h TTL)
- **JWT payload**: { sub: user_id, tenant_id, role, kid }
- **Key rotation**: JWT_SIGNING_KEY_ID supports rotation

### Task 11: RBAC
- **Location**: `apps/api/src/common/guards/roles.guard.ts`
- **Guards**: JwtAuthGuard (Passport JWT), RolesGuard (reflector-based)
- **Decorator**: @Roles('Admin', 'Operator', 'Viewer')
- **All endpoints guarded** per spec section 11.7

### Task 12: Bootstrap
- **Location**: `apps/api/src/modules/auth/bootstrap.service.ts`
- **OnModuleInit**: Checks tenant count, creates default tenant + admin if empty
- **Idempotent**: Skips if any tenant exists
- **Env vars**: BOOTSTRAP_TENANT_NAME, ADMIN_BOOTSTRAP_EMAIL, ADMIN_BOOTSTRAP_PASSWORD

---

## Decisions Made
1. Used raw SQL in migrations (not TypeORM sync) for maximum control over enum types and indexes
2. Worker RLS policies use `current_setting('app.session_id', true)` with `true` to avoid errors when not set
3. Audit hash chain uses pg_advisory_lock(42) as fixed lock ID per spec

## Learnings
1. TypeORM `synchronize: true` should NEVER be used with migrations — disabled explicitly
2. TypeORM entity decorators require `emitDecoratorMetadata` and `experimentalDecorators` in tsconfig
