import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds account lockout columns to the users table.
 *
 * - failed_login_count: tracks consecutive failed login attempts
 * - locked_until: timestamp when the account lockout expires
 */
export class AccountLockout1708300000005 implements MigrationInterface {
  name = 'AccountLockout1708300000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN "locked_until" TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN "locked_until",
        DROP COLUMN "failed_login_count"
    `);
  }
}
