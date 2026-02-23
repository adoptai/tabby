#!/usr/bin/env npx ts-node
/**
 * Slack/Teams Identity Mapping CLI Script (Task 49)
 *
 * Maps external user IDs (Slack/Teams) to platform users via user_identities table.
 * Usage: npx ts-node scripts/map-identity.ts --user-id <uuid> --provider slack --external-id U12345 --workspace-id T12345
 */

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

interface MapIdentityArgs {
  userId: string;
  provider: 'slack' | 'teams';
  externalId: string;
  workspaceId: string;
}

function parseArgs(): MapIdentityArgs {
  const args = process.argv.slice(2);
  let userId = '';
  let provider: 'slack' | 'teams' = 'slack';
  let externalId = '';
  let workspaceId = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--user-id':
        userId = args[++i];
        break;
      case '--provider':
        provider = args[++i] as 'slack' | 'teams';
        break;
      case '--external-id':
        externalId = args[++i];
        break;
      case '--workspace-id':
        workspaceId = args[++i];
        break;
    }
  }

  if (!userId || !externalId || !workspaceId) {
    console.error(
      'Usage: map-identity.ts --user-id <uuid> --provider slack|teams --external-id <id> --workspace-id <id>',
    );
    process.exit(1);
  }

  if (provider !== 'slack' && provider !== 'teams') {
    console.error('Provider must be "slack" or "teams"');
    process.exit(1);
  }

  return { userId, provider, externalId, workspaceId };
}

async function mapIdentity(args: MapIdentityArgs): Promise<void> {
  if (!ADMIN_TOKEN) {
    console.error('ADMIN_TOKEN environment variable is required');
    process.exit(1);
  }

  console.log(
    `Mapping identity: user=${args.userId} provider=${args.provider} external=${args.externalId} workspace=${args.workspaceId}`,
  );

  const response = await fetch(`${API_BASE_URL}/users/${args.userId}/identities`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({
      provider: args.provider,
      external_id: args.externalId,
      workspace_id: args.workspaceId,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    console.error(`Failed to map identity: ${response.status}`, error);
    process.exit(1);
  }

  const identity = await response.json();
  console.log('Identity mapped successfully:');
  console.log(JSON.stringify(identity, null, 2));
}

const args = parseArgs();
mapIdentity(args).catch((error) => {
  console.error(`Error: ${error}`);
  process.exit(1);
});
