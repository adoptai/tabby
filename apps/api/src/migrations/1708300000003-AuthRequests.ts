import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-012: Three-Barrier Login Serialization
 *
 * Creates the auth_requests table for login serialization with:
 * - Partial unique index on (tenant_id, app_id) WHERE state = 'IN_PROGRESS'
 *   to enforce at most one concurrent login per app per tenant (Barrier 2)
 * - Adds last_login_attempt_at to sessions for worker-side rate guard (Barrier 3)
 */
export class AuthRequests1708300000003 implements MigrationInterface {
  name = 'AuthRequests1708300000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum type for auth request state
    await queryRunner.query(`
      CREATE TYPE "auth_request_state" AS ENUM (
        'RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXPIRED'
      )
    `);

    // Create auth_requests table
    await queryRunner.query(`
      CREATE TABLE "auth_requests" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "session_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "app_id" uuid NOT NULL,
        "state" "auth_request_state" NOT NULL DEFAULT 'RECEIVED',
        "failure_reason" text,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_auth_requests" PRIMARY KEY ("id"),
        CONSTRAINT "FK_auth_requests_session" FOREIGN KEY ("session_id")
          REFERENCES "sessions"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_auth_requests_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_auth_requests_app" FOREIGN KEY ("app_id")
          REFERENCES "applications"("id") ON DELETE CASCADE
      )
    `);

    // Standard lookup index
    await queryRunner.query(`
      CREATE INDEX "IDX_auth_requests_tenant_app" ON "auth_requests" ("tenant_id", "app_id")
    `);

    // CRITICAL: Partial unique index — enforces at most one IN_PROGRESS
    // login per tenant+app combination (Barrier 2, ADR-012 amendment RT-04)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_auth_requests_active_unique"
        ON "auth_requests" ("tenant_id", "app_id")
        WHERE state = 'IN_PROGRESS'
    `);

    // Index for stale detection sweep (finds old IN_PROGRESS records)
    await queryRunner.query(`
      CREATE INDEX "IDX_auth_requests_stale_sweep"
        ON "auth_requests" ("state", "created_at")
        WHERE state = 'IN_PROGRESS'
    `);

    // Barrier 3 (ADR-012 amendment RT-10): Worker-side rate guard
    // Add last_login_attempt_at to sessions table
    await queryRunner.query(`
      ALTER TABLE "sessions"
        ADD COLUMN "last_login_attempt_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "last_login_attempt_at"`);
    await queryRunner.query(`DROP INDEX "IDX_auth_requests_stale_sweep"`);
    await queryRunner.query(`DROP INDEX "IDX_auth_requests_active_unique"`);
    await queryRunner.query(`DROP INDEX "IDX_auth_requests_tenant_app"`);
    await queryRunner.query(`DROP TABLE "auth_requests"`);
    await queryRunner.query(`DROP TYPE "auth_request_state"`);
  }
}
