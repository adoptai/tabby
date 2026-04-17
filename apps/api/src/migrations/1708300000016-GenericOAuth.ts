import { MigrationInterface, QueryRunner } from 'typeorm';

export class GenericOAuth1708300000016 implements MigrationInterface {
  name = 'GenericOAuth1708300000016';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_providers"
        ADD COLUMN IF NOT EXISTS "client_secret"  VARCHAR    NULL,
        ADD COLUMN IF NOT EXISTS "auth_url"        VARCHAR    NULL,
        ADD COLUMN IF NOT EXISTS "token_url"       VARCHAR    NULL,
        ADD COLUMN IF NOT EXISTS "userinfo_url"    VARCHAR    NULL,
        ADD COLUMN IF NOT EXISTS "sign_out_url"    VARCHAR    NULL,
        ADD COLUMN IF NOT EXISTS "scopes"          VARCHAR    NULL,
        ADD COLUMN IF NOT EXISTS "admin_domains"   JSONB      NULL,
        ADD COLUMN IF NOT EXISTS "name_claim"      VARCHAR    NOT NULL DEFAULT 'name'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_providers"
        DROP COLUMN IF EXISTS "client_secret",
        DROP COLUMN IF EXISTS "auth_url",
        DROP COLUMN IF EXISTS "token_url",
        DROP COLUMN IF EXISTS "userinfo_url",
        DROP COLUMN IF EXISTS "sign_out_url",
        DROP COLUMN IF EXISTS "scopes",
        DROP COLUMN IF EXISTS "admin_domains",
        DROP COLUMN IF EXISTS "name_claim"
    `);
  }
}
