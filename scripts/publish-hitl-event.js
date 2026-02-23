#!/usr/bin/env node
/*
 * Publish a HITL test event to NATS for manual Slack/Teams bot validation.
 *
 * Usage:
 *   NATS_URL=nats://localhost:4222 node scripts/publish-hitl-event.js \
 *     --type started \
 *     --tenant-id <tenant_uuid> \
 *     --session-id <session_uuid> \
 *     --app-id <app_uuid>
 */

const { connect, StringCodec } = require('nats');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    type: 'started',
    tenantId: '',
    sessionId: '',
    appId: '',
    reason: 'AUTH_FAIL',
    appName: 'batch-a-app',
  };

  for (let i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case '--type':
        out.type = String(args[i + 1] || out.type);
        i += 1;
        break;
      case '--tenant-id':
        out.tenantId = String(args[i + 1] || '');
        i += 1;
        break;
      case '--session-id':
        out.sessionId = String(args[i + 1] || '');
        i += 1;
        break;
      case '--app-id':
        out.appId = String(args[i + 1] || '');
        i += 1;
        break;
      case '--reason':
        out.reason = String(args[i + 1] || out.reason);
        i += 1;
        break;
      case '--app-name':
        out.appName = String(args[i + 1] || out.appName);
        i += 1;
        break;
      default:
        break;
    }
  }
  return out;
}

async function main() {
  const { type, tenantId, sessionId, appId, reason, appName } = parseArgs();
  if (!tenantId || !sessionId || !appId) {
    console.error(
      'Usage: publish-hitl-event.js --type started|otp-requested --tenant-id <uuid> --session-id <uuid> --app-id <uuid>',
    );
    process.exit(2);
  }

  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';
  const nc = await connect({ servers: natsUrl });
  const sc = StringCodec();

  const timestamp = new Date().toISOString();
  let subject;
  let payload;

  if (type === 'otp-requested') {
    subject = `hitl.otp-requested.${tenantId}.${sessionId}`;
    payload = {
      type: 'hitl.otp-requested',
      timestamp,
      payload: {
        tenant_id: tenantId,
        session_id: sessionId,
        app_id: appId,
        app_name: appName,
      },
    };
  } else {
    subject = `hitl.started.${tenantId}.${sessionId}`;
    payload = {
      type: 'hitl.started',
      timestamp,
      payload: {
        tenant_id: tenantId,
        session_id: sessionId,
        app_id: appId,
        reason,
        intervention_id: `manual-${Date.now()}`,
      },
    };
  }

  nc.publish(subject, sc.encode(JSON.stringify(payload)));
  await nc.flush();
  await nc.drain();

  process.stdout.write(
    JSON.stringify(
      {
        published: true,
        nats_url: natsUrl,
        subject,
        payload,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
