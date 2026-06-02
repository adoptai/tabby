import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTemplateExecuteEnabled1708300000024 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_templates" ADD COLUMN "execute_enabled" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_templates" DROP COLUMN "execute_enabled"`,
    );
  }
}
