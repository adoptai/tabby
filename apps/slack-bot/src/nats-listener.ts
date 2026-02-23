import {
  connect, NatsConnection, StringCodec, Subscription,
  JetStreamClient, JetStreamSubscription,
  consumerOpts, AckPolicy, DeliverPolicy,
  RetentionPolicy, StorageType,
} from 'nats';
import { App } from '@slack/bolt';
import {
  HitlStartedEvent,
  HitlOtpRequestedEvent,
  SessionStateChangedEvent,
} from '@browser-hitl/shared';

type AnySubscription = Subscription | JetStreamSubscription;

/**
 * NATS Event Listener for the Slack bot.
 * Subscribes to HITL events via JetStream (durable) with Core NATS fallback.
 * Per spec section 12.1: bots subscribe to NATS and notify operators.
 *
 * Subjects:
 *   hitl.started.{tenant_id}.{session_id}
 *   hitl.otp-requested.{tenant_id}.{session_id}
 *   session.state.changed.{tenant_id}.{session_id}
 */
export class NatsListener {
  private nc: NatsConnection | null = null;
  private subscriptions: AnySubscription[] = [];
  private readonly sc = StringCodec();

  constructor(
    private readonly slackApp: App,
    private readonly defaultChannelId: string,
  ) {}

  /**
   * Connect to NATS and subscribe to HITL event subjects.
   */
  async start(): Promise<void> {
    const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';

    try {
      this.nc = await connect({ servers: natsUrl });
      console.log(`[NatsListener] Connected to NATS at ${natsUrl}`);
    } catch (error) {
      console.error(`[NatsListener] Failed to connect to NATS: ${error}`);
      throw error;
    }

    let mode: string;
    try {
      // Try JetStream durable consumers (guaranteed delivery)
      const js = this.nc.jetstream();
      const jsm = await this.nc.jetstreamManager();

      const STREAM_MAX_AGE_NS = 24 * 60 * 60 * 1_000_000_000;
      for (const def of [
        { name: 'HITL_EVENTS', subjects: ['hitl.started.>', 'hitl.completed.>', 'hitl.otp-requested.>'] },
        { name: 'SESSION_EVENTS', subjects: ['session.state.changed.>', 'auth.bundle.exported.>'] },
      ]) {
        try { await jsm.streams.add({ name: def.name, subjects: def.subjects, retention: RetentionPolicy.Limits, storage: StorageType.File, max_age: STREAM_MAX_AGE_NS }); } catch { /* exists */ }
      }

      const makeSub = async (subject: string, durable: string, stream: string) => {
        try { await jsm.consumers.delete(stream, durable); } catch { /* doesn't exist */ }
        await jsm.consumers.add(stream, {
          durable_name: durable,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.New,
          deliver_subject: `deliver-slack-${durable}`,
          filter_subject: subject,
        });
        const opts = consumerOpts();
        opts.bind(stream, durable);
        return js.subscribe(subject, opts);
      };

      const hitlStartedSub = await makeSub('hitl.started.>', 'slack-hitl-started', 'HITL_EVENTS');
      const otpRequestedSub = await makeSub('hitl.otp-requested.>', 'slack-otp-requested', 'HITL_EVENTS');
      const stateChangedSub = await makeSub('session.state.changed.>', 'slack-state-changed', 'SESSION_EVENTS');
      this.subscriptions.push(hitlStartedSub, otpRequestedSub, stateChangedSub);
      this.consumeHitlStarted(hitlStartedSub);
      this.consumeOtpRequested(otpRequestedSub);
      this.consumeSessionStateChanged(stateChangedSub);
      mode = 'JetStream (durable)';
    } catch (err) {
      // Fallback to Core NATS (fire-and-forget)
      console.warn(`[NatsListener] JetStream unavailable, using Core NATS: ${err}`);
      const hitlStartedSub = this.nc.subscribe('hitl.started.>');
      const otpRequestedSub = this.nc.subscribe('hitl.otp-requested.>');
      const stateChangedSub = this.nc.subscribe('session.state.changed.>');
      this.subscriptions.push(hitlStartedSub, otpRequestedSub, stateChangedSub);
      this.consumeHitlStarted(hitlStartedSub);
      this.consumeOtpRequested(otpRequestedSub);
      this.consumeSessionStateChanged(stateChangedSub);
      mode = 'Core NATS (no replay)';
    }

    console.log(`[NatsListener] Subscribed via ${mode}`);
  }

  /**
   * Drain subscriptions and close NATS connection.
   */
  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    if (this.nc) {
      await this.nc.drain();
      console.log('[NatsListener] NATS connection drained');
    }
  }

  /**
   * Process hitl.started events.
   * Posts an interactive message with Open Stream, Submit OTP, and Release Control buttons.
   */
  private async consumeHitlStarted(sub: AnySubscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const data = JSON.parse(this.sc.decode(msg.data)) as HitlStartedEvent;
        const { session_id, tenant_id, app_id, reason, intervention_id } = data.payload;
        const channelId = this.resolveChannel(tenant_id);

        console.log(
          `[NatsListener] hitl.started: session=${session_id} tenant=${tenant_id} reason=${reason}`,
        );

        await this.slackApp.client.chat.postMessage({
          channel: channelId,
          text: `Human intervention needed for session ${session_id}. Use Submit OTP when code is available.`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: 'Human Intervention Required',
              },
            },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Session:*\n\`${session_id}\`` },
                { type: 'mrkdwn', text: `*Application:*\n\`${app_id}\`` },
                { type: 'mrkdwn', text: `*Reason:*\n${reason}` },
                { type: 'mrkdwn', text: `*Intervention:*\n\`${intervention_id}\`` },
              ],
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Automation is paused. Click *Open Stream* to inspect the page, then use *Submit OTP* to continue.',
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Open Stream' },
                  action_id: 'open_stream',
                  value: JSON.stringify({ session_id, tenant_id }),
                  style: 'primary',
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Submit OTP' },
                  action_id: 'submit_otp',
                  value: JSON.stringify({ session_id, tenant_id }),
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Release Control' },
                  action_id: 'release_control',
                  value: JSON.stringify({ session_id, tenant_id }),
                  style: 'danger',
                },
              ],
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `Tenant: \`${tenant_id}\` | Received: ${data.timestamp}`,
                },
              ],
            },
          ],
        });
        if ('ack' in msg && typeof msg.ack === 'function') msg.ack();
      } catch (error) {
        console.error(`[NatsListener] Error processing hitl.started: ${error}`);
      }
    }
  }

  /**
   * Process hitl.otp-requested events.
   * Posts an OTP prompt message with a Submit OTP button.
   */
  private async consumeOtpRequested(sub: AnySubscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const data = JSON.parse(this.sc.decode(msg.data)) as HitlOtpRequestedEvent;
        const { session_id, tenant_id, app_id, app_name } = data.payload;
        const channelId = this.resolveChannel(tenant_id);

        console.log(
          `[NatsListener] hitl.otp-requested: session=${session_id} app=${app_name}`,
        );

        await this.slackApp.client.chat.postMessage({
          channel: channelId,
          text: `OTP required for ${app_name} (session ${session_id})`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: 'OTP Code Required',
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `Application *${app_name}* (\`${app_id}\`) is requesting an OTP code.\nSession: \`${session_id}\``,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Submit OTP' },
                  action_id: 'submit_otp',
                  value: JSON.stringify({ session_id, tenant_id }),
                  style: 'primary',
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Open Stream' },
                  action_id: 'open_stream',
                  value: JSON.stringify({ session_id, tenant_id }),
                },
              ],
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `Tenant: \`${tenant_id}\` | Received: ${data.timestamp}`,
                },
              ],
            },
          ],
        });
        if ('ack' in msg && typeof msg.ack === 'function') msg.ack();
      } catch (error) {
        console.error(`[NatsListener] Error processing hitl.otp-requested: ${error}`);
      }
    }
  }

  /**
   * Process session.state.changed events.
   * Emits concise completion notifications for the human operator when
   * an intervention path returns to HEALTHY or fails out.
   */
  private async consumeSessionStateChanged(sub: AnySubscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const data = JSON.parse(this.sc.decode(msg.data)) as SessionStateChangedEvent;
        const {
          session_id, tenant_id, app_id, old_state, new_state,
        } = data.payload;

        if (old_state === 'LOGIN_IN_PROGRESS' && new_state === 'HEALTHY') {
          const channelId = this.resolveChannel(tenant_id);
          await this.slackApp.client.chat.postMessage({
            channel: channelId,
            text: `Session ${session_id} recovered and automation resumed.`,
            blocks: [
              {
                type: 'header',
                text: {
                  type: 'plain_text',
                  text: 'Automation Resumed',
                },
              },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: `*Session:*\n\`${session_id}\`` },
                  { type: 'mrkdwn', text: `*Application:*\n\`${app_id}\`` },
                  { type: 'mrkdwn', text: `*Transition:*\n\`${old_state} -> ${new_state}\`` },
                ],
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `Tenant: \`${tenant_id}\` | Event: ${data.timestamp}`,
                  },
                ],
              },
            ],
          });
          if ('ack' in msg && typeof msg.ack === 'function') msg.ack();
          continue;
        }

        if (old_state === 'LOGIN_IN_PROGRESS' && new_state === 'FAILED') {
          const channelId = this.resolveChannel(tenant_id);
          await this.slackApp.client.chat.postMessage({
            channel: channelId,
            text: `Session ${session_id} failed during human intervention.`,
            blocks: [
              {
                type: 'header',
                text: {
                  type: 'plain_text',
                  text: 'Intervention Failed',
                },
              },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: `*Session:*\n\`${session_id}\`` },
                  { type: 'mrkdwn', text: `*Application:*\n\`${app_id}\`` },
                  { type: 'mrkdwn', text: `*Transition:*\n\`${old_state} -> ${new_state}\`` },
                ],
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: 'Please inspect stream/context and re-attempt if appropriate.',
                },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `Tenant: \`${tenant_id}\` | Event: ${data.timestamp}`,
                  },
                ],
              },
            ],
          });
        }
        // Ack regardless of branch (non-actionable state changes still consumed)
        if ('ack' in msg && typeof msg.ack === 'function') msg.ack();
      } catch (error) {
        console.error(`[NatsListener] Error processing session.state.changed: ${error}`);
      }
    }
  }

  /**
   * Resolve the Slack channel ID for a given tenant.
   * In production, this would look up the notification_config for the tenant's app
   * and extract the Slack channel reference. For now, falls back to default channel.
   *
   * notification_config.channels format: ["slack:#channel-name", "teams:channel-id"]
   */
  private resolveChannel(tenantId: string): string {
    const normalizedTenantToken = tenantId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const directOverride = process.env[`SLACK_CHANNEL_${tenantId.toUpperCase()}`];
    const normalizedOverride = process.env[`SLACK_CHANNEL_${normalizedTenantToken}`];
    return directOverride || normalizedOverride || this.defaultChannelId;
  }
}
