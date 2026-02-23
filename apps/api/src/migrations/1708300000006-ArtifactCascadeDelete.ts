import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds ON DELETE CASCADE to the artifact_consumptions → artifact_bundles FK.
 *
 * The ArtifactExpirationService deletes expired artifact_bundles rows, but the
 * original FK was created without CASCADE, causing constraint violations when
 * consumption records exist.
 */
export class ArtifactCascadeDelete1708300000006 implements MigrationInterface {
  name = 'ArtifactCascadeDelete1708300000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the existing FK and re-create with ON DELETE CASCADE
    await queryRunner.query(`
      ALTER TABLE "artifact_consumptions"
        DROP CONSTRAINT "artifact_consumptions_artifact_id_fkey",
        ADD CONSTRAINT "artifact_consumptions_artifact_id_fkey"
          FOREIGN KEY ("artifact_id") REFERENCES "artifact_bundles"("id")
          ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "artifact_consumptions"
        DROP CONSTRAINT "artifact_consumptions_artifact_id_fkey",
        ADD CONSTRAINT "artifact_consumptions_artifact_id_fkey"
          FOREIGN KEY ("artifact_id") REFERENCES "artifact_bundles"("id")
    `);
  }
}
