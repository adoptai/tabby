import { MigrationInterface, QueryRunner } from 'typeorm';

export class MultiTenantCloud1708300000015 implements MigrationInterface {
  name = 'MultiTenantCloud1708300000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Change tenants.id from uuid to varchar (allows custom IDs like Frontegg org IDs)
    // All FK columns referencing tenants.id also need to change from uuid to varchar.
    // In Postgres, uuid values are valid varchar values, so no data loss.

    // 1. Drop FKs referencing tenants.id — discovered dynamically by column + referenced table,
    //    not by constraint name (name-based matching is fragile across TypeORM versions).
    const fks = await queryRunner.query(`
      SELECT kcu.table_name, kcu.constraint_name
      FROM information_schema.key_column_usage kcu
      JOIN information_schema.referential_constraints rc
        ON kcu.constraint_name = rc.constraint_name
        AND kcu.constraint_schema = rc.constraint_schema
      JOIN information_schema.key_column_usage kcu2
        ON rc.unique_constraint_name = kcu2.constraint_name
        AND rc.unique_constraint_schema = kcu2.constraint_schema
      WHERE kcu.column_name = 'tenant_id'
        AND kcu2.table_name = 'tenants'
        AND kcu2.column_name = 'id'
        AND kcu.table_schema = 'public'
    `);

    const fkTables: string[] = [];
    for (const fk of fks) {
      await queryRunner.query(`ALTER TABLE "${fk.table_name}" DROP CONSTRAINT "${fk.constraint_name}"`);
      if (!fkTables.includes(fk.table_name)) fkTables.push(fk.table_name);
    }

    // 2. Drop default on tenants.id (InitialSchema sets DEFAULT gen_random_uuid() — some Postgres
    //    versions reject ALTER COLUMN TYPE when a typed default exists), then change to varchar.
    await queryRunner.query(`ALTER TABLE "tenants" ALTER COLUMN "id" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "tenants" ALTER COLUMN "id" TYPE varchar(255) USING id::varchar`);

    // 3. Change all tenant_id FK columns from uuid to varchar
    for (const table of fkTables) {
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "tenant_id" TYPE varchar(255) USING tenant_id::varchar`);
    }

    // 4. Re-add FK constraints
    for (const table of fkTables) {
      await queryRunner.query(`
        ALTER TABLE "${table}" ADD CONSTRAINT "fk_${table}_tenant_id"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
      `);
    }

    // 5. Reindex composite indexes that include tenant_id (stats may drift after type change)
    const idxExists = await queryRunner.query(`
      SELECT 1 FROM pg_indexes WHERE indexname = 'idx_auth_requests_tenant_app'
    `);
    if (idxExists.length > 0) {
      await queryRunner.query(`REINDEX INDEX "idx_auth_requests_tenant_app"`);
    }

    // 6. Add tenant_id_claim to identity_providers for dynamic tenant routing from JWT
    await queryRunner.query(`
      ALTER TABLE "identity_providers"
      ADD COLUMN IF NOT EXISTS "tenant_id_claim" varchar NULL
    `);

    // 7. Fix unique indexes on service_profiles to include owner_user_id (multi-user support)
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
