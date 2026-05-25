import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { requireEnv, REDIS_KEYS } from '@browser-hitl/shared';
import { RedisHealthMonitor } from '../redis/redis-health-monitor';

@Injectable()
export class TokenBlacklistService implements OnModuleDestroy {
  private readonly logger = new Logger(TokenBlacklistService.name);
  private readonly redis: Redis;

  constructor(private readonly healthMonitor: RedisHealthMonitor) {
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

  /**
   * Revoke a token by its jti. Stored in Redis with TTL matching the token's remaining lifetime.
   * After TTL expires, the entry auto-deletes (token would have expired naturally anyway).
   */
  async revoke(jti: string, expiresAtEpoch: number): Promise<void> {
    const remainingSeconds = Math.max(1, Math.ceil(expiresAtEpoch - Date.now() / 1000));
    await this.redis.set(REDIS_KEYS.tokenRevoked(jti), '1', 'EX', remainingSeconds);
    this.logger.log(`Token ${jti.substring(0, 8)}... revoked (TTL: ${remainingSeconds}s)`);
  }

  /**
   * Check if a token has been revoked.
   *
   * ADR-011 SECURITY tier: fail-closed when Redis is unreachable.
   * When Redis is DOWN, all tokens are treated as revoked (deny all).
   * Health endpoints bypass JWT auth entirely and are unaffected (RT-02).
   */
  async isRevoked(jti: string): Promise<boolean> {
    if (!jti) return false;

    // ADR-011: SECURITY tier — when monitor confirms DOWN, fail-closed immediately
    if (this.healthMonitor.isDown()) {
      this.logger.warn('Redis DOWN — SECURITY tier fail-closed: treating token as revoked');
      return true;
    }

    try {
      const result = await this.redis.get(REDIS_KEYS.tokenRevoked(jti));
      return result !== null;
    } catch (err) {
      // ADR-011: SECURITY tier — fail-closed on any Redis error
      this.logger.error(`Blacklist check failed (fail-closed): ${err}`);
      return true;
    }
  }
}
