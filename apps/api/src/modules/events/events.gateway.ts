import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { IncomingMessage } from 'http';
import { NatsConnection, StringCodec, Subscription } from 'nats';
import { requireEnv, connectNats } from '@browser-hitl/shared';
import * as Sentry from '@sentry/node';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { ObservabilityService } from '../observability/observability.service';

type WsClient = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  readyState: number;
};

@WebSocketGateway({
  path: '/events',
})
export class EventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  server: any;

  private readonly logger = new Logger(EventsGateway.name);
  private readonly sc = StringCodec();
  private readonly clientsByTenant = new Map<WsClient, string>();
  private readonly interventionRequestedAtMs = new Map<string, number>();
  private natsConnection: NatsConnection | null = null;
  private natsSubscriptions: Subscription[] = [];

  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
    private readonly observabilityService: ObservabilityService,
  ) {}

  async onModuleInit(): Promise<void> {
    const natsUrl = requireEnv('NATS_URL', {
      testDefault: 'nats://localhost:4222',
    });
    try {
      this.natsConnection = await connectNats(natsUrl, this.logger);
      this.logger.log(`Connected to NATS for WS relay at ${natsUrl}`);
      this.subscribeRelaySubjects();
    } catch (error) {
      this.logger.error(`Failed to connect NATS for WS relay: ${error}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const sub of this.natsSubscriptions) {
      sub.unsubscribe();
    }
    if (this.natsConnection) {
      await this.natsConnection.drain();
    }
  }

  handleConnection(client: WsClient, ...args: any[]): void {
    const request = args[0] as IncomingMessage | undefined;
    const token = this.extractToken(request);

    if (!token) {
      client.close(1008, 'Missing auth token');
      return;
    }

    try {
      const payload = this.authService.verifyToken(token);
      if (!payload.tenant_id) {
        client.close(1008, 'Invalid auth token');
        return;
      }

      this.clientsByTenant.set(client, payload.tenant_id);
      this.logger.debug(`WS client connected for tenant ${payload.tenant_id}`);
    } catch {
      client.close(1008, 'Invalid auth token');
    }
  }

  handleDisconnect(client: WsClient): void {
    this.clientsByTenant.delete(client);
  }

  private subscribeRelaySubjects(): void {
    if (!this.natsConnection) {
      return;
    }

    const subjects = [
      'session.state.changed.>',
      'hitl.started.>',
      'hitl.otp-requested.>',
      'hitl.completed.>',
      'auth.bundle.exported.>',
    ];

    for (const subject of subjects) {
      const sub = this.natsConnection.subscribe(subject);
      this.natsSubscriptions.push(sub);
      void this.consumeSubscription(sub);
    }
  }

  private async consumeSubscription(sub: Subscription): Promise<void> {
    for await (const message of sub) {
      try {
        const tenantId = this.extractTenantIdFromSubject(message.subject);
        if (!tenantId) {
          continue;
        }

        let payload: unknown;
        const raw = this.sc.decode(message.data);
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = { raw };
        }

        await this.auditRelayEvent(message.subject, tenantId, payload);
        this.recordInterventionLifecycleMetrics(message.subject, payload);

        const outbound = JSON.stringify({
          type: this.subjectToEventType(message.subject),
          timestamp: new Date().toISOString(),
          payload,
        });

        for (const [client, clientTenantId] of this.clientsByTenant.entries()) {
          if (clientTenantId !== tenantId) {
            continue;
          }
          try {
            if (client.readyState === 1) {
              client.send(outbound);
            }
          } catch (error) {
            this.logger.warn(`Failed to send WS event to tenant ${tenantId}: ${error}`);
          }
        }
      } catch (error) {
        this.logger.error(`Error processing NATS message on ${sub.getSubject()}: ${error}`);
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private extractToken(request?: IncomingMessage): string | null {
    const url = request?.url;
    if (!url) {
      return null;
    }

    try {
      const parsed = new URL(url, 'http://localhost');
      return parsed.searchParams.get('token');
    } catch {
      return null;
    }
  }

  private extractTenantIdFromSubject(subject: string): string | null {
    const tokens = subject.split('.');
    if (tokens.length < 4) {
      return null;
    }

    // hitl.<action>.<tenant_id>.<session_id>
    if (tokens[0] === 'hitl') {
      return tokens[2] || null;
    }

    // session.state.changed.<tenant_id>.<session_id>
    // auth.bundle.exported.<tenant_id>.<app_id>
    return tokens[3] || null;
  }

  private subjectToEventType(subject: string): string {
    if (subject.startsWith('session.state.changed.')) {
      return 'session.state.changed';
    }
    if (subject.startsWith('hitl.started.')) {
      return 'hitl.started';
    }
    if (subject.startsWith('hitl.otp-requested.')) {
      return 'hitl.otp-requested';
    }
    if (subject.startsWith('hitl.completed.')) {
      return 'hitl.completed';
    }
    if (subject.startsWith('auth.bundle.exported.')) {
      return 'auth.bundle.exported';
    }

    return 'unknown';
  }

  private async auditRelayEvent(
    subject: string,
    tenantId: string,
    payload: unknown,
  ): Promise<void> {
    if (!subject.startsWith('auth.bundle.exported.')) {
      return;
    }

    try {
      const envelope = typeof payload === 'object' && payload ? payload as Record<string, unknown> : {};
      const inner = typeof envelope.payload === 'object' && envelope.payload
        ? envelope.payload as Record<string, unknown>
        : {};
      const sessionId = typeof inner.session_id === 'string' ? inner.session_id : 'unknown';

      await this.auditService.log({
        tenant_id: tenantId,
        actor_type: 'system',
        actor_id: `worker:${sessionId}`,
        event_type: 'artifact.exported',
        payload: {
          subject,
          event: envelope,
        },
      });
    } catch (error) {
      this.logger.warn(`Failed to audit relayed NATS event ${subject}: ${error}`);
    }
  }

  private recordInterventionLifecycleMetrics(subject: string, payload: unknown): void {
    const envelope = (payload && typeof payload === 'object')
      ? payload as Record<string, unknown>
      : {};
    const inner = (envelope.payload && typeof envelope.payload === 'object')
      ? envelope.payload as Record<string, unknown>
      : {};

    const sessionId = typeof inner.session_id === 'string' ? inner.session_id : '';

    if (subject.startsWith('hitl.otp-requested.')) {
      this.observabilityService.incrementCounter('hitl_intervention_requested_total');
      if (sessionId) {
        this.interventionRequestedAtMs.set(sessionId, Date.now());
      }
      return;
    }

    if (subject.startsWith('hitl.completed.')) {
      this.observabilityService.incrementCounter('hitl_intervention_completed_total');
      const outcome = typeof inner.outcome === 'string' ? inner.outcome.toUpperCase() : '';
      if (outcome === 'SUCCESS') {
        this.observabilityService.incrementCounter('hitl_intervention_success_total');
      } else if (outcome === 'TIMEOUT') {
        this.observabilityService.incrementCounter('hitl_intervention_timeout_total');
      } else {
        this.observabilityService.incrementCounter('hitl_intervention_failed_total');
      }

      if (sessionId) {
        const startedAt = this.interventionRequestedAtMs.get(sessionId);
        if (typeof startedAt === 'number') {
          this.observabilityService.recordHistogram(
            'hitl_request_to_resolution_ms',
            Date.now() - startedAt,
          );
          this.interventionRequestedAtMs.delete(sessionId);
        }
      }
      return;
    }

    if (subject.startsWith('session.state.changed.')) {
      const oldState = typeof inner.old_state === 'string' ? inner.old_state : '';
      const newState = typeof inner.new_state === 'string' ? inner.new_state : '';
      if (oldState === 'LOGIN_IN_PROGRESS' && newState === 'HEALTHY') {
        this.observabilityService.incrementCounter('hitl_resumed_total');
      } else if (oldState === 'LOGIN_IN_PROGRESS' && newState === 'FAILED') {
        this.observabilityService.incrementCounter('hitl_failed_total');
      }
    }
  }
}
