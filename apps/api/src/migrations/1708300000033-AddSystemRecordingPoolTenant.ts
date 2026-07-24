import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seed the sentinel "system" tenant that owns the GLOBAL warm recording pool.
 *
 * The warm pool moved from one pool app per tenant to a single shared pool: the
 * pool app(s) and their unclaimed spares live under this well-known tenant id
 * (RECORDING_POOL.SYSTEM_TENANT_ID), and a claim rebinds the spare's tenant_id
 * to the real requesting tenant. Because sessions/applications have a FK to
 * tenants, this row must exist before any pool app is created. Idempotent.
 *
 * max_sessions is set high so the controller never refuses to warm spares under
 * this tenant (real recordings count against the claiming tenant, not this one,
 * since the claim rebinds tenant_id).
 */
export class AddSystemRecordingPoolTenant1708300000033 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "tenants" ("id", "name", "max_sessions")
       VALUES ('00000000-0000-0000-0000-000000000000', '__system_recording_pool__', 100000)
       ON CONFLICT ("id") DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove the sentinel tenant only if nothing still references it (its pool
    // apps/spares should be gone first). Safe no-op if rows remain.
    await queryRunner.query(
      `DELETE FROM "tenants" WHERE "id" = '00000000-0000-0000-0000-000000000000'
         AND NOT EXISTS (SELECT 1 FROM "applications" WHERE "tenant_id" = '00000000-0000-0000-0000-000000000000')
         AND NOT EXISTS (SELECT 1 FROM "sessions" WHERE "tenant_id" = '00000000-0000-0000-0000-000000000000')`,
    );
  }
}
