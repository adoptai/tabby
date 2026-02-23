# Phase 2: API Service

**Status**: COMPLETE (code structure)
**Tasks**: 13-20
**Sprint**: 1 (S1-7, S1-8)
**Completed**: 2026-02-18

---

## Task Tracker

| Task # | Description | Status | Notes |
|--------|-------------|--------|-------|
| 13 | Tenant APIs | COMPLETE | POST/GET with Admin-only RBAC |
| 14 | User APIs | COMPLETE | POST/GET with password hashing |
| 15 | App APIs | COMPLETE | Full validation from shared pkg |
| 16 | Session APIs | COMPLETE | Scale, list, detail, interventions |
| 17 | Artifact access API | COMPLETE | Presigned URL + consumption tracking |
| 18 | HITL API endpoints | COMPLETE | stream/takeover/release/otp/acknowledge |
| 19 | Error format + rate limiting | COMPLETE | GlobalExceptionFilter + ThrottlerModule |
| 20 | WebSocket events | TODO | Needs NATS integration |

---

## Implementation Summary

### Modules Created
- **TenantsModule**: POST /tenants (Admin), GET /tenants (Admin)
- **UsersModule**: POST /users (Admin), GET /users (Admin/Operator)
- **AppsModule**: POST/GET/PUT /apps with full config validation (login_config, keepalive_config, export_policy, notification_config, target_urls)
- **SessionsModule**: POST /apps/:id/sessions/scale, GET /sessions, GET /sessions/:id, GET /sessions/:id/interventions
- **ArtifactsModule**: GET /artifacts/:id with consumption recording
- **HitlModule**: stream/takeover/release/otp/acknowledge endpoints

### Cross-Cutting
- **Error filter**: GlobalExceptionFilter returns spec-compliant { error: { code, message, details } }
- **Rate limiting**: @nestjs/throttler with 60/min default
- **Audit**: AuditService with hash chain (pg_advisory_lock(42)), SHA256, canonical JSON
- **Pagination**: All list endpoints support ?limit=&offset= with standard response wrapper

### TODOs (deferred to integration phase)
- Redis integration for OTP relay, stream token single-use, artifact token single-use
- MinIO integration for presigned URL generation
- NATS integration for event publishing
- WebSocket /events endpoint
- Rate limit customization per endpoint (login 5/min/IP, stream 3/min/user)

---

## Decisions Made
1. Used pessimistic locking for baton CAS in HITL takeover (TypeORM queryRunner with FOR UPDATE)
2. Apps service validates all configs using shared package validators
3. Sessions scale endpoint updates applications.desired_session_count (controller reads this during reconcile)

## Architecture Notes
- API service is the write path for config (tenants, users, apps)
- Controller is the sole writer of sessions.state
- Worker writes health_result_type and timestamps to sessions table
- All NATS publishing deferred to controller/worker (API only writes to DB/Redis)
