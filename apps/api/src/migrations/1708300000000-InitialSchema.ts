import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1708300000000 implements MigrationInterface {
  name = 'InitialSchema1708300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum types
    await queryRunner.query(`CREATE TYPE "user_role" AS ENUM ('Admin', 'Operator', 'Viewer')`);
    await queryRunner.query(`CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'DISABLED')`);
    await queryRunner.query(`CREATE TYPE "identity_provider" AS ENUM ('slack', 'teams')`);
    await queryRunner.query(`CREATE TYPE "session_state" AS ENUM ('STARTING', 'HEALTHY', 'UNHEALTHY', 'LOGIN_NEEDED', 'LOGIN_IN_PROGRESS', 'FAILED', 'TERMINATED')`);
    await queryRunner.query(`CREATE TYPE "health_result" AS ENUM ('PASS', 'TRANSIENT_FAIL', 'AUTH_FAIL')`);
    await queryRunner.query(`CREATE TYPE "baton_state" AS ENUM ('AUTOMATION_CONTROL', 'HUMAN_REQUESTED', 'HUMAN_CONTROL', 'HUMAN_RELEASED')`);
    await queryRunner.query(`CREATE TYPE "intervention_type" AS ENUM ('OTP', 'CAPTCHA', 'MANUAL', 'OTHER')`);
    await queryRunner.query(`CREATE TYPE "intervention_outcome" AS ENUM ('SUCCESS', 'FAIL', 'TIMEOUT')`);
    await queryRunner.query(`CREATE TYPE "storage_backend" AS ENUM ('minio')`);
    await queryRunner.query(`CREATE TYPE "access_method" AS ENUM ('presigned_url', 'nats')`);
    await queryRunner.query(`CREATE TYPE "audit_actor_type" AS ENUM ('system', 'human')`);

    // tenants
    await queryRunner.query(`
      CREATE TABLE "tenants" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" VARCHAR NOT NULL UNIQUE,
        "max_sessions" INTEGER NOT NULL DEFAULT 10,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // users
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" UUID NOT NULL REFERENCES "tenants"("id"),
        "email" VARCHAR NOT NULL,
        "password_hash" VARCHAR NOT NULL,
        "role" "user_role" NOT NULL,
        "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE ("tenant_id", "email")
      )
    `);

    // user_identities
    await queryRunner.query(`
      CREATE TABLE "user_identities" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" UUID NOT NULL REFERENCES "users"("id"),
        "tenant_id" UUID NOT NULL REFERENCES "tenants"("id"),
        "provider" "identity_provider" NOT NULL,
        "external_id" VARCHAR NOT NULL,
        "workspace_id" VARCHAR,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // applications
    await queryRunner.query(`
      CREATE TABLE "applications" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" UUID NOT NULL REFERENCES "tenants"("id"),
        "name" VARCHAR NOT NULL,
        "target_urls" JSONB NOT NULL,
        "login_config" JSONB NOT NULL,
        "keepalive_config" JSONB NOT NULL,
        "export_policy" JSONB NOT NULL,
        "notification_config" JSONB NOT NULL,
        "browser_policy" JSONB NOT NULL DEFAULT '{"downloads": false, "clipboard": false, "file_chooser": false}',
        "desired_session_count" INTEGER NOT NULL DEFAULT 1,
        "credential_last_validated_at" TIMESTAMPTZ,
        "credential_rotation_reminder_days" INTEGER NOT NULL DEFAULT 90,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // sessions
    await queryRunner.query(`
      CREATE TABLE "sessions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "app_id" UUID NOT NULL REFERENCES "applications"("id"),
        "tenant_id" UUID NOT NULL REFERENCES "tenants"("id"),
        "state" "session_state" NOT NULL DEFAULT 'STARTING',
        "state_version" BIGINT NOT NULL DEFAULT 0,
        "health_result_type" "health_result",
        "pod_name" VARCHAR,
        "last_health_check" TIMESTAMPTZ,
        "last_login_at" TIMESTAMPTZ,
        "intervention_count" INTEGER NOT NULL DEFAULT 0,
        "hitl_attempt_count" INTEGER NOT NULL DEFAULT 0,
        "hitl_pause_until" TIMESTAMPTZ,
        "artifacts_last_exported_at" TIMESTAMPTZ,
        "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "retry_count" INTEGER NOT NULL DEFAULT 0
      )
    `);

    // session_batons
    await queryRunner.query(`
      CREATE TABLE "session_batons" (
        "session_id" UUID PRIMARY KEY REFERENCES "sessions"("id"),
        "baton_state" "baton_state" NOT NULL DEFAULT 'AUTOMATION_CONTROL',
        "owner_user_id" UUID REFERENCES "users"("id"),
        "requested_at" TIMESTAMPTZ,
        "acquired_at" TIMESTAMPTZ,
        "expires_at" TIMESTAMPTZ,
        "version" BIGINT NOT NULL DEFAULT 0,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // interventions
    await queryRunner.query(`
      CREATE TABLE "interventions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "session_id" UUID NOT NULL REFERENCES "sessions"("id"),
        "tenant_id" UUID NOT NULL REFERENCES "tenants"("id"),
        "app_id" UUID NOT NULL REFERENCES "applications"("id"),
        "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "completed_at" TIMESTAMPTZ,
        "type" "intervention_type" NOT NULL,
        "outcome" "intervention_outcome",
        "human_note" TEXT,
        "screenshots_ref" JSONB
      )
    `);

    // artifact_bundles
    await queryRunner.query(`
      CREATE TABLE "artifact_bundles" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "session_id" UUID NOT NULL REFERENCES "sessions"("id"),
        "app_id" UUID NOT NULL REFERENCES "applications"("id"),
        "tenant_id" UUID NOT NULL REFERENCES "tenants"("id"),
        "encrypted_payload_ref" VARCHAR NOT NULL,
        "storage_backend" "storage_backend" NOT NULL DEFAULT 'minio',
        "nonce" BYTEA NOT NULL,
        "key_version" VARCHAR NOT NULL,
        "exported_at" TIMESTAMPTZ NOT NULL,
        "expires_at" TIMESTAMPTZ NOT NULL
      )
    `);

    // artifact_consumptions
    await queryRunner.query(`
      CREATE TABLE "artifact_consumptions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "artifact_id" UUID NOT NULL REFERENCES "artifact_bundles"("id"),
        "consumer_id" VARCHAR NOT NULL,
        "token_id" VARCHAR NOT NULL,
        "consumed_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "access_method" "access_method" NOT NULL
      )
    `);

    // audit_events
    await queryRunner.query(`
      CREATE TABLE "audit_events" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "sequence_num" BIGSERIAL UNIQUE NOT NULL,
        "tenant_id" UUID REFERENCES "tenants"("id"),
        "timestamp" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "actor_type" "audit_actor_type" NOT NULL,
        "actor_id" VARCHAR NOT NULL,
        "event_type" VARCHAR NOT NULL,
        "payload" JSONB NOT NULL,
        "prev_hash" VARCHAR(64),
        "hash" VARCHAR(64) NOT NULL
      )
    `);

    // audit_anchors
    await queryRunner.query(`
      CREATE TABLE "audit_anchors" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "anchor_date" DATE UNIQUE NOT NULL,
        "root_hash" VARCHAR(64) NOT NULL,
        "event_count" INTEGER NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Indexes for common query patterns
    await queryRunner.query(`CREATE INDEX "idx_sessions_app_id" ON "sessions" ("app_id")`);
    await queryRunner.query(`CREATE INDEX "idx_sessions_tenant_id" ON "sessions" ("tenant_id")`);
    await queryRunner.query(`CREATE INDEX "idx_sessions_state" ON "sessions" ("state")`);
    await queryRunner.query(`CREATE INDEX "idx_interventions_session_id" ON "interventions" ("session_id")`);
    await queryRunner.query(`CREATE INDEX "idx_interventions_tenant_id" ON "interventions" ("tenant_id")`);
    await queryRunner.query(`CREATE INDEX "idx_artifact_bundles_session_id" ON "artifact_bundles" ("session_id")`);
    await queryRunner.query(`CREATE INDEX "idx_artifact_bundles_tenant_id" ON "artifact_bundles" ("tenant_id")`);
    await queryRunner.query(`CREATE INDEX "idx_audit_events_tenant_id" ON "audit_events" ("tenant_id")`);
    await queryRunner.query(`CREATE INDEX "idx_audit_events_sequence_num" ON "audit_events" ("sequence_num")`);
    await queryRunner.query(`CREATE INDEX "idx_audit_events_timestamp" ON "audit_events" ("timestamp")`);
    await queryRunner.query(`CREATE INDEX "idx_users_tenant_id" ON "users" ("tenant_id")`);
    await queryRunner.query(`CREATE INDEX "idx_applications_tenant_id" ON "applications" ("tenant_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_anchors"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "artifact_consumptions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "artifact_bundles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "interventions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "session_batons"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sessions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "applications"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_identities"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tenants"`);

    await queryRunner.query(`DROP TYPE IF EXISTS "audit_actor_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "access_method"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "storage_backend"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "intervention_outcome"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "intervention_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "baton_state"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "health_result"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "session_state"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "identity_provider"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "user_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "user_role"`);
  }
}
