import { MigrationInterface, QueryRunner } from 'typeorm';

export class MultiTenantCloud1708300000015 implements MigrationInterface {
  name = 'MultiTenantCloud1708300000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add external_id to tenants for cross-system mapping (e.g., Frontegg org ID)
    await queryRunner.query(`
      ALTER TABLE "tenants"
      ADD COLUMN IF NOT EXISTS "external_id" varchar NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_tenants_external_id"
      ON "tenants" ("external_id") WHERE "external_id" IS NOT NULL
    `);

    // Add tenant_id_claim to identity_providers for dynamic tenant routing from JWT
    await queryRunner.query(`
      ALTER TABLE "identity_providers"
      ADD COLUMN IF NOT EXISTS "tenant_id_claim" varchar NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "identity_providers" DROP COLUMN IF EXISTS "tenant_id_claim"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tenants_external_id"`);
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN IF EXISTS "external_id"`);
  }
}
