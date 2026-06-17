import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRoleMapping1708300000027 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add Editor to the user_role enum (used by users table and JWT role field)
    await queryRunner.query(
      `ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'Editor' AFTER 'Admin'`,
    );

    await queryRunner.query(
      `ALTER TABLE "identity_providers" ADD COLUMN IF NOT EXISTS "role_claim" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_providers" ADD COLUMN IF NOT EXISTS "admin_role_values" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_providers" ADD COLUMN IF NOT EXISTS "editor_role_values" jsonb`,
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
      `ALTER TABLE "identity_providers" DROP COLUMN IF EXISTS "editor_role_values"`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_providers" DROP COLUMN IF EXISTS "admin_role_values"`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_providers" DROP COLUMN IF EXISTS "role_claim"`,
    );
  }
}
