import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Warm recording-session pool support. `pool_state` marks a session as a
 * pre-warmed spare ('WARM') that a recording request can atomically claim
 * ('CLAIMED'). null = an ordinary session (all existing rows). The partial
 * index backs the hot claim query
 *   SELECT ... WHERE app_id = $pool AND pool_state = 'WARM' AND state = 'HEALTHY'
 *   FOR UPDATE SKIP LOCKED
 * so concurrent API replicas grab distinct spares without contention.
 */
export class AddSessionPoolState1708300000032 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "pool_state" varchar(16)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_sessions_pool_claim" ON "sessions" ("app_id", "pool_state", "state") WHERE "pool_state" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sessions_pool_claim"`);
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "pool_state"`);
  }
}
