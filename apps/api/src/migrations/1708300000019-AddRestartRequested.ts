import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRestartRequested1708300000019 implements MigrationInterface {
  name = 'AddRestartRequested1708300000019';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS restart_requested boolean NOT NULL DEFAULT false
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sessions DROP COLUMN IF EXISTS restart_requested
    `);
  }
}
