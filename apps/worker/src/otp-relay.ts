import Redis from 'ioredis';
import { REDIS_KEYS, REDIS_TTL, requireEnv } from '@browser-hitl/shared';

/**
 * OTP Relay per spec section 9.7:
 * Worker polls Redis otp:{session_id} at 1-second interval.
 * Reads value, returns it, deletes key immediately.
 * OTP values never logged, never persisted beyond 60s Redis TTL.
 */
export class OtpRelay {
  private redis: Redis | null = null;

  constructor(private readonly sessionId: string) {}

  private getRedis(): Redis {
    if (!this.redis) {
      this.redis = new Redis(requireEnv('REDIS_URL', {
        testDefault: 'redis://localhost:6379',
      }));
    }
    return this.redis;
  }

  /**
   * Poll for OTP value from Redis.
   * Returns the OTP value when available, null on timeout.
   */
  async waitForOtp(timeoutMs: number = 120000): Promise<string | null> {
    const redis = this.getRedis();
    const key = REDIS_KEYS.otp(this.sessionId);
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const value = await redis.get(key);

      if (value) {
        // Immediately delete the key after reading (spec requirement)
        await redis.del(key);
        return value;
      }

      // Poll at 1-second interval
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return null; // Timeout
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}
