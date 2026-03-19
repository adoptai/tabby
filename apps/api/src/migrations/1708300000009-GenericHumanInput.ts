import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add generic human input support columns.
 * - sessions.pending_input_request: JSONB for worker to signal what input is needed
 * - interventions.input_request_metadata: JSONB for the input request details
 * - Add INPUT_NEEDED to intervention_type enum
 */
export class GenericHumanInput1708300000009 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add pending_input_request to sessions
    await queryRunner.query(`
      ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS pending_input_request jsonb DEFAULT NULL
    `);

    // Add input_request_metadata to interventions
    await queryRunner.query(`
      ALTER TABLE interventions
      ADD COLUMN IF NOT EXISTS input_request_metadata jsonb DEFAULT NULL
    `);

    // Add INPUT_NEEDED to intervention type enum if it doesn't exist
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel = 'INPUT_NEEDED'
          AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'interventions_type_enum')
        ) THEN
          ALTER TYPE interventions_type_enum ADD VALUE 'INPUT_NEEDED';
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE interventions DROP COLUMN IF EXISTS input_request_metadata
    `);
    await queryRunner.query(`
      ALTER TABLE sessions DROP COLUMN IF EXISTS pending_input_request
    `);
    // Note: Cannot remove enum values in PostgreSQL without recreating the type
  }
}
