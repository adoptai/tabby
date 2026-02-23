#!/usr/bin/env node
/**
 * Canary gate bypass for E2E testing.
 *
 * Directly updates service_profiles.canary_request_count to satisfy
 * the CANARY_MIN_REQUESTS (5) gate for promotion to ACTIVE.
 *
 * Usage:
 *   node canary-bypass.js <profile_uuid>
 *
 * Environment:
 *   DATABASE_URL - PostgreSQL connection string (default: from kubectl port-forward)
 */

const { Client } = require('pg');

const profileId = process.argv[2];
if (!profileId) {
  console.error('Usage: node canary-bypass.js <profile_uuid>');
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://browser_hitl:browser_hitl@localhost:25432/browser_hitl';

(async () => {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const result = await client.query(
    `UPDATE service_profiles
     SET canary_request_count = 5, canary_error_count = 0
     WHERE id = $1
     RETURNING id, profile_id, state, canary_request_count`,
    [profileId],
  );

  if (result.rowCount === 0) {
    console.error(`Profile ${profileId} not found`);
    await client.end();
    process.exit(1);
  }

  console.log('Updated:', JSON.stringify(result.rows[0]));
  await client.end();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
