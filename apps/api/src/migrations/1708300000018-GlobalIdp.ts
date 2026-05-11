import { MigrationInterface, QueryRunner } from 'typeorm';

export class GlobalIdp1708300000018 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE identity_providers DROP CONSTRAINT IF EXISTS "fk_identity_providers_tenant_id"`);
    await queryRunner.query(`ALTER TABLE identity_providers ALTER COLUMN tenant_id DROP NOT NULL`);
    await queryRunner.query(`UPDATE identity_providers SET tenant_id = NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Pick the first tenant as fallback for rollback
    await queryRunner.query(`
      UPDATE identity_providers SET tenant_id = (SELECT id FROM tenants ORDER BY created_at LIMIT 1)
      WHERE tenant_id IS NULL
    `);
    await queryRunner.query(`ALTER TABLE identity_providers ALTER COLUMN tenant_id SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE identity_providers ADD CONSTRAINT "fk_identity_providers_tenant_id" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`);
  }
}
