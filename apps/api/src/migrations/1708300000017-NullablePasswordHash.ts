import { MigrationInterface, QueryRunner } from 'typeorm';

export class NullablePasswordHash1708300000017 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Set a placeholder for federated users (auto-provisioned with password_hash = NULL)
    // before re-adding the NOT NULL constraint, otherwise the rollback fails.
    await queryRunner.query(`UPDATE users SET password_hash = 'SSO_USER_NO_PASSWORD' WHERE password_hash IS NULL`);
    await queryRunner.query(`ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL`);
  }
}
