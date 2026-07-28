import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddResidentialProxyEnabled1708300000031 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_templates" ADD COLUMN "residential_proxy_enabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN "residential_proxy_enabled" boolean NOT NULL DEFAULT false`,
    );
    // Per-session override: null = inherit the app-level default. No default value.
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "residential_proxy_enabled" boolean`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP COLUMN "residential_proxy_enabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN "residential_proxy_enabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_templates" DROP COLUMN "residential_proxy_enabled"`,
    );
  }
}
