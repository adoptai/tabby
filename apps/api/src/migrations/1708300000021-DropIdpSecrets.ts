import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropIdpSecrets1708300000021 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE identity_providers DROP COLUMN IF EXISTS client_id`);
    await queryRunner.query(`ALTER TABLE identity_providers DROP COLUMN IF EXISTS client_secret`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE identity_providers ADD COLUMN client_id varchar`);
    await queryRunner.query(`ALTER TABLE identity_providers ADD COLUMN client_secret varchar`);
  }
}
