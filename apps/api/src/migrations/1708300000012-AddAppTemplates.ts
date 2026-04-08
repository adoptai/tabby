import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAppTemplates1708300000012 implements MigrationInterface {
  name = 'AddAppTemplates1708300000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE app_templates (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name                  VARCHAR NOT NULL,
        profile_name_pattern  VARCHAR NOT NULL,
        login_config          JSONB NOT NULL,
        keepalive_config      JSONB NOT NULL,
        export_policy         JSONB NOT NULL,
        browser_policy        JSONB NOT NULL DEFAULT '{"clipboard":false,"downloads":false,"file_chooser":false}',
        notification_config   JSONB NOT NULL DEFAULT '{}',
        credential_ref_default VARCHAR NOT NULL DEFAULT 'manual:',
        idle_shutdown_seconds INTEGER,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_template_tenant_name UNIQUE (tenant_id, name)
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_template_tenant ON app_templates (tenant_id)`);
    await queryRunner.query(`
      CREATE INDEX idx_template_pattern
      ON app_templates (tenant_id, profile_name_pattern)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS app_templates`);
  }
}
