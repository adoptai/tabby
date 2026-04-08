import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOwnerUserIds1708300000011 implements MigrationInterface {
  name = 'AddOwnerUserIds1708300000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add owner_user_id to sessions (nullable for backward compat)
    await queryRunner.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_user_id VARCHAR(255)`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_owner
      ON sessions (tenant_id, owner_user_id)
      WHERE owner_user_id IS NOT NULL
    `);

    // Add owner_user_id to service_profiles (nullable for backward compat)
    await queryRunner.query(`ALTER TABLE service_profiles ADD COLUMN IF NOT EXISTS owner_user_id VARCHAR(255)`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_profiles_owner
      ON service_profiles (tenant_id, profile_id, owner_user_id)
      WHERE owner_user_id IS NOT NULL
    `);

    // Extend user_identities provider enum to include oidc and saml
    await queryRunner.query(`ALTER TYPE identity_provider ADD VALUE IF NOT EXISTS 'oidc'`);
    await queryRunner.query(`ALTER TYPE identity_provider ADD VALUE IF NOT EXISTS 'saml'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_sessions_owner`);
    await queryRunner.query(`ALTER TABLE sessions DROP COLUMN IF EXISTS owner_user_id`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_profiles_owner`);
    await queryRunner.query(`ALTER TABLE service_profiles DROP COLUMN IF EXISTS owner_user_id`);
    // Note: cannot remove enum values in PostgreSQL
  }
}
