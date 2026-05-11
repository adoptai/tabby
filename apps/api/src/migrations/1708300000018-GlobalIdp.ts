import { MigrationInterface, QueryRunner } from 'typeorm';

export class GlobalIdp1708300000018 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE identity_providers DROP CONSTRAINT IF EXISTS "fk_identity_providers_tenant_id"`);
    await queryRunner.query(`ALTER TABLE identity_providers DROP COLUMN IF EXISTS tenant_id`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE identity_providers ADD COLUMN tenant_id varchar(255)`);
    await queryRunner.query(`ALTER TABLE identity_providers ADD CONSTRAINT "fk_identity_providers_tenant_id" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE`);
  }
}
