import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Portal username/password for apps whose login_config.credential_ref is
 * `harness:`. Supplied by the caller of POST /credentials/request, stored
 * AES-256-GCM encrypted under TENANT_ENCRYPTION_KEY, and read only by the
 * controller when it mints the per-session K8s Secret for the worker pod.
 */
export class AddAppLoginCredentials1708300000037 implements MigrationInterface {
  name = 'AddAppLoginCredentials1708300000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS login_credentials_enc text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE applications DROP COLUMN IF EXISTS login_credentials_enc`);
  }
}
