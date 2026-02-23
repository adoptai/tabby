import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Login Queue (ADR-015)
 *
 * Creates the login_queue table for global login coordination.
 * PostgreSQL-backed for durability (must survive Redis outage).
 * Includes LISTEN/NOTIFY trigger for event-driven queue processing.
 */
export class LoginQueue1708300000004 implements MigrationInterface {
  name = 'LoginQueue1708300000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create login_queue_state enum
    await queryRunner.query(`
      CREATE TYPE "login_queue_state" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED')
    `);

    // Create login_queue table
    await queryRunner.query(`
      CREATE TABLE "login_queue" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "auth_request_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "app_id" uuid NOT NULL,
        "target_domain" varchar NOT NULL,
        "priority" integer NOT NULL DEFAULT 0,
        "state" "login_queue_state" NOT NULL DEFAULT 'QUEUED',
        "requested_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "started_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "failure_reason" text,
        CONSTRAINT "PK_login_queue" PRIMARY KEY ("id"),
        CONSTRAINT "FK_login_queue_auth_request" FOREIGN KEY ("auth_request_id")
          REFERENCES "auth_requests"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_login_queue_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_login_queue_app" FOREIGN KEY ("app_id")
          REFERENCES "applications"("id") ON DELETE CASCADE
      )
    `);

    // Index for FIFO per-domain ordering (queued items only)
    await queryRunner.query(`
      CREATE INDEX "IDX_login_queue_domain_queued"
        ON "login_queue" ("target_domain", "requested_at")
        WHERE state = 'QUEUED'
    `);

    // Index for counting concurrent RUNNING per domain
    await queryRunner.query(`
      CREATE INDEX "IDX_login_queue_domain_running"
        ON "login_queue" ("target_domain")
        WHERE state = 'RUNNING'
    `);

    // General state index for queue processing queries
    await queryRunner.query(`
      CREATE INDEX "IDX_login_queue_state"
        ON "login_queue" ("state")
    `);

    // PG LISTEN/NOTIFY trigger function (ADR-015 RT-12 amendment)
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION notify_login_queue_ready()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('login_queue_ready', NEW.id::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    // Trigger: fire on INSERT (new queue entry) or UPDATE of state to QUEUED
    await queryRunner.query(`
      CREATE TRIGGER "trg_login_queue_notify"
        AFTER INSERT ON "login_queue"
        FOR EACH ROW
        WHEN (NEW.state = 'QUEUED')
        EXECUTE FUNCTION notify_login_queue_ready()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_login_queue_notify" ON "login_queue"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS notify_login_queue_ready()`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_login_queue_state"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_login_queue_domain_running"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_login_queue_domain_queued"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "login_queue"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "login_queue_state"`);
  }
}
