import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Why a session's worker died, in the session's own row.
 *
 * A worker driving an ICICI replay was OOMKilled 32 minutes in. Nothing in its
 * log complained — heartbeats, health PASS, artifacts fresh, then gone — so the
 * only thing anyone saw was the API's "Worker unreachable: fetch failed", which
 * reads as a flaky skill. Four explanations were chased and discarded before
 * somebody read the pod status.
 *
 * Only the controller can see a pod's termination reason (it holds the
 * Kubernetes client), and only the API answers the caller. This column is how
 * the first tells the second.
 */
export class AddSessionRuntimeError1708300000034 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "last_runtime_error" varchar(256)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "last_runtime_error"`);
  }
}
