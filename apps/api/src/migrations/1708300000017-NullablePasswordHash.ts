import { MigrationInterface, QueryRunner } from 'typeorm';

export class NullablePasswordHash1708300000017 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL`);
  }
}
