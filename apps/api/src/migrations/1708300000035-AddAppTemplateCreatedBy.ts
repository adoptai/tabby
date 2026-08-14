import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record who created an app template, so the creator can update it.
 *
 * POST /admin/app-templates is open to any authenticated user ("Any
 * authenticated user can create templates in their own tenant"), but PUT/PATCH
 * required Admin or Editor. An Operator could therefore create a template and
 * then be forbidden from finishing it — which is exactly what NoUI's combined
 * capture does: it registers the login template, then PATCHes it to extend the
 * profile scope for the workflow half. That second call 403'd and the scope
 * extension was silently skipped.
 *
 * Nullable with no backfill: rows created before this migration have no known
 * creator, and NULL must not be mistaken for "created by nobody, so anyone may
 * edit it". The authorization check treats NULL as "no creator claim" and falls
 * back to the Admin/Editor requirement, so existing templates keep exactly the
 * permissions they have today.
 */
export class AddAppTemplateCreatedBy1708300000035 implements MigrationInterface {
  name = 'AddAppTemplateCreatedBy1708300000035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_templates" ADD COLUMN IF NOT EXISTS "created_by_user_id" varchar(128)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_templates" DROP COLUMN IF EXISTS "created_by_user_id"`,
    );
  }
}
