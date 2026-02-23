import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import {
  requireEnv,
  DEFAULTS,
  REDIS_KEYS,
  RedisFailureTier,
} from '@browser-hitl/shared';
import { AuthRequestEntity } from '../../entities/auth-request.entity';
import { SessionEntity } from '../../entities/session.entity';
import { RedisHealthMonitor } from '../redis/redis-health-monitor';

/**
 * Result of a login lock acquisition attempt.
 */
export type AcquireLockResult =
  | { acquired: true; authRequest: AuthRequestEntity }
  | { acquired: false; reason: string };

/**
 * Three-Barrier Login Serialization Service (ADR-012).
 *
 * Prevents concurrent logins to the same target application using three
 * independent, defense-in-depth barriers:
 *
 *   Barrier 1: Redis SETNX lock (fast-path ~1ms)
 *   Barrier 2: PG partial unique index on auth_requests (durable ~5ms)
 *   Barrier 3: Worker-side rate guard via last_login_attempt_at (PG-persisted)
 *
 * Each barrier independently prevents duplicate logins. A login proceeds
 * only when all three barriers pass.
 */
@Injectable()
export class LoginSerializationService implements OnModuleDestroy {
  private readonly logger = new Logger(LoginSerializationService.name);
  private readonly redis: Redis;

  constructor(
    @InjectRepository(AuthRequestEntity)
    private readonly authRequestRepo: Repository<AuthRequestEntity>,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    private readonly healthMonitor: RedisHealthMonitor,
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

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------

  /**
   * Attempt to acquire all three barriers for a login operation.
   *
   * On success, returns the AuthRequest entity in IN_PROGRESS state.
   * On failure (any barrier), returns the reason for rejection.
   */
  async acquireLoginLock(params: {
    sessionId: string;
    tenantId: string;
    appId: string;
    lockTtlMs?: number;
    minIntervalMs?: number;
  }): Promise<AcquireLockResult> {
    const {
      sessionId,
      tenantId,
      appId,
      lockTtlMs = DEFAULTS.LOGIN_LOCK_TTL_MS,
      minIntervalMs = DEFAULTS.MIN_LOGIN_INTERVAL_MS,
    } = params;

    // --- Barrier 1: Redis lock (fast-path rejection) ---
    const barrier1 = await this.acquireRedisLock(tenantId, appId, lockTtlMs);
    if (!barrier1.acquired) {
      return { acquired: false, reason: `Barrier 1 (Redis): ${barrier1.reason}` };
    }

    // --- Barrier 2: PG row-level lock via partial unique index ---
    const barrier2 = await this.acquirePgLock(sessionId, tenantId, appId);
    if (!barrier2.acquired) {
      // Release Barrier 1 since Barrier 2 failed
      await this.releaseRedisLock(tenantId, appId);
      return { acquired: false, reason: `Barrier 2 (PG): ${barrier2.reason}` };
    }

    // --- Barrier 3: Worker-side rate guard ---
    const barrier3 = await this.checkRateGuard(sessionId, minIntervalMs);
    if (!barrier3.passed) {
      // Release Barriers 1 and 2
      await this.releaseRedisLock(tenantId, appId);
      await this.expireAuthRequest(barrier2.authRequest.id, 'Rate guard rejected');
      return { acquired: false, reason: `Barrier 3 (Rate guard): ${barrier3.reason}` };
    }

    // All three barriers passed — update rate guard timestamp
    await this.sessionRepo.update(sessionId, {
      last_login_attempt_at: new Date(),
    });

    this.logger.log(
      `Login lock acquired for tenant=${tenantId} app=${appId} session=${sessionId} ` +
      `(auth_request=${barrier2.authRequest.id})`,
    );

    return { acquired: true, authRequest: barrier2.authRequest };
  }

  /**
   * Release the login lock on completion or failure.
   */
  async releaseLoginLock(
    authRequestId: string,
    tenantId: string,
    appId: string,
    outcome: 'COMPLETED' | 'FAILED',
    failureReason?: string,
  ): Promise<void> {
    const now = new Date();

    await this.authRequestRepo.update(authRequestId, {
      state: outcome,
      resolved_at: now,
      failure_reason: outcome === 'FAILED' ? (failureReason || 'Unknown failure') : null,
    });

    await this.releaseRedisLock(tenantId, appId);

    this.logger.log(
      `Login lock released: auth_request=${authRequestId} outcome=${outcome}`,
    );
  }

  /**
   * Sweep stale IN_PROGRESS auth requests (called by Controller reconcile).
   *
   * Finds auth requests stuck in IN_PROGRESS longer than the stale threshold,
   * transitions them to EXPIRED, and releases their Redis locks.
   */
  async sweepStaleRequests(staleThresholdMs: number = DEFAULTS.AUTH_REQUEST_STALE_MS): Promise<number> {
    const cutoff = new Date(Date.now() - staleThresholdMs);

    // Find stale IN_PROGRESS requests
    const staleRequests = await this.authRequestRepo
      .createQueryBuilder('ar')
      .where('ar.state = :state', { state: 'IN_PROGRESS' })
      .andWhere('ar.created_at < :cutoff', { cutoff })
      .getMany();

    if (staleRequests.length === 0) {
      return 0;
    }

    for (const req of staleRequests) {
      await this.authRequestRepo.update(req.id, {
        state: 'EXPIRED',
        resolved_at: new Date(),
        failure_reason: `Stale: IN_PROGRESS for >${staleThresholdMs}ms`,
      });

      await this.releaseRedisLock(req.tenant_id, req.app_id);

      this.logger.warn(
        `Expired stale auth request: id=${req.id} tenant=${req.tenant_id} app=${req.app_id} ` +
        `age=${Date.now() - req.created_at.getTime()}ms`,
      );
    }

    return staleRequests.length;
  }

  // ---------------------------------------------------------------
  // Barrier 1: Redis Lock
  // ---------------------------------------------------------------

  private async acquireRedisLock(
    tenantId: string,
    appId: string,
    ttlMs: number,
  ): Promise<{ acquired: true } | { acquired: false; reason: string }> {
    const key = REDIS_KEYS.authReqLock(tenantId, appId);

    // ADR-011: SECURITY tier — fail-closed when Redis is DOWN
    const tierAction = this.healthMonitor.evaluateTier(RedisFailureTier.SECURITY);
    if (tierAction === 'deny') {
      return { acquired: false, reason: 'Redis DOWN — SECURITY tier fail-closed' };
    }

    try {
      const ttlSeconds = Math.ceil(ttlMs / 1000);
      const result = await this.redis.set(key, Date.now().toString(), 'EX', ttlSeconds, 'NX');

      if (result === 'OK') {
        return { acquired: true };
      }
      return { acquired: false, reason: 'Lock already held (concurrent login in progress)' };
    } catch (err) {
      // SECURITY tier: fail-closed on Redis error
      this.logger.error(`Redis lock acquisition failed (fail-closed): ${(err as Error).message}`);
      return { acquired: false, reason: 'Redis error — SECURITY tier fail-closed' };
    }
  }

  private async releaseRedisLock(tenantId: string, appId: string): Promise<void> {
    const key = REDIS_KEYS.authReqLock(tenantId, appId);
    try {
      await this.redis.del(key);
    } catch (err) {
      // Best-effort release — the TTL will clean up regardless
      this.logger.warn(`Failed to release Redis lock ${key}: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------
  // Barrier 2: PostgreSQL Row-Level Lock
  // ---------------------------------------------------------------

  private async acquirePgLock(
    sessionId: string,
    tenantId: string,
    appId: string,
  ): Promise<{ acquired: true; authRequest: AuthRequestEntity } | { acquired: false; reason: string }> {
    try {
      // INSERT with ON CONFLICT on the partial unique index.
      // If an IN_PROGRESS row already exists for this tenant+app,
      // the insert silently does nothing (DO NOTHING).
      const result = await this.authRequestRepo.query(
        `INSERT INTO auth_requests (session_id, tenant_id, app_id, state)
         VALUES ($1, $2, $3, 'IN_PROGRESS')
         ON CONFLICT (tenant_id, app_id) WHERE state = 'IN_PROGRESS'
         DO NOTHING
         RETURNING *`,
        [sessionId, tenantId, appId],
      );

      if (result.length > 0) {
        // Row was inserted — we own the lock
        const row = result[0];
        const authRequest = this.authRequestRepo.create({
          id: row.id,
          session_id: row.session_id,
          tenant_id: row.tenant_id,
          app_id: row.app_id,
          state: row.state,
          created_at: row.created_at,
          updated_at: row.updated_at,
        });
        return { acquired: true, authRequest };
      }

      // No row returned — conflict (IN_PROGRESS row already exists)
      return { acquired: false, reason: 'PG lock conflict — another login IN_PROGRESS for this app' };
    } catch (err) {
      this.logger.error(`PG lock acquisition failed: ${(err as Error).message}`);
      return { acquired: false, reason: `PG error: ${(err as Error).message}` };
    }
  }

  private async expireAuthRequest(authRequestId: string, reason: string): Promise<void> {
    await this.authRequestRepo.update(authRequestId, {
      state: 'EXPIRED',
      resolved_at: new Date(),
      failure_reason: reason,
    });
  }

  // ---------------------------------------------------------------
  // Barrier 3: Worker-Side Rate Guard (PG-persisted, RT-10)
  // ---------------------------------------------------------------

  private async checkRateGuard(
    sessionId: string,
    minIntervalMs: number,
  ): Promise<{ passed: true } | { passed: false; reason: string }> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      select: ['id', 'last_login_attempt_at'],
    });

    if (!session) {
      return { passed: false, reason: 'Session not found' };
    }

    if (!session.last_login_attempt_at) {
      // No previous login attempt — rate guard passes
      return { passed: true };
    }

    const elapsed = Date.now() - session.last_login_attempt_at.getTime();
    if (elapsed < minIntervalMs) {
      const waitMs = minIntervalMs - elapsed;
      return {
        passed: false,
        reason: `Rate guard: ${Math.ceil(waitMs / 1000)}s remaining before next login allowed`,
      };
    }

    return { passed: true };
  }
}
