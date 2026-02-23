#!/usr/bin/env node
/*
 * Seed a synthetic session + baton for Batch A local execution when no controller/K8s session exists.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/batch-a-seed-session.js <app_id> <tenant_id> [pod_name]
 */

const path = require('path');

function resolvePgClient() {
  const resolutionBases = [
    process.cwd(),
    __dirname,
    path.join(__dirname, '..', 'apps', 'api'),
  ];

  for (const base of resolutionBases) {
    try {
      const pgPath = require.resolve('pg', { paths: [base] });
      return require(pgPath).Client;
    } catch {
      // try next base
    }
  }

  throw new Error(
    "Unable to resolve 'pg'. Run from the repo with dependencies installed (e.g. pnpm install).",
  );
}

const Client = resolvePgClient();

async function main() {
  const appId = process.argv[2];
  const tenantId = process.argv[3];
  const podName = process.argv[4] || `batcha-local-${Date.now()}`;

  if (!appId || !tenantId) {
    console.error('Usage: batch-a-seed-session.js <app_id> <tenant_id> [pod_name]');
    process.exit(2);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await client.query('BEGIN');

    const sessionInsert = await client.query(
      `
      INSERT INTO sessions (
        app_id,
        tenant_id,
        state,
        state_version,
        retry_count,
        intervention_count,
        hitl_attempt_count,
        pod_name
      ) VALUES (
        $1,
        $2,
        'LOGIN_IN_PROGRESS',
        0,
        0,
        0,
        0,
        $3
      )
      RETURNING id, app_id, tenant_id, state, pod_name
      `,
      [appId, tenantId, podName],
    );

    const session = sessionInsert.rows[0];
    if (!session || !session.id) {
      throw new Error('Failed to insert synthetic session');
    }

    await client.query(
      `
      INSERT INTO session_batons (
        session_id,
        baton_state,
        owner_user_id,
        requested_at,
        acquired_at,
        expires_at,
        version
      ) VALUES (
        $1,
        'HUMAN_REQUESTED',
        NULL,
        NOW(),
        NULL,
        NOW() + INTERVAL '15 minutes',
        0
      )
      `,
      [session.id],
    );

    await client.query('COMMIT');

    process.stdout.write(
      JSON.stringify(
        {
          seeded: true,
          session,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
