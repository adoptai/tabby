import {
  NatsConnection, StringCodec, Subscription,
  JetStreamSubscription,
  consumerOpts, AckPolicy, DeliverPolicy,
  RetentionPolicy, StorageType,
} from 'nats';
import {
  TurnContext,
  ConversationReference,
  BotFrameworkAdapter,
  MessageFactory,
} from 'botbuilder';
import { HitlStartedEvent, connectNats } from '@browser-hitl/shared';
import { HitlActionHandler } from './handlers/hitl-actions';

type AnySubscription = Subscription | JetStreamSubscription;

/**
 * NATS Event Listener for the Teams bot.
 * Subscribes to HITL events via JetStream (durable) with Core NATS fallback.
 * Per spec section 12.2: Teams bot subscribes to NATS and notifies operators.
 *
 * Subjects:
 *   hitl.started.{tenant_id}.{session_id}
 *   hitl.otp-requested.{tenant_id}.{session_id}
 */
export class NatsListener {
  private nc: NatsConnection | null = null;
  private subscriptions: AnySubscription[] = [];
  private readonly sc = StringCodec();

  constructor(
    private readonly adapter: BotFrameworkAdapter,
    private readonly conversationReference: Partial<ConversationReference>,
    private readonly actionHandler: HitlActionHandler,
  ) {}

  /**
   * Connect to NATS and subscribe to HITL event subjects.
   */
  async start(): Promise<void> {
    const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';

    const teamsLogger = {
      log: (msg: string) => console.log(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    };
    this.nc = await connectNats(natsUrl, teamsLogger);
    console.log(`[NatsListener] Connected to NATS at ${natsUrl}`);

    let mode: string;
    try {
      const js = this.nc.jetstream();
      const jsm = await this.nc.jetstreamManager();

      const STREAM_MAX_AGE_NS = 24 * 60 * 60 * 1_000_000_000;
      try { await jsm.streams.add({ name: 'HITL_EVENTS', subjects: ['hitl.started.>', 'hitl.completed.>'], retention: RetentionPolicy.Limits, storage: StorageType.File, max_age: STREAM_MAX_AGE_NS }); } catch { /* exists */ }

      const makeSub = async (subject: string, durable: string, stream: string) => {
        try { await jsm.consumers.delete(stream, durable); } catch { /* doesn't exist */ }
        await jsm.consumers.add(stream, {
          durable_name: durable,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.New,
          deliver_subject: `deliver-teams-${durable}`,
          filter_subject: subject,
        });
        const opts = consumerOpts();
        opts.bind(stream, durable);
        return js.subscribe(subject, opts);
      };

      const hitlStartedSub = await makeSub('hitl.started.>', 'teams-hitl-started', 'HITL_EVENTS');
      this.subscriptions.push(hitlStartedSub);
      this.consumeHitlStarted(hitlStartedSub);
      mode = 'JetStream (durable)';
    } catch (err) {
      console.warn(`[NatsListener] JetStream unavailable, using Core NATS: ${err}`);
      const hitlStartedSub = this.nc.subscribe('hitl.started.>');
      this.subscriptions.push(hitlStartedSub);
      this.consumeHitlStarted(hitlStartedSub);
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
   * Posts an Adaptive Card with Open Stream, Submit OTP, and Release Control actions.
   */
  private async consumeHitlStarted(sub: AnySubscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const data = JSON.parse(this.sc.decode(msg.data)) as HitlStartedEvent;
        const { session_id, tenant_id, app_id, reason, intervention_id } = data.payload;

        console.log(
          `[NatsListener] hitl.started: session=${session_id} tenant=${tenant_id} reason=${reason}`,
        );

        const card = this.actionHandler.buildHitlStartedCard(
          session_id,
          app_id,
          reason,
          intervention_id,
          tenant_id,
          data.timestamp,
        );

        await this.sendProactiveMessage(
          MessageFactory.attachment(card),
        );
        if ('ack' in msg && typeof msg.ack === 'function') msg.ack();
      } catch (error) {
        console.error(`[NatsListener] Error processing hitl.started: ${error}`);
      }
    }
  }

  /**
   * Send a proactive message to the configured Teams channel.
   * Uses the stored ConversationReference to continue the conversation.
   */
  private async sendProactiveMessage(activity: Partial<any>): Promise<void> {
    await this.adapter.continueConversation(
      this.conversationReference,
      async (turnContext: TurnContext) => {
        await turnContext.sendActivity(activity);
      },
    );
  }
}
