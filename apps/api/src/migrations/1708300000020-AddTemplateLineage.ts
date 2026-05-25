import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTemplateLineage1708300000020 implements MigrationInterface {
  name = 'AddTemplateLineage1708300000020';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS template_id uuid
    `);
    await queryRunner.query(`
      ALTER TABLE applications ADD CONSTRAINT fk_applications_template
        FOREIGN KEY (template_id) REFERENCES app_templates(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_applications_template_id ON applications (template_id) WHERE template_id IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_applications_template_id
    `);
    await queryRunner.query(`
      ALTER TABLE applications DROP CONSTRAINT IF EXISTS fk_applications_template
    `);
    await queryRunner.query(`
      ALTER TABLE applications DROP COLUMN IF EXISTS template_id
    `);
  }
}
