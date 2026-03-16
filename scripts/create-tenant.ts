#!/usr/bin/env npx ts-node
/**
 * Tenant Creation CLI Script (Task 48)
 *
 * Creates a tenant via the API and provisions resources.
 * Usage: npx ts-node scripts/create-tenant.ts --name "Acme Corp" --max-sessions 10
 */

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

interface CreateTenantArgs {
  name: string;
  maxSessions: number;
}

function parseArgs(): CreateTenantArgs {
  const args = process.argv.slice(2);
  let name = '';
  let maxSessions = 10;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      name = args[++i];
    } else if (args[i] === '--max-sessions' && args[i + 1]) {
      maxSessions = parseInt(args[++i], 10);
    }
  }

  if (!name) {
    console.error('Usage: create-tenant.ts --name "Tenant Name" [--max-sessions 10]');
    process.exit(1);
  }

  return { name, maxSessions };
}

async function createTenant(args: CreateTenantArgs): Promise<void> {
  if (!ADMIN_TOKEN) {
    console.error('ADMIN_TOKEN environment variable is required');
    process.exit(1);
  }

  console.log(`Creating tenant: ${args.name} (max_sessions: ${args.maxSessions})`);

  const response = await fetch(`${API_BASE_URL}/tenants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({
      name: args.name,
      max_sessions: args.maxSessions,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    console.error(`Failed to create tenant: ${response.status}`, error);
    process.exit(1);
  }

  const tenant = await response.json();
  console.log('Tenant created successfully:');
  console.log(JSON.stringify(tenant, null, 2));
  console.log(`\nTenant ID: ${tenant.id}`);
  console.log(`MinIO bucket: artifact-bundles-${tenant.id}`);
}

const args = parseArgs();
createTenant(args).catch((error) => {
  console.error(`Error: ${error}`);
  process.exit(1);
});
