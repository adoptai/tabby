import { MigrationInterface, QueryRunner } from 'typeorm';

export class WorkerRLS1708300000001 implements MigrationInterface {
  name = 'WorkerRLS1708300000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create dedicated worker database role
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'worker') THEN
          CREATE ROLE worker LOGIN PASSWORD 'worker_password';
        END IF;
      END
      $$;
    `);

    // Grant worker scoped permissions per spec section 9.6
    await queryRunner.query(`GRANT SELECT, UPDATE ON "sessions" TO worker`);
    await queryRunner.query(`GRANT INSERT, SELECT ON "artifact_bundles" TO worker`);
    await queryRunner.query(`GRANT INSERT ON "audit_events" TO worker`);
    await queryRunner.query(`GRANT USAGE ON SEQUENCE "audit_events_sequence_num_seq" TO worker`);

    // Enable RLS on worker-accessed tables
    await queryRunner.query(`ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "artifact_bundles" ENABLE ROW LEVEL SECURITY`);

    // RLS policy for sessions: worker can only access its own session
    await queryRunner.query(`
      CREATE POLICY worker_sessions_policy ON "sessions"
        FOR ALL
        TO worker
        USING (id::text = current_setting('app.session_id', true))
    `);

    // RLS policy for artifact_bundles: worker can only insert for its own session
    await queryRunner.query(`
      CREATE POLICY worker_artifact_bundles_policy ON "artifact_bundles"
        FOR ALL
        TO worker
        USING (session_id::text = current_setting('app.session_id', true))
    `);

    // Audit events: worker can insert but not read others' events
    await queryRunner.query(`ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY worker_audit_insert_policy ON "audit_events"
        FOR INSERT
        TO worker
        WITH CHECK (true)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS worker_audit_insert_policy ON "audit_events"`);
    await queryRunner.query(`ALTER TABLE "audit_events" DISABLE ROW LEVEL SECURITY`);

    await queryRunner.query(`DROP POLICY IF EXISTS worker_artifact_bundles_policy ON "artifact_bundles"`);
    await queryRunner.query(`ALTER TABLE "artifact_bundles" DISABLE ROW LEVEL SECURITY`);

    await queryRunner.query(`DROP POLICY IF EXISTS worker_sessions_policy ON "sessions"`);
    await queryRunner.query(`ALTER TABLE "sessions" DISABLE ROW LEVEL SECURITY`);

    await queryRunner.query(`REVOKE ALL ON "audit_events" FROM worker`);
    await queryRunner.query(`REVOKE ALL ON "artifact_bundles" FROM worker`);
    await queryRunner.query(`REVOKE ALL ON "sessions" FROM worker`);
  }
}
