import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBrowserStateSnapshots1708300000029 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS browser_state_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        tenant_id VARCHAR NOT NULL,
        owner_user_id VARCHAR,
        encrypted_payload_ref VARCHAR NOT NULL,
        storage_backend VARCHAR NOT NULL DEFAULT 'minio',
        nonce BYTEA NOT NULL,
        key_version VARCHAR NOT NULL DEFAULT 'v1',
        saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        source_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
        health_result VARCHAR
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_state_app_tenant_user
        ON browser_state_snapshots (app_id, tenant_id, COALESCE(owner_user_id, '__shared__'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_browser_state_app_tenant_user`);
    await queryRunner.query(`DROP TABLE IF EXISTS browser_state_snapshots`);
  }
}
