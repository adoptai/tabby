import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-010: Agent Authentication via OAuth 2.0 Client Credentials
 *
 * Creates the agent_clients table for per-agent registration with:
 * - HMAC-SHA256 hashed secrets (not bcrypt — machine secrets are high-entropy)
 * - Profile-scoped access control
 * - Independent revocation and rotation
 */
export class AgentClients1708300000002 implements MigrationInterface {
  name = 'AgentClients1708300000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "agent_clients" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "client_id" varchar NOT NULL,
        "client_secret_hash" varchar NOT NULL,
        "name" varchar NOT NULL,
        "tenant_id" uuid NOT NULL,
        "allowed_profiles" text NOT NULL DEFAULT '',
        "token_ttl_seconds" integer NOT NULL DEFAULT 3600,
        "rate_limit_per_minute" integer NOT NULL DEFAULT 30,
        "enabled" boolean NOT NULL DEFAULT true,
        "last_used_at" TIMESTAMP WITH TIME ZONE,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_clients" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_agent_clients_client_id" UNIQUE ("client_id"),
        CONSTRAINT "FK_agent_clients_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_agent_clients_client_id" ON "agent_clients" ("client_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_agent_clients_tenant_id" ON "agent_clients" ("tenant_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_agent_clients_tenant_id"`);
    await queryRunner.query(`DROP INDEX "IDX_agent_clients_client_id"`);
    await queryRunner.query(`DROP TABLE "agent_clients"`);
  }
}
