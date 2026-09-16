import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record WHICH template pattern an app was provisioned from, in a column that a
 * template deletion cannot erase.
 *
 * `applications.template_id` carries `ON DELETE SET NULL` (migration 020), so
 * deleting a template silently nulls it on every app it provisioned. The app
 * keeps running with the policy it was cloned with, and becomes
 * indistinguishable from a manually-created app -- the entity comment on
 * `template_id` says as much ("null for manually-created apps").
 *
 * Re-registering the template under the same `profile_name_pattern` mints a NEW
 * id, so `propagateToLinkedApps` (which filters `where template_id = :id`)
 * matches nothing and the app's browser_policy is frozen for good. Observed on
 * org 87451b06: a template carrying `downloads: true` and `block_navigate: true`
 * with zero provisioned apps, while the session it was meant to govern ran with
 * downloads off and cancelled every statement it tried to fetch.
 *
 * `template_pattern` survives the delete, so a re-registered template can adopt
 * exactly the apps it once owned -- and only those. An app that never came from
 * a template has this null and is never touched.
 */
export class AddAppTemplatePattern1708300000036 implements MigrationInterface {
  name = 'AddAppTemplatePattern1708300000036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS template_pattern varchar
    `);
    // Backfill what is still knowable: apps whose link survives. An app already
    // orphaned by a past delete cannot be recovered here -- the column that said
    // where it came from was nulled before this migration existed.
    await queryRunner.query(`
      UPDATE applications a
         SET template_pattern = t.profile_name_pattern
        FROM app_templates t
       WHERE a.template_id = t.id
         AND a.template_pattern IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_applications_template_pattern
        ON applications (tenant_id, template_pattern)
        WHERE template_pattern IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_applications_template_pattern`);
    await queryRunner.query(`ALTER TABLE applications DROP COLUMN IF EXISTS template_pattern`);
  }
}
