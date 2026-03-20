import Redis from 'ioredis';
import { REDIS_KEYS, requireEnv } from '@browser-hitl/shared';

/**
 * Generic Human Input Relay.
 * Worker polls Redis human_input:{session_id}:{step_index} at 1-second interval.
 * Value format: JSON.stringify({ input_type: string, value: string })
 * Reads value, returns it, deletes key immediately.
 * Values never logged, never persisted beyond 300s Redis TTL.
 */
export class InputRelay {
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
   * Poll for human input value from Redis.
   * Returns the parsed input when available, null on timeout.
   */
  async waitForInput(
    stepIndex: number,
    timeoutMs: number = 120000,
  ): Promise<{ input_type: string; value: string } | null> {
    const redis = this.getRedis();
    const key = REDIS_KEYS.humanInput(this.sessionId, stepIndex);
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const raw = await redis.get(key);

      if (raw) {
        // Immediately delete the key after reading
        await redis.del(key);
        try {
          return JSON.parse(raw);
        } catch {
          return { input_type: 'unknown', value: raw };
        }
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
