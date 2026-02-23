import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Service Profiles (ADR-014)
 *
 * Creates the service_profiles table for versioned service profile management.
 * Profiles follow STAGING → CANARY → ACTIVE → RETIRED lifecycle.
 * Includes partial unique indexes to enforce at most one ACTIVE and one CANARY
 * per (tenant_id, profile_id).
 */
export class ServiceProfiles1708300000007 implements MigrationInterface {
  name = 'ServiceProfiles1708300000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create profile_version_state enum
    await queryRunner.query(`
      CREATE TYPE "profile_version_state" AS ENUM ('STAGING', 'CANARY', 'ACTIVE', 'RETIRED')
    `);

    // Create service_profiles table
    await queryRunner.query(`
      CREATE TABLE "service_profiles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "profile_id" varchar NOT NULL,
        "version" varchar NOT NULL,
        "version_state" "profile_version_state" NOT NULL DEFAULT 'STAGING',
        "parent_version_id" uuid,
        "login_config" jsonb NOT NULL,
        "credential_types" jsonb NOT NULL,
        "target_domains" jsonb NOT NULL,
        "login_concurrency_limit" integer,
        "extra_config" jsonb,
        "canary_request_count" integer NOT NULL DEFAULT 0,
        "canary_error_count" integer NOT NULL DEFAULT 0,
        "promoted_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_service_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "FK_service_profiles_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_service_profiles_parent" FOREIGN KEY ("parent_version_id")
          REFERENCES "service_profiles"("id") ON DELETE SET NULL
      )
    `);

    // Lookup index: tenant + profile_id
    await queryRunner.query(`
      CREATE INDEX "IDX_service_profiles_tenant_profile"
        ON "service_profiles" ("tenant_id", "profile_id")
    `);

    // Partial unique: at most one ACTIVE per (tenant_id, profile_id)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_service_profiles_active_unique"
        ON "service_profiles" ("tenant_id", "profile_id")
        WHERE version_state = 'ACTIVE'
    `);

    // Partial unique: at most one CANARY per (tenant_id, profile_id)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_service_profiles_canary_unique"
        ON "service_profiles" ("tenant_id", "profile_id")
        WHERE version_state = 'CANARY'
    `);

    // Unique version per (tenant_id, profile_id, version)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_service_profiles_version_unique"
        ON "service_profiles" ("tenant_id", "profile_id", "version")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_service_profiles_version_unique"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_service_profiles_canary_unique"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_service_profiles_active_unique"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_service_profiles_tenant_profile"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "service_profiles"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "profile_version_state"`);
  }
}
