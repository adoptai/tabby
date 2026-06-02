import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: ControllerScaling
 *
 * Adds columns and indexes required for horizontal controller scaling via
 * FOR UPDATE SKIP LOCKED (see docs/controller-scaling-strategy.md).
 *
 * Changes:
 * - applications.last_reconciled_at — tracks when a controller last processed this app
 * - sessions.last_evaluated_at      — tracks when a controller last evaluated this session
 * - Partial indexes for the SKIP LOCKED queries (only active rows indexed)
 * - circuit_breaker_state table     — persistent circuit-breaker state shared across replicas
 */
export class ControllerScaling1708300000023 implements MigrationInterface {
  name = 'ControllerScaling1708300000023';

  async up(queryRunner: QueryRunner): Promise<void> {
    // --- applications ---
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "last_reconciled_at" TIMESTAMPTZ`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_applications_reconcile"
         ON "applications" ("last_reconciled_at" ASC NULLS FIRST)
         WHERE desired_session_count > 0`,
    );

    // --- sessions ---
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "last_evaluated_at" TIMESTAMPTZ`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_sessions_evaluate"
         ON "sessions" ("last_evaluated_at" ASC NULLS FIRST)
         WHERE state NOT IN ('TERMINATED')`,
    );

    // --- circuit_breaker_state ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "circuit_breaker_state" (
        "entity_type"   VARCHAR(50)  NOT NULL,
        "entity_id"     VARCHAR(255) NOT NULL,
        "pause_until"   TIMESTAMPTZ  NOT NULL,
        "failure_count" INTEGER      NOT NULL DEFAULT 0,
        "updated_at"    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("entity_type", "entity_id")
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "circuit_breaker_state"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sessions_evaluate"`);
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP COLUMN IF EXISTS "last_evaluated_at"`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_applications_reconcile"`);
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "last_reconciled_at"`,
    );
  }
}
