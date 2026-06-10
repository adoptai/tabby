import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRoleMapping1708300000025 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "identity_providers" ADD COLUMN "role_claim" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_providers" ADD COLUMN "admin_role_values" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_providers" ADD COLUMN "editor_role_values" jsonb`,
    );

    // Seed existing IDPs: role_claim = 'roles', editor_role_values = '["Admin"]'
    // This maps Frontegg Admin → Tabby Editor for all pre-existing IdP configs.
    await queryRunner.query(
      `UPDATE "identity_providers"
       SET "role_claim" = 'roles', "editor_role_values" = '["Admin"]'::jsonb
       WHERE "role_claim" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "identity_providers" DROP COLUMN "editor_role_values"`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_providers" DROP COLUMN "admin_role_values"`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_providers" DROP COLUMN "role_claim"`,
    );
  }
}
