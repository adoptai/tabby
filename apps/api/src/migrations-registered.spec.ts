import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every migration file must be registered in data-source.ts.
 *
 * `migrations` there is an explicit array of imported classes, not a glob, so
 * adding a migration is a TWO-step operation and nothing enforced the second
 * step. A file that is never imported compiles, ships in the image, and simply
 * does not run.
 *
 * It fails quietly in the worst way: an existing database keeps working, so the
 * gap only surfaces wherever the new column is read. AddAppTemplateCreatedBy
 * (035) went unregistered and every combined capture_import broke on
 * `column AppTemplateEntity.created_by_user_id does not exist` -- a 500 that was
 * misread twice as a stale build. AddSessionRuntimeError (034) was unregistered
 * too and NOTHING noticed, because it had already been applied by hand; a fresh
 * database would have skipped it silently.
 *
 * Reads the directory rather than importing, so a file nobody references is
 * still seen.
 */
describe('migration registration', () => {
  const migrationsDir = join(__dirname, 'migrations');
  const dataSourceSrc = readFileSync(join(__dirname, 'data-source.ts'), 'utf8');

  const classNames = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => {
      const source = readFileSync(join(migrationsDir, f), 'utf8');
      const match = source.match(/export class (\w+)\s+implements MigrationInterface/);
      return { file: f, className: match ? match[1] : null };
    });

  it('finds a migration class in every migration file', () => {
    const nameless = classNames.filter((m) => !m.className).map((m) => m.file);
    expect(nameless).toEqual([]);
  });

  it.each(classNames.filter((m) => m.className))(
    'registers $className in data-source.ts',
    ({ className }) => {
      // Imported AND listed: an import alone leaves it just as unrun, and TypeScript
      // would flag the unused import rather than the missing migration.
      expect(dataSourceSrc).toContain(`import { ${className} }`);
      // Word boundary so ...034 cannot be satisfied by ...0034 or a longer name.
      expect(dataSourceSrc).toMatch(new RegExp(`\\b${className}\\b\\s*[,\\]]`));
    },
  );

  it('registers them in filename order, so they apply in the order they were written', () => {
    const listed = classNames
      .filter((m) => m.className)
      .map((m) => ({ file: m.file, at: dataSourceSrc.lastIndexOf(m.className as string) }))
      .filter((m) => m.at >= 0);
    const byFilename = [...listed].sort((a, b) => a.file.localeCompare(b.file));
    expect(byFilename.map((m) => m.file)).toEqual(
      [...listed].sort((a, b) => a.at - b.at).map((m) => m.file),
    );
  });
});
