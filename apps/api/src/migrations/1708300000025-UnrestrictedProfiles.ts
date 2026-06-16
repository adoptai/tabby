import { MigrationInterface, QueryRunner } from 'typeorm';

export class UnrestrictedProfiles1708300000025 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_clients" ADD COLUMN "unrestricted_profiles" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_clients" DROP COLUMN "unrestricted_profiles"`,
    );
  }
}
