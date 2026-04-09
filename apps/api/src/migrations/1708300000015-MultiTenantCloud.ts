import { MigrationInterface, QueryRunner } from 'typeorm';

export class MultiTenantCloud1708300000015 implements MigrationInterface {
  name = 'MultiTenantCloud1708300000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Allow custom tenant IDs: change PK from uuid to varchar
    // First drop FK constraints referencing tenants.id, then alter, then re-add
    // Note: TypeORM with synchronize:false — we handle this manually

    // Add tenant_id_claim to identity_providers
    await queryRunner.query(`
      ALTER TABLE "identity_providers"
      ADD COLUMN IF NOT EXISTS "tenant_id_claim" varchar NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_providers"
      DROP COLUMN IF EXISTS "tenant_id_claim"
    `);
  }
}
