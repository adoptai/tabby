import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Profile → Application Link (Sprint 3b)
 *
 * Adds app_id FK to service_profiles, establishing the Profile → Application
 * → Session chain needed to resolve credentials for a specific application.
 *
 * Also adds 'api_envelope' to the artifact_consumptions access_method enum
 * so credential serves via the API can be audited.
 */
export class ProfileAppLink1708300000008 implements MigrationInterface {
  name = 'ProfileAppLink1708300000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add app_id column (nullable initially for existing rows)
    await queryRunner.query(`
      ALTER TABLE "service_profiles"
        ADD COLUMN "app_id" uuid
    `);

    // 2. FK to applications with ON DELETE RESTRICT
    await queryRunner.query(`
      ALTER TABLE "service_profiles"
        ADD CONSTRAINT "FK_service_profiles_app"
          FOREIGN KEY ("app_id") REFERENCES "applications"("id")
          ON DELETE RESTRICT
    `);

    // 3. Index for session lookup via app_id
    await queryRunner.query(`
      CREATE INDEX "IDX_service_profiles_app"
        ON "service_profiles" ("app_id")
    `);

    // 4. Add 'api_envelope' to access_method enum (used by artifact_consumptions)
    await queryRunner.query(`
      ALTER TYPE "access_method"
        ADD VALUE IF NOT EXISTS 'api_envelope'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_service_profiles_app"`);
    await queryRunner.query(`
      ALTER TABLE "service_profiles"
        DROP CONSTRAINT IF EXISTS "FK_service_profiles_app"
    `);
    await queryRunner.query(`
      ALTER TABLE "service_profiles"
        DROP COLUMN IF EXISTS "app_id"
    `);
    // Note: PostgreSQL does not support removing enum values; the 'api_envelope'
    // value will remain in the enum type after rollback.
  }
}
