import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAppOwnerUserId1708300000014 implements MigrationInterface {
  name = 'AddAppOwnerUserId1708300000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS owner_user_id VARCHAR(255)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE applications DROP COLUMN IF EXISTS owner_user_id`);
  }
}
