import {
  NatsConnection, StringCodec, Subscription,
  JetStreamSubscription,
  consumerOpts, AckPolicy, DeliverPolicy,
  RetentionPolicy, StorageType,
} from 'nats';
import { App } from '@slack/bolt';
import {
  HitlStartedEvent,
  SessionStateChangedEvent,
  connectNats,
} from '@browser-hitl/shared';

type AnySubscription = Subscription | JetStreamSubscription;

/**
 * NATS Event Listener for the Slack bot.
 * Subscribes to HITL events via JetStream (durable) with Core NATS fallback.
 * Per spec section 12.1: bots subscribe to NATS and notify operators.
 *
 * Subjects:
 *   hitl.started.{tenant_id}.{session_id}
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

    const slackLogger = {
      log: (msg: string) => console.log(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    };
    this.nc = await connectNats(natsUrl, slackLogger);
    console.log(`[NatsListener] Connected to NATS at ${natsUrl}`);

    let mode: string;
    try {
      // Try JetStream durable consumers (guaranteed delivery)
      const js = this.nc.jetstream();
      const jsm = await this.nc.jetstreamManager();

      const STREAM_MAX_AGE_NS = 24 * 60 * 60 * 1_000_000_000;
      for (const def of [
        { name: 'HITL_EVENTS', subjects: ['hitl.started.>', 'hitl.completed.>'] },
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
      const stateChangedSub = await makeSub('session.state.changed.>', 'slack-state-changed', 'SESSION_EVENTS');
      this.subscriptions.push(hitlStartedSub, stateChangedSub);
      this.consumeHitlStarted(hitlStartedSub);
      this.consumeSessionStateChanged(stateChangedSub);
      mode = 'JetStream (durable)';
    } catch (err) {
      // Fallback to Core NATS (fire-and-forget)
      console.warn(`[NatsListener] JetStream unavailable, using Core NATS: ${err}`);
      const hitlStartedSub = this.nc.subscribe('hitl.started.>');
      const stateChangedSub = this.nc.subscribe('session.state.changed.>');
      this.subscriptions.push(hitlStartedSub, stateChangedSub);
      this.consumeHitlStarted(hitlStartedSub);
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
   * Posts a dynamic interactive message based on input_request metadata.
   * Single handler replaces both hitl.started and hitl.otp-requested.
   */
  private async consumeHitlStarted(sub: AnySubscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const data = JSON.parse(this.sc.decode(msg.data)) as HitlStartedEvent;
        const {
          session_id, tenant_id, app_id, app_name,
          reason, intervention_id, intervention_type, input_request,
        } = data.payload;
        const channelId = this.resolveChannel(tenant_id);

        console.log(
          `[NatsListener] hitl.started: session=${session_id} tenant=${tenant_id} type=${intervention_type || 'MANUAL'}`,
        );

        // Dynamic header based on input request
        const headerText = input_request?.label
          || (intervention_type === 'OTP' ? 'OTP Code Required' : 'Human Intervention Required');

        // Dynamic description
        const description = input_request?.label
          ? `${app_name ? `*${app_name}*` : `\`${app_id}\``} needs your help: ${input_request.label}`
          : `Automation is paused for ${app_name ? `*${app_name}*` : `\`${app_id}\``}. Click *Open Stream* to inspect the page.`;

        // Build action buttons based on input type
        const actionValue = JSON.stringify({
          session_id,
          tenant_id,
          input_request: input_request || null,
        });

        const actionElements: any[] = [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open Stream' },
            action_id: 'open_stream',
            value: JSON.stringify({ session_id, tenant_id }),
            style: 'primary',
          },
        ];

        if (input_request?.input_type === 'confirm') {
          actionElements.push({
            type: 'button',
            text: { type: 'plain_text', text: 'Mark as Resolved' },
            action_id: 'confirm_resolved',
            value: actionValue,
          });
        } else {
          // Dynamic submit button text
          const submitLabel = input_request
            ? this.getSubmitLabel(input_request.input_type)
            : 'Submit OTP';
          actionElements.push({
            type: 'button',
            text: { type: 'plain_text', text: submitLabel },
            action_id: 'submit_input',
            value: actionValue,
          });
        }

        actionElements.push({
          type: 'button',
          text: { type: 'plain_text', text: 'Release Control' },
          action_id: 'release_control',
          value: JSON.stringify({ session_id, tenant_id }),
          style: 'danger',
        });

        const sent = await this.slackApp.client.chat.postMessage({
            channel: channelId,
            text: `${headerText} for session ${session_id}`,
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: headerText },
              },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: `*Session:*\n\`${session_id}\`` },
                  { type: 'mrkdwn', text: `*Application:*\n\`${app_id}\`` },
                  { type: 'mrkdwn', text: `*Type:*\n${intervention_type || 'MANUAL'}` },
                  { type: 'mrkdwn', text: `*Intervention:*\n\`${intervention_id}\`` },
                ],
              },
              {
                type: 'section',
                text: { type: 'mrkdwn', text: description },
              },
              {
                type: 'actions',
                elements: actionElements,
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
          const sent = await this.slackApp.client.chat.postMessage({
            channel: channelId,
            text: `Session ${session_id} recovered and automation resumed.`,
            blocks: [
              {
                type: 'header',
                text: { type: 'plain_text', text: 'Automation Resumed' },
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
                  { type: 'mrkdwn', text: `Tenant: \`${tenant_id}\` | Event: ${data.timestamp}` },
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
                text: { type: 'plain_text', text: 'Intervention Failed' },
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
                text: { type: 'mrkdwn', text: 'Please inspect stream/context and re-attempt if appropriate.' },
              },
              {
                type: 'context',
                elements: [
                  { type: 'mrkdwn', text: `Tenant: \`${tenant_id}\` | Event: ${data.timestamp}` },
                ],
              },
            ],
          });
        }
        if ('ack' in msg && typeof msg.ack === 'function') msg.ack();
      } catch (error) {
        console.error(`[NatsListener] Error processing session.state.changed: ${error}`);
      }
    }
  }

  private getSubmitLabel(inputType: string): string {
    switch (inputType) {
      case 'otp': return 'Submit OTP';
      case 'verification_code': return 'Submit Code';
      case 'email': return 'Submit Email';
      case 'password': return 'Submit Password';
      case 'captcha': return 'Submit CAPTCHA';
      case 'url': return 'Submit URL';
      default: return 'Submit Input';
    }
  }

  /**
   * Resolve the Slack channel ID for a given tenant.
   */
  private resolveChannel(tenantId: string): string {
    const normalizedTenantToken = tenantId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const directOverride = process.env[`SLACK_CHANNEL_${tenantId.toUpperCase()}`];
    const normalizedOverride = process.env[`SLACK_CHANNEL_${normalizedTenantToken}`];
    return directOverride || normalizedOverride || this.defaultChannelId;
  }
}
