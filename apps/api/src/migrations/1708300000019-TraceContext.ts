import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Distributed-trace propagation columns.
 *
 * - sessions.traceparent: W3C trace context the controller stamps onto the
 *   worker pod's TRACEPARENT env so the browser worker continues the trace.
 * - applications.pending_traceparent: trace context parked by the API at scale
 *   time; the controller consumes it onto the session it creates and clears it.
 *
 * Together these wire the api -> controller -> worker distributed trace.
 */
export class TraceContext1708300000019 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS traceparent varchar`);
    await queryRunner.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS pending_traceparent varchar`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE applications DROP COLUMN IF EXISTS pending_traceparent`);
    await queryRunner.query(`ALTER TABLE sessions DROP COLUMN IF EXISTS traceparent`);
  }
}
