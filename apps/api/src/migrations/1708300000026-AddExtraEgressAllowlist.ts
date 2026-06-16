import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExtraEgressAllowlist1708300000026 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN "extra_egress_allowlist" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_templates" ADD COLUMN "extra_egress_allowlist" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_templates" DROP COLUMN "extra_egress_allowlist"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN "extra_egress_allowlist"`,
    );
  }
}
