import { MigrationInterface, QueryRunner } from 'typeorm';

export class MultiTenantCloud1708300000015 implements MigrationInterface {
  name = 'MultiTenantCloud1708300000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Change tenants.id from uuid to varchar (allows custom IDs like Frontegg org IDs)
    // All FK columns referencing tenants.id also need to change from uuid to varchar.
    // In Postgres, uuid values are valid varchar values, so no data loss.

    // 1. Drop FKs referencing tenants.id
    const fkTables = [
      'applications', 'sessions', 'service_profiles', 'agent_clients',
      'users', 'identity_providers', 'app_templates', 'auth_requests',
      'interventions', 'artifact_bundles', 'login_queue', 'user_identities',
      'audit_events',
    ];

    for (const table of fkTables) {
      // Find and drop FK constraint for tenant_id
      const fks = await queryRunner.query(`
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_name = '${table}' AND constraint_type = 'FOREIGN KEY'
        AND constraint_name LIKE '%tenant%'
      `);
      for (const fk of fks) {
        await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${fk.constraint_name}"`);
      }
    }

    // 2. Change tenants.id from uuid to varchar
    await queryRunner.query(`ALTER TABLE "tenants" ALTER COLUMN "id" TYPE varchar(255) USING id::varchar`);

    // 3. Change all tenant_id FK columns from uuid to varchar
    for (const table of fkTables) {
      const hasColumn = await queryRunner.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = '${table}' AND column_name = 'tenant_id'
      `);
      if (hasColumn.length > 0) {
        await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "tenant_id" TYPE varchar(255) USING tenant_id::varchar`);
      }
    }

    // 4. Re-add FK constraints
    for (const table of fkTables) {
      const hasColumn = await queryRunner.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = '${table}' AND column_name = 'tenant_id'
      `);
      if (hasColumn.length > 0) {
        await queryRunner.query(`
          ALTER TABLE "${table}" ADD CONSTRAINT "fk_${table}_tenant_id"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
        `);
      }
    }

    // 5. Add tenant_id_claim to identity_providers for dynamic tenant routing from JWT
    await queryRunner.query(`
      ALTER TABLE "identity_providers"
      ADD COLUMN IF NOT EXISTS "tenant_id_claim" varchar NULL
    `);

    // 6. Fix unique indexes on service_profiles to include owner_user_id (multi-user support)
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_service_profiles_version_unique"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_service_profiles_version_unique"
      ON "service_profiles" ("tenant_id", "profile_id", "version", COALESCE("owner_user_id", ''))
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_service_profiles_active_unique"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_service_profiles_active_unique"
      ON "service_profiles" ("tenant_id", "profile_id", COALESCE("owner_user_id", ''))
      WHERE ("version_state" = 'ACTIVE')
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_service_profiles_canary_unique"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_service_profiles_canary_unique"
      ON "service_profiles" ("tenant_id", "profile_id", COALESCE("owner_user_id", ''))
      WHERE ("version_state" = 'CANARY')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "identity_providers" DROP COLUMN IF EXISTS "tenant_id_claim"`);
    // Note: reverting varchar back to uuid would fail if non-UUID IDs exist.
    // This is intentionally not reversed.
  }
}
