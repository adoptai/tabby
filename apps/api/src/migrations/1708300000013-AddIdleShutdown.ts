import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIdleShutdown1708300000013 implements MigrationInterface {
  name = 'AddIdleShutdown1708300000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_credential_request_at TIMESTAMPTZ`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE sessions DROP COLUMN IF EXISTS last_credential_request_at`);
  }
}
