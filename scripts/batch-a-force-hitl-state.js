#!/usr/bin/env node
/*
 * Force HITL takeover preconditions for Batch A test execution.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/batch-a-force-hitl-state.js <session_id>
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
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error('Usage: batch-a-force-hitl-state.js <session_id>');
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

    const sessionResult = await client.query(
      `
      UPDATE sessions
         SET state = 'LOGIN_IN_PROGRESS',
             state_version = state_version + 1
       WHERE id = $1
       RETURNING id, state, state_version
      `,
      [sessionId],
    );
    if (sessionResult.rowCount !== 1) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const batonResult = await client.query(
      `
      UPDATE session_batons
         SET baton_state = 'HUMAN_REQUESTED',
             owner_user_id = NULL,
             requested_at = NOW(),
             acquired_at = NULL,
             expires_at = NOW() + INTERVAL '15 minutes',
             version = version + 1
       WHERE session_id = $1
       RETURNING session_id, baton_state, version
      `,
      [sessionId],
    );
    if (batonResult.rowCount !== 1) {
      throw new Error(`Session baton for ${sessionId} not found`);
    }

    await client.query('COMMIT');

    process.stdout.write(
      JSON.stringify(
        {
          forced: true,
          session: sessionResult.rows[0],
          baton: batonResult.rows[0],
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
