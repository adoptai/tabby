import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { BatonConflictException } from '../../common/exceptions/domain.exceptions';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { SessionEntity, SessionBatonEntity, InterventionEntity } from '../../entities';
import { AuditService } from '../audit/audit.service';
import {
  REDIS_KEYS, REDIS_TTL, BATON_TIMEOUTS, requireEnv,
} from '@browser-hitl/shared';
import { StreamProviderFactory } from '../streaming/stream-provider.factory';
import { ObservabilityService } from '../observability/observability.service';
import Redis from 'ioredis';

@Injectable()
export class HitlService implements OnModuleDestroy {
  private readonly logger = new Logger(HitlService.name);
  private readonly redis: Redis;

  constructor(
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(SessionBatonEntity)
    private readonly batonRepo: Repository<SessionBatonEntity>,
    @InjectRepository(InterventionEntity)
    private readonly interventionRepo: Repository<InterventionEntity>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly streamProviderFactory: StreamProviderFactory,
    private readonly observabilityService: ObservabilityService,
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

  private async findSessionForTenant(sessionId: string, tenantId: string): Promise<SessionEntity> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId, tenant_id: tenantId },
    });
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    return session;
  }

  async generateStreamUrl(
    sessionId: string,
    tenantId: string,
    actorId: string,
  ): Promise<{ url: string; expires_at: string }> {
    const session = await this.findSessionForTenant(sessionId, tenantId);
    if (session.state === 'TERMINATED') {
      throw new BadRequestException('Cannot open stream for TERMINATED session');
    }

    const streamProvider = await this.streamProviderFactory.resolve(sessionId);
    await streamProvider.startStream(sessionId);
    const stream = await streamProvider.getStreamUrl(sessionId, actorId);

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'hitl.stream_requested',
      payload: { session_id: sessionId, expires_at: stream.expires_at },
    });

    return stream;
  }

  async takeover(
    sessionId: string,
    tenantId: string,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<{ baton_state: string; expires_at: string }> {
    const cached = await this.readActionIdempotency<{ baton_state: string; expires_at: string }>(
      'takeover',
      sessionId,
      tenantId,
      actorId,
      idempotencyKey,
    );
    if (cached) {
      return cached;
    }

    const session = await this.findSessionForTenant(sessionId, tenantId);
    if (session.state !== 'LOGIN_IN_PROGRESS') {
      throw new ConflictException(
        `Session must be LOGIN_IN_PROGRESS for takeover. Current state: ${session.state}`,
      );
    }

    // CAS (Compare-And-Swap) on session_batons.version
    const result = await this.dataSource.transaction(async (manager) => {
      const baton = await manager.findOne(SessionBatonEntity, {
        where: { session_id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!baton) {
        throw new NotFoundException('Session baton not found');
      }
      await this.applyBatonTimeoutState(manager, baton);

      if (baton.baton_state === 'HUMAN_CONTROL' && baton.owner_user_id !== actorId) {
        throw new BatonConflictException('Baton is held by another user', {
          baton_state: baton.baton_state,
        });
      }
      const takeoverReady = baton.baton_state === 'HUMAN_REQUESTED' || baton.baton_state === 'HUMAN_RELEASED';
      if (!takeoverReady && baton.owner_user_id !== actorId) {
        throw new BatonConflictException(
          `Baton must be HUMAN_REQUESTED or HUMAN_RELEASED for takeover. Current state: ${baton.baton_state}`,
          { baton_state: baton.baton_state },
        );
      }

      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minute lock

      baton.baton_state = 'HUMAN_CONTROL';
      baton.owner_user_id = actorId;
      baton.acquired_at = new Date();
      baton.expires_at = expiresAt;
      baton.version = Number(baton.version) + 1;

      await manager.save(baton);

      return { baton_state: baton.baton_state, expires_at: expiresAt.toISOString() };
    });

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'hitl.takeover',
      payload: { session_id: sessionId },
    });

    await this.writeActionIdempotency('takeover', sessionId, tenantId, actorId, idempotencyKey, result);
    return result;
  }

  async release(
    sessionId: string,
    tenantId: string,
    actorId: string,
    actorRole: string,
    idempotencyKey?: string,
  ): Promise<{ baton_state: string }> {
    const cached = await this.readActionIdempotency<{ baton_state: string }>(
      'release',
      sessionId,
      tenantId,
      actorId,
      idempotencyKey,
    );
    if (cached) {
      return cached;
    }

    const session = await this.findSessionForTenant(sessionId, tenantId);

    const result = await this.dataSource.transaction(async (manager) => {
      const baton = await manager.findOne(SessionBatonEntity, {
        where: { session_id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!baton) {
        throw new NotFoundException('Session baton not found');
      }
      await this.applyBatonTimeoutState(manager, baton);

      if (baton.baton_state !== 'HUMAN_CONTROL') {
        throw new BatonConflictException('Baton is not in HUMAN_CONTROL state', {
          baton_state: baton.baton_state,
        });
      }

      if (baton.owner_user_id !== actorId && actorRole !== 'Admin') {
        throw new BatonConflictException('Only the baton holder can release it', {
          baton_state: baton.baton_state,
        });
      }

      baton.baton_state = 'HUMAN_RELEASED';
      baton.owner_user_id = null;
      baton.acquired_at = null;
      baton.expires_at = null;
      baton.version = Number(baton.version) + 1;

      await manager.save(baton);

      return { baton_state: baton.baton_state };
    });

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'hitl.release',
      payload: { session_id: sessionId },
    });

    await this.writeActionIdempotency('release', sessionId, tenantId, actorId, idempotencyKey, result);
    return result;
  }

  async submitInput(
    sessionId: string,
    inputType: string,
    value: string,
    stepIndex: number,
    tenantId: string,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<{ status: 'delivered' }> {
    const cached = await this.readActionIdempotency<{ status: 'delivered' }>(
      'input',
      sessionId,
      tenantId,
      actorId,
      idempotencyKey,
    );
    if (cached) {
      return cached;
    }

    await this.findSessionForTenant(sessionId, tenantId);

    const redisKey = REDIS_KEYS.humanInput(sessionId, stepIndex);
    const payload = JSON.stringify({ input_type: inputType, value });
    await this.redis.set(
      redisKey,
      payload,
      'EX',
      REDIS_TTL.HUMAN_INPUT_SECONDS,
    );

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'hitl.input_submitted',
      payload: { session_id: sessionId, input_type: inputType, step_index: stepIndex },
    });
    this.observabilityService.incrementCounter('hitl_input_submitted_total');

    const response = { status: 'delivered' as const };
    await this.writeActionIdempotency('input', sessionId, tenantId, actorId, idempotencyKey, response);
    return response;
  }

  async acknowledge(
    sessionId: string,
    tenantId: string,
    actorId: string,
    note?: string,
    idempotencyKey?: string,
  ): Promise<{ state: string }> {
    const cached = await this.readActionIdempotency<{ state: string }>(
      'acknowledge',
      sessionId,
      tenantId,
      actorId,
      idempotencyKey,
    );
    if (cached) {
      return cached;
    }

    const session = await this.findSessionForTenant(sessionId, tenantId);

    if (session.state !== 'FAILED') {
      throw new BadRequestException(
        `Session must be in FAILED state to acknowledge. Current state: ${session.state}`,
      );
    }
    if (session.hitl_pause_until && new Date(session.hitl_pause_until).getTime() > Date.now()) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((new Date(session.hitl_pause_until).getTime() - Date.now()) / 1000),
      );
      throw new ConflictException({
        message: 'Session is in HITL pause window',
        retry_after_seconds: retryAfterSeconds,
      });
    }

    session.state = 'STARTING';
    session.state_version = Number(session.state_version) + 1;
    session.retry_count = session.retry_count + 1;
    await this.sessionRepo.save(session);

    const latestIntervention = await this.interventionRepo.findOne({
      where: { session_id: sessionId, tenant_id: tenantId },
      order: { started_at: 'DESC' },
    });
    if (latestIntervention) {
      const update: Record<string, unknown> = {};
      const trimmedNote = (note || '').trim();
      if (trimmedNote.length > 0) {
        update.human_note = trimmedNote;
      }
      if (!latestIntervention.completed_at) {
        update.completed_at = new Date();
        if (!latestIntervention.outcome) {
          update.outcome = 'FAIL';
        }
      }
      if (Object.keys(update).length > 0) {
        await this.interventionRepo.update(latestIntervention.id, update as any);
      }
    }

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'hitl.acknowledge',
      payload: { session_id: sessionId, new_state: 'STARTING', note: note || null },
    });

    const response = { state: 'STARTING' };
    await this.writeActionIdempotency('acknowledge', sessionId, tenantId, actorId, idempotencyKey, response);
    return response;
  }

  private async applyBatonTimeoutState(manager: any, baton: SessionBatonEntity): Promise<void> {
    const now = Date.now();
    let timedOut = false;

    if (
      baton.baton_state === 'HUMAN_REQUESTED'
      && baton.requested_at
      && (now - new Date(baton.requested_at).getTime()) >= BATON_TIMEOUTS.HUMAN_REQUESTED_TIMEOUT_MS
    ) {
      baton.baton_state = 'AUTOMATION_CONTROL';
      baton.owner_user_id = null;
      baton.acquired_at = null;
      baton.expires_at = null;
      baton.version = Number(baton.version) + 1;
      timedOut = true;
    }

    if (
      baton.baton_state === 'HUMAN_CONTROL'
      && baton.acquired_at
      && (now - new Date(baton.acquired_at).getTime()) >= BATON_TIMEOUTS.HUMAN_CONTROL_INACTIVITY_TIMEOUT_MS
    ) {
      baton.baton_state = 'HUMAN_RELEASED';
      baton.owner_user_id = null;
      baton.acquired_at = null;
      baton.expires_at = null;
      baton.version = Number(baton.version) + 1;
      timedOut = true;
    }

    if (timedOut) {
      await manager.save(baton);
    }
  }

  private normalizeIdempotencyKey(value?: string): string | null {
    const normalized = (value || '').trim();
    if (!normalized) {
      return null;
    }
    if (normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
      throw new BadRequestException('Invalid idempotency key');
    }
    return normalized;
  }

  private actionIdempotencyRedisKey(
    action: string,
    tenantId: string,
    sessionId: string,
    actorId: string,
    key: string,
  ): string {
    return `hitl:idempotency:${action}:${tenantId}:${sessionId}:${actorId}:${key}`;
  }

  private async readActionIdempotency<T>(
    action: string,
    sessionId: string,
    tenantId: string,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<T | null> {
    const key = this.normalizeIdempotencyKey(idempotencyKey);
    if (!key) {
      return null;
    }
    const redisKey = this.actionIdempotencyRedisKey(action, tenantId, sessionId, actorId, key);
    const raw = await this.redis.get(redisKey);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new InternalServerErrorException('Corrupt idempotency cache entry');
    }
  }

  private async writeActionIdempotency(
    action: string,
    sessionId: string,
    tenantId: string,
    actorId: string,
    idempotencyKey: string | undefined,
    payload: unknown,
  ): Promise<void> {
    const key = this.normalizeIdempotencyKey(idempotencyKey);
    if (!key) {
      return;
    }
    const redisKey = this.actionIdempotencyRedisKey(action, tenantId, sessionId, actorId, key);
    await this.redis.set(redisKey, JSON.stringify(payload), 'EX', REDIS_TTL.HUMAN_INPUT_SECONDS);
  }
}
