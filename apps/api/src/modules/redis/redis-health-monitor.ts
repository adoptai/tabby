import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import {
  requireEnv,
  DEFAULTS,
  RedisHealthState,
  RedisFailureTier,
} from '@browser-hitl/shared';

/**
 * Redis health monitor with three-state machine (ADR-011).
 *
 * Runs periodic PING probes and exposes health state to all Redis-dependent
 * services. Each service queries the monitor to determine tier-appropriate
 * failure behavior.
 *
 * State machine:
 *   HEALTHY → DEGRADED  (1 failure)
 *   DEGRADED → DOWN     (REDIS_DOWN_THRESHOLD consecutive failures)
 *   DOWN → DEGRADED     (1 success)
 *   DEGRADED → HEALTHY  (REDIS_RECOVERY_THRESHOLD consecutive successes)
 */
@Injectable()
export class RedisHealthMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisHealthMonitor.name);
  private redis: Redis;
  private probeTimer: ReturnType<typeof setInterval> | null = null;

  private state: RedisHealthState = RedisHealthState.HEALTHY;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private lastProbeAt: Date | null = null;
  private lastError: string | null = null;

  constructor() {
    this.redis = new Redis(requireEnv('REDIS_URL', {
      testDefault: 'redis://localhost:6379',
    }), {
      maxRetriesPerRequest: 1,
      connectTimeout: DEFAULTS.REDIS_PROBE_TIMEOUT_MS,
      lazyConnect: true,
    });

    // Suppress ioredis connection error noise — the probe handles state transitions
    this.redis.on('error', () => {});
  }

  async onModuleInit(): Promise<void> {
    await this.probe();
    this.probeTimer = setInterval(
      () => this.probe(),
      DEFAULTS.REDIS_PROBE_INTERVAL_MS,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
    try {
      await this.redis.quit();
    } catch {
      // Ignore quit errors during shutdown
    }
  }

  // ---------------------------------------------------------------
  // Public API — state queries
  // ---------------------------------------------------------------

  getState(): RedisHealthState {
    return this.state;
  }

  isHealthy(): boolean {
    return this.state === RedisHealthState.HEALTHY;
  }

  isDegraded(): boolean {
    return this.state === RedisHealthState.DEGRADED;
  }

  isDown(): boolean {
    return this.state === RedisHealthState.DOWN;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getLastProbeAt(): Date | null {
    return this.lastProbeAt;
  }

  /**
   * Evaluate tier-appropriate behavior for the current health state.
   *
   * Returns:
   * - 'proceed': execute the Redis operation normally
   * - 'deny': fail-closed — block the operation (SECURITY tier when DOWN)
   * - 'skip': fail-open — use safe defaults, skip Redis (AVAILABILITY when DOWN,
   *           CONSISTENCY when DEGRADED/DOWN)
   */
  evaluateTier(tier: RedisFailureTier): 'proceed' | 'deny' | 'skip' {
    if (this.state === RedisHealthState.HEALTHY) {
      return 'proceed';
    }

    if (this.state === RedisHealthState.DEGRADED) {
      switch (tier) {
        case RedisFailureTier.SECURITY:
          return 'proceed'; // Security ops still attempt Redis when degraded
        case RedisFailureTier.CONSISTENCY:
          return 'skip';    // Use safe defaults during grace period (RT-09)
        case RedisFailureTier.AVAILABILITY:
          return 'proceed'; // Best-effort
      }
    }

    // DOWN
    switch (tier) {
      case RedisFailureTier.SECURITY:
        return 'deny';   // Fail-closed
      case RedisFailureTier.CONSISTENCY:
        return 'skip';   // Safe defaults, no grace period
      case RedisFailureTier.AVAILABILITY:
        return 'skip';   // Fail-open
    }
  }

  // ---------------------------------------------------------------
  // Probe and state machine — public for testability
  // ---------------------------------------------------------------

  async probe(): Promise<void> {
    this.lastProbeAt = new Date();
    try {
      await this.redis.ping();
      this.recordSuccess();
    } catch (err) {
      this.recordFailure((err as Error).message);
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;
    this.lastError = null;

    const prevState = this.state;

    if (this.state === RedisHealthState.DOWN) {
      // DOWN → DEGRADED on first success
      this.state = RedisHealthState.DEGRADED;
      this.consecutiveSuccesses = 1; // Reset for recovery tracking
    } else if (
      this.state === RedisHealthState.DEGRADED &&
      this.consecutiveSuccesses >= DEFAULTS.REDIS_RECOVERY_THRESHOLD
    ) {
      // DEGRADED → HEALTHY after recovery threshold
      this.state = RedisHealthState.HEALTHY;
    }

    if (prevState !== this.state) {
      this.logger.log(`Redis health: ${prevState} → ${this.state}`);
    }
  }

  recordFailure(error?: string): void {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;
    this.lastError = error || 'unknown error';

    const prevState = this.state;

    if (this.state === RedisHealthState.HEALTHY) {
      // HEALTHY → DEGRADED on first failure
      this.state = RedisHealthState.DEGRADED;
    } else if (
      this.state === RedisHealthState.DEGRADED &&
      this.consecutiveFailures >= DEFAULTS.REDIS_DOWN_THRESHOLD
    ) {
      // DEGRADED → DOWN after threshold
      this.state = RedisHealthState.DOWN;
    }

    if (prevState !== this.state) {
      this.logger.warn(`Redis health: ${prevState} → ${this.state} (${this.lastError})`);
    }
  }
}
