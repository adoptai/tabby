import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTemplateIsActive1708300000030 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_templates" ADD COLUMN "is_active" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_templates" DROP COLUMN "is_active"`,
    );
  }
}
