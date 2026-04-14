import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIdentityProviders1708300000010 implements MigrationInterface {
  name = 'AddIdentityProviders1708300000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE identity_providers (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name            VARCHAR NOT NULL,
        provider_type   VARCHAR NOT NULL CHECK (provider_type IN ('oidc', 'saml')),
        issuer_url      VARCHAR,
        jwks_uri        VARCHAR,
        audience        VARCHAR,
        client_id       VARCHAR,
        user_id_claim   VARCHAR NOT NULL DEFAULT 'sub',
        email_claim     VARCHAR NOT NULL DEFAULT 'email',
        claim_mappings  JSONB,
        enabled         BOOLEAN NOT NULL DEFAULT true,
        allow_auto_provision  BOOLEAN NOT NULL DEFAULT false,
        default_role    VARCHAR DEFAULT 'Viewer',
        allow_shared_session_fallback BOOLEAN NOT NULL DEFAULT false,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_idp_tenant_name UNIQUE (tenant_id, name)
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_idp_tenant ON identity_providers (tenant_id)`);
    await queryRunner.query(`CREATE INDEX idx_idp_issuer ON identity_providers (issuer_url) WHERE issuer_url IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS identity_providers`);
  }
}
