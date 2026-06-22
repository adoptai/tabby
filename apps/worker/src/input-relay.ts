import Redis from 'ioredis';
import { REDIS_KEYS, REDIS_TTL, requireEnv } from '@browser-hitl/shared';

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
   * When autoResolveCheck is provided, also evaluates it each cycle —
   * if it returns true the wait is resolved as a synthetic confirm.
   */
  async waitForInput(
    stepIndex: number,
    timeoutMs: number = 120000,
    autoResolveCheck?: () => boolean,
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

      if (autoResolveCheck) {
        try {
          if (autoResolveCheck()) {
            console.log(`[InputRelay] Auto-resolved: login detected for step ${stepIndex}`);
            return { input_type: 'confirm', value: 'auto-resolved' };
          }
        } catch {
          // Page might not be ready — ignore and retry next cycle
        }
      }

      // Poll at 1-second interval
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return null; // Timeout
  }

  async markAutoResolved(): Promise<void> {
    const redis = this.getRedis();
    await redis.set(
      REDIS_KEYS.hitlAutoResolved(this.sessionId),
      '1',
      'EX',
      REDIS_TTL.HUMAN_INPUT_SECONDS,
    );
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}
