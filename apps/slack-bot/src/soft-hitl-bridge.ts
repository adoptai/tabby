import {
  connect, NatsConnection, StringCodec, Subscription,
  JetStreamClient, JetStreamSubscription,
  consumerOpts, AckPolicy, DeliverPolicy,
  RetentionPolicy, StorageType,
} from 'nats';
import {
  HitlCompletedEvent,
  HitlStartedEvent,
  SessionStateChangedEvent,
} from '@browser-hitl/shared';

type AnySubscription = Subscription | JetStreamSubscription;

type PendingSession = {
  tenantId: string;
  appId: string;
  createdAt: number;
  otpSubmittedAt?: number;
};

const sc = StringCodec();
const pendingSessions = new Map<string, PendingSession>();
const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();

const slackToken = process.env.SLACK_BOT_TOKEN || '';
const slackChannelTarget = process.env.SLACK_CHANNEL || '#tabby-experiments';
const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';
const apiBaseUrl = (process.env.API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const serviceClientId = process.env.SERVICE_AUTH_CLIENT_ID || '';
const serviceClientSecret = process.env.SERVICE_AUTH_CLIENT_SECRET || '';
const pollIntervalMs = Number(process.env.SLACK_SOFT_POLL_INTERVAL_MS || '3000');
const maxPendingAgeMs = Number(process.env.SLACK_SOFT_PENDING_MAX_AGE_MS || String(2 * 60 * 60 * 1000));
const allowUnrestrictedOperators = (process.env.SLACK_SOFT_ALLOW_UNRESTRICTED_OPERATORS || '')
  .trim()
  .toLowerCase() === 'true';
const allowedOperatorUserIds = new Set(
  (process.env.SLACK_SOFT_ALLOWED_USER_IDS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);
const commandHistoryPageLimit = Math.max(1, Math.min(200, Number(process.env.SLACK_SOFT_COMMAND_PAGE_LIMIT || '200')));
const commandHistoryMaxPages = Math.max(1, Math.min(50, Number(process.env.SLACK_SOFT_COMMAND_MAX_PAGES || '20')));
const slackReplyUrlOverride = (process.env.SLACK_REPLY_URL || '').trim();

let activeChannelId = '';
let botUserId = '';
let latestSeenTs = '0';
let workspaceTeamId = '';
type SlackBlock = Record<string, unknown>;
type SlackElement = Record<string, unknown>;

function ensureEnv(): void {
  const missing: string[] = [];
  if (!slackToken) missing.push('SLACK_BOT_TOKEN');
  if (!serviceClientId) missing.push('SERVICE_AUTH_CLIENT_ID');
  if (!serviceClientSecret) missing.push('SERVICE_AUTH_CLIENT_SECRET');
  if (!allowUnrestrictedOperators && allowedOperatorUserIds.size === 0) {
    missing.push('SLACK_SOFT_ALLOWED_USER_IDS (or set SLACK_SOFT_ALLOW_UNRESTRICTED_OPERATORS=true)');
  }
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

async function slackApi(method: string, params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams(params);
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${slackToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const payload = await response.json() as Record<string, any>;
  if (!payload.ok) {
    throw new Error(`${method} failed: ${payload.error ?? 'unknown'} | full=${JSON.stringify(payload)}`);
  }
  return payload;
}

async function postSlackMessage(
  text: string,
  blocks?: SlackBlock[],
): Promise<{ channel: string; ts: string }> {
  const params: Record<string, string> = {
    channel: activeChannelId || slackChannelTarget,
    text,
  };
  if (blocks && blocks.length > 0) {
    params.blocks = JSON.stringify(blocks);
  }
  const result = await slackApi('chat.postMessage', params);
  return { channel: result.channel, ts: result.ts };
}

async function getServiceToken(tenantId: string): Promise<string> {
  const cached = tokenCache.get(tenantId);
  if (cached && cached.expiresAtMs > Date.now() + 30_000) {
    return cached.token;
  }

  if (!serviceClientId || !serviceClientSecret) {
    throw new Error(
      'Service credentials are not configured. Set SERVICE_AUTH_CLIENT_ID and SERVICE_AUTH_CLIENT_SECRET.',
    );
  }

  const response = await fetch(`${apiBaseUrl}/auth/service-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: serviceClientId,
      client_secret: serviceClientSecret,
      tenant_id: tenantId,
      role: 'Operator',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`service-token request failed (${response.status}): ${body}`);
  }

  const body = await response.json() as Record<string, any>;
  const token = String(body.token || body.access_token || '');
  if (!token) {
    throw new Error(`service-token response missing token: ${JSON.stringify(body)}`);
  }
  const expiresAtMs = Number.isFinite(Date.parse(String(body.expires_at)))
    ? Date.parse(String(body.expires_at))
    : Date.now() + (55 * 60 * 1000);
  tokenCache.set(tenantId, { token, expiresAtMs });
  return token;
}

function buildSlackReplyUrl(): string {
  if (slackReplyUrlOverride) {
    return slackReplyUrlOverride;
  }

  const channel = (activeChannelId || slackChannelTarget || '').replace(/^#/, '').trim();
  if (!channel) {
    return 'https://slack.com/app';
  }

  const params = new URLSearchParams({ channel });
  if (workspaceTeamId) {
    params.set('team', workspaceTeamId);
  }
  return `https://slack.com/app_redirect?${params.toString()}`;
}

async function requestStreamUrl(sessionId: string, tenantId: string): Promise<string> {
  const token = await getServiceToken(tenantId);
  const response = await fetch(`${apiBaseUrl}/sessions/${sessionId}/stream`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`stream request failed (${response.status}): ${body}`);
  }
  const payload = await response.json() as Record<string, any>;
  return String(payload.url || '');
}

async function submitOtp(sessionId: string, otpValue: string, tenantId: string): Promise<void> {
  const token = await getServiceToken(tenantId);
  const response = await fetch(`${apiBaseUrl}/sessions/${sessionId}/otp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ otp_value: otpValue }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OTP submit failed (${response.status}): ${body}`);
  }
}

function cleanupPendingSessions(): void {
  const now = Date.now();
  for (const [sessionId, entry] of pendingSessions.entries()) {
    if (now - entry.createdAt > maxPendingAgeMs) {
      pendingSessions.delete(sessionId);
    }
  }
}

async function handleHitlStarted(data: HitlStartedEvent): Promise<void> {
  const { session_id: sessionId, tenant_id: tenantId, app_id: appId } = data.payload;
  pendingSessions.set(sessionId, {
    tenantId,
    appId,
    createdAt: Date.now(),
  });

  let streamUrl = '';
  let streamError = '';
  try {
    streamUrl = await requestStreamUrl(sessionId, tenantId);
  } catch (error) {
    streamError = error instanceof Error ? error.message : String(error);
  }

  const command = `OTP ${sessionId} <one-time-code>`;
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Action Required: Salesforce Authentication 🔒', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'plain_text',
        text: 'Your adopt.ai agent requires authentication to proceed. Please submit your one time password (OTP) so the work can proceed!',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Reply in this channel with:\n\`${command}\``,
      },
    },
  ];

  const actionElements: SlackElement[] = [];
  if (streamUrl) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Open Live Stream', emoji: true },
      style: 'primary',
      url: streamUrl,
    });
  } else if (streamError) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Stream link unavailable right now: ${streamError}`,
        },
      ],
    });
  }

  if (actionElements.length > 0) {
    blocks.push({
      type: 'actions',
      elements: actionElements,
    });
  }

  await postSlackMessage(
    'Action Required: Salesforce Authentication 🔒',
    blocks,
  );
}

async function handleStateChanged(data: SessionStateChangedEvent): Promise<void> {
  const {
    session_id: sessionId,
    old_state: oldState,
    new_state: newState,
  } = data.payload;

  const pending = pendingSessions.get(sessionId);
  if (!pending) {
    return;
  }

  if (newState === 'HEALTHY') {
    pendingSessions.delete(sessionId);
    if (pending.otpSubmittedAt) {
      const blocks: SlackBlock[] = [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Thank You: Verification Complete ✅', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Your code was accepted. The agent is continuing its task.',
          },
        },
      ];
      await postSlackMessage(
        'Thank You: Verification Complete ✅',
        blocks,
      );
    } else {
      const blocks: SlackBlock[] = [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Session Recovered Automatically', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Session \`${sessionId}\` became healthy before OTP submission. No action is required.`,
          },
        },
      ];
      await postSlackMessage(
        `Session ${sessionId} recovered without OTP submission.`,
        blocks,
      );
    }
    return;
  }

  if (newState === 'FAILED') {
    pendingSessions.delete(sessionId);
    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Intervention Failed', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Session \`${sessionId}\` moved to \`${newState}\`. Please retry when prompted.`,
        },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `Transition: \`${oldState} -> ${newState}\`` },
        ],
      },
    ];
    await postSlackMessage(`Intervention failed for session ${sessionId}.`, blocks);
  }
}

async function handleHitlCompleted(data: HitlCompletedEvent): Promise<void> {
  const {
    session_id: sessionId,
    outcome,
  } = data.payload;
  const pending = pendingSessions.get(sessionId);
  if (!pending) {
    return;
  }

  const normalizedOutcome = String(outcome || '').toUpperCase();
  if (normalizedOutcome === 'TIMEOUT' || normalizedOutcome === 'FAIL') {
    pendingSessions.delete(sessionId);
    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Intervention Expired', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Session \`${sessionId}\` intervention ended with outcome \`${normalizedOutcome}\`. No further OTP action is required for this attempt.`,
        },
      },
    ];
    await postSlackMessage(`Intervention ended for session ${sessionId}.`, blocks);
  }
}

async function consumeHitlStarted(sub: AnySubscription): Promise<void> {
  console.log('[soft-hitl] consumeHitlStarted loop entered');
  for await (const msg of sub) {
    try {
      console.log(`[soft-hitl] RECV hitl.started: ${msg.subject}`);
      const data = JSON.parse(sc.decode(msg.data)) as HitlStartedEvent;
      await handleHitlStarted(data);
      if ('ack' in msg && typeof msg.ack === 'function') msg.ack();
      console.log('[soft-hitl] handleHitlStarted completed');
    } catch (error) {
      console.error(`[soft-hitl] hitl.started processing error: ${error}`);
    }
  }
  console.log('[soft-hitl] consumeHitlStarted loop exited');
}

async function consumeStateChanged(sub: AnySubscription): Promise<void> {
  console.log('[soft-hitl] consumeStateChanged loop entered');
  for await (const msg of sub) {
    try {
      console.log(`[soft-hitl] RECV state.changed: ${msg.subject}`);
      const data = JSON.parse(sc.decode(msg.data)) as SessionStateChangedEvent;
      await handleStateChanged(data);
      if ('ack' in msg && typeof msg.ack === 'function') msg.ack();
      console.log('[soft-hitl] handleStateChanged completed');
    } catch (error) {
      console.error(`[soft-hitl] session.state.changed processing error: ${error}`);
    }
  }
  console.log('[soft-hitl] consumeStateChanged loop exited');
}

async function consumeHitlCompleted(sub: AnySubscription): Promise<void> {
  console.log('[soft-hitl] consumeHitlCompleted loop entered');
  for await (const msg of sub) {
    try {
      console.log(`[soft-hitl] RECV hitl.completed: ${msg.subject}`);
      const data = JSON.parse(sc.decode(msg.data)) as HitlCompletedEvent;
      await handleHitlCompleted(data);
      if ('ack' in msg && typeof msg.ack === 'function') msg.ack();
      console.log('[soft-hitl] handleHitlCompleted completed');
    } catch (error) {
      console.error(`[soft-hitl] hitl.completed processing error: ${error}`);
    }
  }
  console.log('[soft-hitl] consumeHitlCompleted loop exited');
}

function normalizeCommandText(rawText: string): string {
  let text = rawText.trim();
  if (!text) {
    return text;
  }

  // Ignore leading quote markup used in Slack replies.
  text = text.replace(/^>\s*/, '').trim();

  // Unwrap common Slack/operator wrappers (`...`, "...", '...').
  for (let i = 0; i < 3; i += 1) {
    const first = text[0];
    const last = text[text.length - 1];
    const wrapped = (
      (first === '`' && last === '`')
      || (first === '"' && last === '"')
      || (first === '\'' && last === '\'')
      || (first === '“' && last === '”')
    );
    if (!wrapped || text.length < 2) {
      break;
    }
    text = text.slice(1, -1).trim();
  }

  return text;
}

async function pollSlackCommands(): Promise<void> {
  while (true) {
    try {
      cleanupPendingSessions();
      const messages = await fetchNewChannelMessages(latestSeenTs);
      messages.sort((a: any, b: any) => Number(a.ts) - Number(b.ts));

      for (const message of messages) {
        const ts = String(message.ts || '0');
        if (Number(ts) > Number(latestSeenTs)) {
          latestSeenTs = ts;
        }

        if (message.subtype) {
          continue;
        }
        if (message.user && message.user === botUserId) {
          continue;
        }
        const senderId = String(message.user || '');
        if (senderId && !isOperatorUserAuthorized(senderId)) {
          continue;
        }
        const rawText = String(message.text || '').trim();
        if (!rawText) {
          continue;
        }
        const text = normalizeCommandText(rawText);
        if (!text) {
          continue;
        }

        const otpMatch = text.match(/^OTP\s+([A-Za-z0-9-]+)\s+([^\s]+)$/i);
        if (otpMatch) {
          const sessionId = otpMatch[1];
          const otp = otpMatch[2];
          if (!/^[A-Za-z0-9]{4,10}$/.test(otp)) {
            await postSlackMessage(
              `Invalid OTP format for ${sessionId}. Use alphanumeric characters (4-10 chars): OTP ${sessionId} <one-time-code>`,
            );
            continue;
          }
          const pending = pendingSessions.get(sessionId);
          if (!pending) {
            await postSlackMessage(`No pending HITL session tracked for ${sessionId}.`);
            continue;
          }
          try {
            await submitOtp(sessionId, otp, pending.tenantId);
            pending.otpSubmittedAt = Date.now();
            const blocks: SlackBlock[] = [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: 'Thanks. I received your code. Waiting for your Adopt agent to continue the task..',
                },
              },
            ];
            await postSlackMessage('Thanks. I received your code. Waiting for your Adopt agent to continue the task..', blocks);
          } catch (error) {
            await postSlackMessage(
              `OTP delivery failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          continue;
        }
        if (/\bOTP\b/i.test(text)) {
          await postSlackMessage('Could not parse OTP command. Use: OTP <session_id> <one-time-code>');
          continue;
        }

        const openMatch = text.match(/^OPEN\s+([A-Za-z0-9-]+)$/i);
        if (openMatch) {
          const sessionId = openMatch[1];
          const pending = pendingSessions.get(sessionId);
          if (!pending) {
            await postSlackMessage(`No pending HITL session tracked for ${sessionId}.`);
            continue;
          }
          try {
            const streamUrl = await requestStreamUrl(sessionId, pending.tenantId);
            await postSlackMessage(`Stream for ${sessionId}: ${streamUrl}`);
          } catch (error) {
            await postSlackMessage(
              `Stream refresh failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          continue;
        }
        if (/\bOPEN\b/i.test(text)) {
          await postSlackMessage('Could not parse OPEN command. Use: OPEN <session_id>');
        }
      }
    } catch (error) {
      console.error(`[soft-hitl] command poll error: ${error}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function isOperatorUserAuthorized(slackUserId: string): boolean {
  if (allowUnrestrictedOperators) {
    return true;
  }
  return allowedOperatorUserIds.has(slackUserId);
}

async function fetchNewChannelMessages(oldestTs: string): Promise<any[]> {
  const all: any[] = [];
  let cursor = '';

  for (let page = 0; page < commandHistoryMaxPages; page += 1) {
    const params: Record<string, string> = {
      channel: activeChannelId,
      limit: String(commandHistoryPageLimit),
      oldest: oldestTs,
      inclusive: 'false',
    };
    if (cursor) {
      params.cursor = cursor;
    }

    const result = await slackApi('conversations.history', params);
    const messages = Array.isArray(result.messages) ? result.messages : [];
    all.push(...messages);

    const next = String(result?.response_metadata?.next_cursor || '').trim();
    if (!next) {
      break;
    }
    cursor = next;
  }

  return all;
}

async function bootstrapSlack(): Promise<void> {
  const auth = await slackApi('auth.test', {});
  botUserId = String(auth.user_id || '');
  workspaceTeamId = String(auth.team_id || '');
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'HITL bridge is online and listening for intervention events.',
      },
    },
  ];
  const sent = await postSlackMessage('Soft HITL bridge online. Waiting for interventions.', blocks);
  activeChannelId = sent.channel;
  latestSeenTs = sent.ts;
}

/** Attempt to create durable JetStream subscriptions, falling back to Core NATS. */
async function createSubscriptions(nc: NatsConnection): Promise<{
  subs: AnySubscription[];
  mode: 'jetstream' | 'core';
}> {
  try {
    const js = nc.jetstream();
    const jsm = await nc.jetstreamManager();

    // Ensure streams exist (idempotent - publisher may have created them already)
    const STREAM_MAX_AGE_NS = 24 * 60 * 60 * 1_000_000_000;
    const streamDefs = [
      { name: 'HITL_EVENTS', subjects: ['hitl.started.>', 'hitl.completed.>', 'hitl.otp-requested.>'] },
      { name: 'SESSION_EVENTS', subjects: ['session.state.changed.>', 'auth.bundle.exported.>'] },
    ];
    for (const { name, subjects } of streamDefs) {
      try {
        await jsm.streams.add({
          name, subjects,
          retention: RetentionPolicy.Limits,
          storage: StorageType.File,
          max_age: STREAM_MAX_AGE_NS,
        });
      } catch {
        // Stream already exists - that's fine
      }
    }

    // Create durable push consumers
    const makeSub = async (subject: string, durableName: string, streamName: string) => {
      const opts = consumerOpts();
      opts.durable(durableName);
      opts.deliverTo(`deliver-${durableName}`);
      opts.ackExplicit();
      opts.deliverNew();
      opts.bind(streamName, durableName);
      return js.subscribe(subject, opts);
    };

    // Purge stale consumers then recreate to avoid "consumer already exists" with different config
    for (const stream of ['HITL_EVENTS', 'SESSION_EVENTS']) {
      try {
        const consumers = await jsm.consumers.list(stream).next();
        for (const ci of consumers) {
          if (ci.name.startsWith('soft-hitl-')) {
            try { await jsm.consumers.delete(stream, ci.name); } catch { /* ignore */ }
          }
        }
      } catch { /* stream may not exist yet */ }
    }

    // Pre-create consumers via JetStream manager for clean config
    await jsm.consumers.add('HITL_EVENTS', {
      durable_name: 'soft-hitl-started',
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.New,
      deliver_subject: 'deliver-soft-hitl-started',
      filter_subject: 'hitl.started.>',
    });
    await jsm.consumers.add('HITL_EVENTS', {
      durable_name: 'soft-hitl-completed',
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.New,
      deliver_subject: 'deliver-soft-hitl-completed',
      filter_subject: 'hitl.completed.>',
    });
    await jsm.consumers.add('SESSION_EVENTS', {
      durable_name: 'soft-hitl-state',
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.New,
      deliver_subject: 'deliver-soft-hitl-state',
      filter_subject: 'session.state.changed.>',
    });

    const hitlStartedSub = await makeSub('hitl.started.>', 'soft-hitl-started', 'HITL_EVENTS');
    const hitlCompletedSub = await makeSub('hitl.completed.>', 'soft-hitl-completed', 'HITL_EVENTS');
    const stateChangedSub = await makeSub('session.state.changed.>', 'soft-hitl-state', 'SESSION_EVENTS');

    return { subs: [hitlStartedSub, hitlCompletedSub, stateChangedSub], mode: 'jetstream' };
  } catch (err) {
    console.warn(`[soft-hitl] JetStream unavailable, falling back to Core NATS: ${err}`);
    const hitlStartedSub = nc.subscribe('hitl.started.>');
    const hitlCompletedSub = nc.subscribe('hitl.completed.>');
    const stateChangedSub = nc.subscribe('session.state.changed.>');
    return { subs: [hitlStartedSub, hitlCompletedSub, stateChangedSub], mode: 'core' };
  }
}

async function main(): Promise<void> {
  ensureEnv();
  await bootstrapSlack();

  const nc: NatsConnection = await connect({ servers: natsUrl });
  console.log(`[soft-hitl] connected to NATS at ${natsUrl}`);

  // Monitor NATS connection status
  (async () => {
    for await (const status of nc.status()) {
      console.log(`[soft-hitl] NATS status: ${status.type} ${JSON.stringify(status.data ?? '')}`);
    }
  })();

  const { subs, mode } = await createSubscriptions(nc);
  const [hitlStartedSub, hitlCompletedSub, stateChangedSub] = subs;
  console.log(`[soft-hitl] subscriptions created via ${mode}`);

  void consumeHitlStarted(hitlStartedSub);
  void consumeHitlCompleted(hitlCompletedSub);
  void consumeStateChanged(stateChangedSub);
  void pollSlackCommands();

  console.log('[soft-hitl] all subscriptions active, polling started');

  const shutdown = async (): Promise<void> => {
    console.log('[soft-hitl] shutting down...');
    try {
      hitlStartedSub.unsubscribe();
      hitlCompletedSub.unsubscribe();
      stateChangedSub.unsubscribe();
      await nc.drain();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

process.on('uncaughtException', (err) => {
  console.error(`[soft-hitl] uncaughtException: ${err.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[soft-hitl] unhandledRejection: ${reason}`);
});

main().catch((error) => {
  console.error(`[soft-hitl] fatal: ${error}`);
  process.exit(1);
});
