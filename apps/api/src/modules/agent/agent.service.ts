import {
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SessionState, requireEnv } from '@browser-hitl/shared';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import { SessionEntity } from '../../entities';
import { AppsService } from '../apps/apps.service';
import { SessionsService } from '../sessions/sessions.service';
import { HitlService } from '../hitl/hitl.service';
import { RunUrlDto } from './agent.controller';

type IdempotencyRecord = {
  status: 'in_progress' | 'complete';
  request_hash: string;
  started_at: string;
  completed_at?: string;
  response?: Record<string, unknown>;
};

@Injectable()
export class AgentService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentService.name);
  private readonly redis: Redis;

  constructor(
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    private readonly appsService: AppsService,
    private readonly sessionsService: SessionsService,
    private readonly hitlService: HitlService,
  ) {
    this.redis = new Redis(requireEnv('REDIS_URL', {
      testDefault: 'redis://localhost:6379',
    }), {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    this.redis.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async runUrl(
    dto: RunUrlDto,
    tenantId: string,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const normalizedIdempotencyKey = this.normalizeIdempotencyKey(idempotencyKey);
    if (normalizedIdempotencyKey) {
      return this.runUrlWithIdempotency(dto, tenantId, actorId, normalizedIdempotencyKey);
    }

    return this.executeRunUrl(dto, tenantId, actorId);
  }

  private async runUrlWithIdempotency(
    dto: RunUrlDto,
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const requestHash = this.computeRequestHash(dto, tenantId);
    const replay = await this.resolveExistingIdempotentResponse(
      idempotencyKey,
      tenantId,
      requestHash,
    );
    if (replay) {
      return {
        ...replay,
        idempotency: {
          key: idempotencyKey,
          replayed: true,
        },
      };
    }

    const reserved = await this.reserveIdempotencyKey(idempotencyKey, tenantId, requestHash);
    if (!reserved) {
      const replayAfterRace = await this.resolveExistingIdempotentResponse(
        idempotencyKey,
        tenantId,
        requestHash,
      );
      if (replayAfterRace) {
        return {
          ...replayAfterRace,
          idempotency: {
            key: idempotencyKey,
            replayed: true,
          },
        };
      }
      throw new ConflictException(`Idempotency key ${idempotencyKey} is already in progress`);
    }

    try {
      const response = await this.executeRunUrl(dto, tenantId, actorId);
      await this.persistIdempotentResponse(idempotencyKey, tenantId, requestHash, response);
      return {
        ...response,
        idempotency: {
          key: idempotencyKey,
          replayed: false,
        },
      };
    } catch (error) {
      await this.clearIdempotencyReservation(idempotencyKey, tenantId, requestHash);
      throw error;
    }
  }

  private async executeRunUrl(
    dto: RunUrlDto,
    tenantId: string,
    actorId: string,
  ): Promise<Record<string, unknown>> {
    const credentialRef = (dto.credential_ref || process.env.AGENT_DEFAULT_CREDENTIAL_REF || '').trim();
    if (!credentialRef) {
      throw new BadRequestException(
        'credential_ref is required (or configure AGENT_DEFAULT_CREDENTIAL_REF for default behavior)',
      );
    }

    const appName = dto.app_name?.trim() || `agent-run-${Date.now()}`;
    const desiredSessions = dto.desired_sessions ?? 1;
    const waitForState = dto.wait_for_state || SessionState.HEALTHY;
    const waitTimeoutSeconds = dto.wait_timeout_seconds ?? 240;
    const keepaliveInterval = dto.keepalive_interval_seconds ?? 300;
    const notificationChannels = this.resolveNotificationChannels(dto.notification_channels, dto.slack_channel);
    const loginSteps = dto.login_steps?.length ? dto.login_steps : this.buildDefaultLoginSteps(dto.url);

    const appCreateInput = {
      name: appName,
      target_urls: [dto.url],
      login_config: {
        login_url: dto.url,
        credential_ref: credentialRef,
        steps: loginSteps,
      },
      keepalive_config: {
        interval_seconds: keepaliveInterval,
        actions: dto.keepalive_actions || [],
        health_checks: [
          {
            type: 'url_check',
            url: dto.url,
            expect_status: 200,
          },
        ],
        policy: 'all',
      },
      export_policy: {
        artifact_types: ['cookies', 'headers', 'csrf_token'],
        encryption: { algo: 'AES-256-GCM', key_version: 'v1' },
        ttl_seconds: 3600,
      },
      notification_config: {
        channels: notificationChannels,
      },
      desired_session_count: desiredSessions,
      browser_policy: {
        downloads: false,
        clipboard: false,
        file_chooser: false,
      },
    };

    const { app_id: appId } = await this.appsService.create(appCreateInput, tenantId, actorId);
    await this.sessionsService.scale(appId, desiredSessions, tenantId, actorId);

    const sessions = await this.waitForSessions(
      appId,
      tenantId,
      desiredSessions,
      waitForState,
      waitTimeoutSeconds,
    );
    const primarySession = sessions[0];

    const sessionEntries: Array<Record<string, unknown>> = [];
    for (const session of sessions) {
      const sessionEndpoints = this.buildSessionEndpoints(session.id);
      let sessionStream: unknown = null;
      if (dto.include_stream_url) {
        sessionStream = await this.hitlService.generateStreamUrl(session.id, tenantId, actorId);
      }
      sessionEntries.push({
        session_id: session.id,
        state: session.state,
        endpoints: sessionEndpoints,
        stream: sessionStream,
      });
    }

    const primaryEndpoints = this.buildSessionEndpoints(primarySession.id);
    const primaryEntry = sessionEntries.find((entry) => entry.session_id === primarySession.id) || null;
    const primaryStream = primaryEntry ? primaryEntry.stream : null;

    return {
      run_id: appId,
      app_id: appId,
      session_id: primarySession.id,
      session_ids: sessions.map((session) => session.id),
      sessions: sessionEntries,
      tenant_id: tenantId,
      state: primarySession.state,
      target_url: dto.url,
      desired_sessions: desiredSessions,
      wait_for_state: waitForState,
      endpoints: primaryEndpoints,
      stream: primaryStream,
    };
  }

  private normalizeIdempotencyKey(raw?: string): string | null {
    const value = (raw || '').trim();
    if (!value) {
      return null;
    }
    if (value.length > 128) {
      throw new BadRequestException('idempotency-key header must be at most 128 characters');
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
      throw new BadRequestException(
        'idempotency-key header contains invalid characters',
      );
    }
    return value;
  }

  private computeRequestHash(dto: RunUrlDto, tenantId: string): string {
    const payload = JSON.stringify({
      tenant_id: tenantId,
      dto,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  private getIdempotencyRedisKey(tenantId: string, key: string): string {
    return `idempotency:agent:run-url:${tenantId}:${key}`;
  }

  private getIdempotencyTtlSeconds(): number {
    const parsed = Number.parseInt(process.env.AGENT_RUN_URL_IDEMPOTENCY_TTL_SECONDS || '86400', 10);
    if (!Number.isFinite(parsed)) {
      return 86400;
    }
    return Math.max(60, Math.min(parsed, 7 * 24 * 60 * 60));
  }

  private async resolveExistingIdempotentResponse(
    key: string,
    tenantId: string,
    requestHash: string,
  ): Promise<Record<string, unknown> | null> {
    const redisKey = this.getIdempotencyRedisKey(tenantId, key);
    const raw = await this.redis.get(redisKey);
    if (!raw) {
      return null;
    }

    const record = this.parseIdempotencyRecord(raw);
    if (!record) {
      return null;
    }
    if (record.request_hash !== requestHash) {
      throw new ConflictException(
        `Idempotency key ${key} is already used for a different request payload`,
      );
    }
    if (record.status === 'in_progress') {
      throw new ConflictException(`Idempotency key ${key} is already in progress`);
    }
    if (record.status === 'complete' && record.response && typeof record.response === 'object') {
      return record.response;
    }
    return null;
  }

  private async reserveIdempotencyKey(
    key: string,
    tenantId: string,
    requestHash: string,
  ): Promise<boolean> {
    const redisKey = this.getIdempotencyRedisKey(tenantId, key);
    const record: IdempotencyRecord = {
      status: 'in_progress',
      request_hash: requestHash,
      started_at: new Date().toISOString(),
    };
    const stored = await this.redis.set(
      redisKey,
      JSON.stringify(record),
      'EX',
      this.getIdempotencyTtlSeconds(),
      'NX',
    );
    return stored === 'OK';
  }

  private async persistIdempotentResponse(
    key: string,
    tenantId: string,
    requestHash: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    const redisKey = this.getIdempotencyRedisKey(tenantId, key);
    const record: IdempotencyRecord = {
      status: 'complete',
      request_hash: requestHash,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      response,
    };
    await this.redis.set(
      redisKey,
      JSON.stringify(record),
      'EX',
      this.getIdempotencyTtlSeconds(),
    );
  }

  private async clearIdempotencyReservation(
    key: string,
    tenantId: string,
    requestHash: string,
  ): Promise<void> {
    const redisKey = this.getIdempotencyRedisKey(tenantId, key);
    const raw = await this.redis.get(redisKey);
    if (!raw) {
      return;
    }
    const record = this.parseIdempotencyRecord(raw);
    if (!record) {
      return;
    }
    if (record.status === 'in_progress' && record.request_hash === requestHash) {
      await this.redis.del(redisKey);
    }
  }

  private parseIdempotencyRecord(raw: string): IdempotencyRecord | null {
    try {
      const parsed = JSON.parse(raw) as Partial<IdempotencyRecord>;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      if (parsed.status !== 'in_progress' && parsed.status !== 'complete') {
        return null;
      }
      if (typeof parsed.request_hash !== 'string') {
        return null;
      }
      return parsed as IdempotencyRecord;
    } catch {
      return null;
    }
  }

  private buildDefaultLoginSteps(url: string): Record<string, unknown>[] {
    return [
      {
        action: 'goto',
        url,
        timeout_ms: 45000,
      },
      {
        action: 'wait_for',
        selector: 'body',
        timeout_ms: 30000,
      },
    ];
  }

  private resolveNotificationChannels(channels?: string[], slackChannel?: string): string[] {
    const normalized = (channels || [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (normalized.length > 0) {
      return normalized;
    }

    if (slackChannel && slackChannel.trim().length > 0) {
      const value = slackChannel.trim();
      return [value.startsWith('slack:') ? value : `slack:${value}`];
    }

    const envDefault = (process.env.AGENT_DEFAULT_SLACK_CHANNEL || '').trim();
    if (envDefault.length > 0) {
      return [envDefault.startsWith('slack:') ? envDefault : `slack:${envDefault}`];
    }

    return ['slack:#general'];
  }

  private buildSessionEndpoints(sessionId: string): Record<string, string> {
    return {
      stream_request: `/sessions/${sessionId}/stream`,
      takeover: `/sessions/${sessionId}/takeover`,
      otp_submit: `/sessions/${sessionId}/otp`,
      release: `/sessions/${sessionId}/release`,
      interventions: `/sessions/${sessionId}/interventions`,
    };
  }

  private async waitForSessions(
    appId: string,
    tenantId: string,
    desiredCount: number,
    waitForState: SessionState,
    waitTimeoutSeconds: number,
  ): Promise<SessionEntity[]> {
    const deadline = Date.now() + waitTimeoutSeconds * 1000;
    let lastSeenSessions: SessionEntity[] = [];

    while (Date.now() < deadline) {
      const sessions = await this.sessionRepo.find({
        where: { app_id: appId, tenant_id: tenantId },
        order: { started_at: 'DESC' },
      });
      lastSeenSessions = sessions;

      if (sessions.length >= desiredCount) {
        const selected = sessions.slice(0, desiredCount);
        if (selected.every((session) => session.state === waitForState)) {
          return selected;
        }

        for (const session of selected) {
          if (session.state === SessionState.FAILED || session.state === SessionState.TERMINATED) {
            throw new BadRequestException(
              `Session ${session.id} entered terminal state ${session.state} before reaching ${waitForState}`,
            );
          }
        }
      }

      await this.sleep(2000);
    }

    const lastState = lastSeenSessions.length > 0
      ? lastSeenSessions.map((session) => `${session.id}:${session.state}`).join(',')
      : 'NO_SESSION_CREATED';
    throw new GatewayTimeoutException(
      `Timed out waiting for ${desiredCount} session(s) to reach ${waitForState} (last states: ${lastState})`,
    );
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
