import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { REDIS_KEYS, REDIS_TTL, requireEnv } from '@browser-hitl/shared';

/**
 * Payload embedded inside every stream JWT.
 */
export interface StreamTokenPayload {
  jti: string;
  session_id: string;
  user_id: string;
}

/**
 * Redis Lua CAS (Compare-And-Swap) script.
 * Atomically transitions a stream-token key from "issued" to "consumed".
 *
 * Returns 1 (allow) when the token was still in the "issued" state,
 * and 0 (deny) in every other case (already consumed, expired, missing).
 */
const TOKEN_CAS_SCRIPT = `
local key = KEYS[1]
local val = redis.call('GET', key)
if val == 'issued' then
  redis.call('SET', key, 'consumed', 'KEEPTTL')
  return 1
end
return 0
`;

@Injectable()
export class StreamTokenService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamTokenService.name);
  private readonly redis: Redis;

  constructor(private readonly jwtService: JwtService) {
    this.redis = new Redis(requireEnv('REDIS_URL', {
      testDefault: 'redis://localhost:6379',
    }), {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    this.redis.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });

    // Pre-load the Lua script so subsequent calls use EVALSHA
    this.redis.defineCommand('tokenCas', {
      numberOfKeys: 1,
      lua: TOKEN_CAS_SCRIPT,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Verify JWT signature/expiry without consuming the single-use token.
   * Used by viewer bootstrap endpoints; consumption happens at WebSocket connect time.
   */
  verifyToken(
    token: string,
  ): { valid: true; payload: StreamTokenPayload } | { valid: false; reason: string } {
    try {
      const payload = this.jwtService.verify<StreamTokenPayload>(token);
      return { valid: true, payload };
    } catch (err) {
      return { valid: false, reason: `JWT verification failed: ${(err as Error).message}` };
    }
  }

  /**
   * Generate a single-use, short-lived stream JWT.
   *
   * Steps:
   *  1. Create a JWT containing jti, session_id, user_id, exp.
   *  2. Record the issuance in Redis with SET NX + TTL to guarantee
   *     the token can only be consumed once.
   */
  async generateToken(sessionId: string, userId: string): Promise<string> {
    const jti = randomUUID();
    const ttlSeconds = REDIS_TTL.STREAM_TOKEN_SECONDS; // 600 s (10 min)

    const payload: StreamTokenPayload = {
      jti,
      session_id: sessionId,
      user_id: userId,
    };

    const token = this.jwtService.sign(payload, {
      expiresIn: ttlSeconds,
    });

    // Store issuance marker. NX ensures idempotency (belt & suspenders
    // with the random jti, but still good practice).
    const redisKey = REDIS_KEYS.streamToken(jti);
    const stored = await this.redis.set(redisKey, 'issued', 'EX', ttlSeconds, 'NX');

    if (stored !== 'OK') {
      // Extremely unlikely with a UUID jti, but fail-safe.
      throw new Error('Failed to store stream-token issuance marker in Redis');
    }

    return token;
  }

  /**
   * Validate a stream JWT and atomically consume it so it cannot be reused.
   *
   * **CRITICAL**: If Redis is unreachable the method rejects the token
   * (fail-closed).
   */
  async validateToken(
    token: string,
  ): Promise<{ valid: true; payload: StreamTokenPayload } | { valid: false; reason: string }> {
    // 1. Verify JWT signature + expiration
    const verified = this.verifyToken(token);
    if (!verified.valid) {
      return verified;
    }
    const { payload } = verified;

    // 2. Atomic CAS in Redis: issued -> consumed
    try {
      const result = await (this.redis as any).tokenCas(
        REDIS_KEYS.streamToken(payload.jti),
      );

      if (Number(result) !== 1) {
        return { valid: false, reason: 'Token already consumed or expired' };
      }
    } catch (err) {
      // CRITICAL: Fail closed -- if Redis is down, reject the token.
      this.logger.error(`Redis CAS failed, rejecting token: ${(err as Error).message}`);
      return { valid: false, reason: 'Token validation service unavailable' };
    }

    return { valid: true, payload };
  }

  async createShortLink(url: string): Promise<string> {
    const shortId = Math.random().toString(36).slice(2, 10); // 8 random chars
    await this.redis.set(REDIS_KEYS.vncShortLink(shortId), url, 'EX', REDIS_TTL.VNC_SHORT_LINK_SECONDS);
    return shortId;
  }

  async resolveShortLink(shortId: string): Promise<string | null> {
    return this.redis.get(REDIS_KEYS.vncShortLink(shortId));
  }

  /**
   * Write a human-input value to Redis so the worker can pick it up.
   * Mirrors the core logic of HitlService.submitInput without the audit/
   * observability overhead — used by the stream-token-authenticated HITL
   * proxy endpoints that sit inside StreamingController.
   */
  async writeHumanInput(
    sessionId: string,
    stepIndex: number,
    inputType: string,
    value: string,
  ): Promise<void> {
    const redisKey = REDIS_KEYS.humanInput(sessionId, stepIndex);
    const payload = JSON.stringify({ input_type: inputType, value });
    await this.redis.set(redisKey, payload, 'EX', REDIS_TTL.HUMAN_INPUT_SECONDS);
  }
}
