import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import {
  connect, NatsConnection, StringCodec, JetStreamClient,
  RetentionPolicy, StorageType,
} from 'nats';
import { NATS_SUBJECTS, requireEnv } from '@browser-hitl/shared';
import type { InputRequest } from '@browser-hitl/shared';

const STREAM_MAX_AGE_NS = parseInt(process.env.NATS_STREAM_MAX_AGE_HOURS || '8', 10) * 60 * 60 * 1_000_000_000;

/**
 * NATS Publisher Service
 * Publishes session lifecycle events to NATS JetStream.
 * All subjects include tenant_id for ACL scoping per spec section 11.4.
 */
@Injectable()
export class NatsPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NatsPublisherService.name);
  private nc: NatsConnection | null = null;
  private js: JetStreamClient | null = null;
  private readonly sc = StringCodec();

  async onModuleInit() {
    const natsUrl = requireEnv('NATS_URL', {
      testDefault: 'nats://localhost:4222',
    });
    try {
      this.nc = await connect({ servers: natsUrl });
      this.logger.log(`Connected to NATS at ${natsUrl}`);
      await this.ensureStreams();
      this.js = this.nc.jetstream();
      this.logger.log('JetStream publisher initialized');
    } catch (error) {
      this.logger.error(`Failed to connect to NATS: ${error}`);
      // Non-fatal: controller can operate without NATS (degraded mode)
    }
  }

  private async ensureStreams(): Promise<void> {
    if (!this.nc) return;
    const jsm = await this.nc.jetstreamManager();

    const streams = [
      {
        name: 'HITL_EVENTS',
        subjects: ['hitl.started.>', 'hitl.completed.>'],
      },
      {
        name: 'SESSION_EVENTS',
        subjects: ['session.state.changed.>', 'auth.bundle.exported.>'],
      },
    ];

    for (const { name, subjects } of streams) {
      try {
        await jsm.streams.add({
          name,
          subjects,
          retention: RetentionPolicy.Limits,
          storage: StorageType.File,
          max_age: STREAM_MAX_AGE_NS,
        });
        this.logger.log(`JetStream stream "${name}" ensured`);
      } catch (err: any) {
        // Stream exists with different config - try update
        if (err?.api_error?.err_code === 10058 || String(err).includes('already in use')) {
          try {
            const info = await jsm.streams.info(name);
            await jsm.streams.update(name, { ...info.config, subjects });
            this.logger.log(`JetStream stream "${name}" updated`);
          } catch {
            this.logger.warn(`JetStream stream "${name}" exists, skipping update`);
          }
        } else {
          this.logger.error(`Failed to ensure JetStream stream "${name}": ${err}`);
        }
      }
    }
  }

  async onModuleDestroy() {
    if (this.nc) {
      await this.nc.drain();
    }
  }

  async publishStateChange(
    tenantId: string,
    sessionId: string,
    appId: string,
    oldState: string,
    newState: string,
  ): Promise<void> {
    const subject = NATS_SUBJECTS.sessionStateChanged(tenantId, sessionId);
    const payload = {
      type: 'session.state.changed',
      timestamp: new Date().toISOString(),
      payload: {
        session_id: sessionId,
        tenant_id: tenantId,
        app_id: appId,
        old_state: oldState,
        new_state: newState,
      },
    };
    await this.publish(subject, payload);
  }

  async publishHitlStarted(
    tenantId: string,
    sessionId: string,
    appId: string,
    interventionId: string,
    appName: string,
    interventionType: string = 'MANUAL',
    inputRequest?: InputRequest,
  ): Promise<void> {
    const subject = NATS_SUBJECTS.hitlStarted(tenantId, sessionId);
    const eventPayload: Record<string, unknown> = {
      session_id: sessionId,
      tenant_id: tenantId,
      app_id: appId,
      app_name: appName,
      reason: 'login_needed',
      intervention_id: interventionId,
      intervention_type: interventionType,
    };
    if (inputRequest) {
      eventPayload.input_request = inputRequest;
    }
    const payload = {
      type: 'hitl.started',
      timestamp: new Date().toISOString(),
      payload: eventPayload,
    };
    await this.publish(subject, payload);
  }

  async publishHitlCompleted(
    tenantId: string,
    sessionId: string,
    appId: string,
    interventionId: string,
    outcome: string,
  ): Promise<void> {
    const subject = NATS_SUBJECTS.hitlCompleted(tenantId, sessionId);
    const payload = {
      type: 'hitl.completed',
      timestamp: new Date().toISOString(),
      payload: {
        session_id: sessionId,
        tenant_id: tenantId,
        app_id: appId,
        intervention_id: interventionId,
        outcome,
      },
    };
    await this.publish(subject, payload);
  }

  private async publish(subject: string, payload: unknown): Promise<void> {
    if (!this.nc) {
      this.logger.warn(`NATS not connected, cannot publish to ${subject}`);
      return;
    }

    const encoded = this.sc.encode(JSON.stringify(payload));
    try {
      if (this.js) {
        await this.js.publish(subject, encoded);
      } else {
        // Fallback to Core NATS if JetStream is unavailable
        this.nc.publish(subject, encoded);
      }
      this.logger.debug(`Published to ${subject}`);
    } catch (error) {
      this.logger.error(`Failed to publish to ${subject}: ${error}`);
    }
  }
}
