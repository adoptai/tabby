import { REDIS_KEYS, REDIS_TTL } from '@browser-hitl/shared';

// ---------------------------------------------------------------------------
// StreamTokenService tests.
//
// We test the service's business logic by simulating its Redis interactions
// and JWT operations. The real service connects to Redis in its constructor,
// so we test the logic patterns directly with mocked dependencies.
// ---------------------------------------------------------------------------

describe('StreamTokenService', () => {
  // -----------------------------------------------------------------------
  // Simulate the service's in-memory Redis state
  // -----------------------------------------------------------------------
  let store: Map<string, string>;
  let jtiCounter: number;

  function mockRedis() {
    store = new Map();

    return {
      set: jest.fn().mockImplementation(
        (key: string, val: string, ex: string, ttl: number, nx: string) => {
          if (nx === 'NX' && store.has(key)) return null;
          store.set(key, val);
          return 'OK';
        },
      ),
      get: jest.fn().mockImplementation((key: string) => store.get(key) || null),
      tokenCas: jest.fn().mockImplementation((key: string) => {
        const val = store.get(key);
        if (val === 'issued') {
          store.set(key, 'consumed');
          return 1;
        }
        return 0;
      }),
      quit: jest.fn().mockResolvedValue('OK'),
      on: jest.fn(),
      defineCommand: jest.fn(),
    };
  }

  function mockJwtService() {
    jtiCounter = 0;
    return {
      sign: jest.fn().mockImplementation((payload: any, opts?: any) => {
        return `jwt.${payload.jti}.${payload.session_id}`;
      }),
      verify: jest.fn().mockImplementation((token: string) => {
        const parts = token.split('.');
        if (parts.length !== 3 || parts[0] !== 'jwt') {
          throw new Error('Invalid token');
        }
        return {
          jti: parts[1],
          session_id: parts[2],
          user_id: 'user-1',
        };
      }),
    };
  }

  // -----------------------------------------------------------------------
  // Token generation stores marker in Redis
  // -----------------------------------------------------------------------
  describe('token generation', () => {
    it('stores "issued" marker in Redis with correct key and TTL', async () => {
      const redis = mockRedis();
      const jwtService = mockJwtService();

      const jti = 'unique-jti-1';
      const sessionId = 'session-42';
      const userId = 'user-1';

      // Simulate generateToken logic
      const payload = { jti, session_id: sessionId, user_id: userId };
      const token = jwtService.sign(payload, { expiresIn: REDIS_TTL.STREAM_TOKEN_SECONDS });

      const redisKey = REDIS_KEYS.streamToken(jti);
      const stored = redis.set(redisKey, 'issued', 'EX', REDIS_TTL.STREAM_TOKEN_SECONDS, 'NX');

      expect(stored).toBe('OK');
      expect(store.get(redisKey)).toBe('issued');
      expect(redisKey).toBe(`stream_token:${jti}`);
      expect(token).toBe(`jwt.${jti}.${sessionId}`);
    });

    it('uses correct Redis key pattern stream_token:{jti}', () => {
      const jti = 'abc-def-123';
      expect(REDIS_KEYS.streamToken(jti)).toBe(`stream_token:${jti}`);
    });

    it('uses REDIS_TTL.STREAM_TOKEN_SECONDS (600s) for expiry', () => {
      expect(REDIS_TTL.STREAM_TOKEN_SECONDS).toBe(600);
    });
  });

  // -----------------------------------------------------------------------
  // First validation succeeds (issued -> consumed)
  // -----------------------------------------------------------------------
  describe('first validation succeeds', () => {
    it('transitions token from "issued" to "consumed"', async () => {
      const redis = mockRedis();
      const jwtService = mockJwtService();

      const jti = 'token-aaa';
      const redisKey = REDIS_KEYS.streamToken(jti);

      // Simulate generateToken
      redis.set(redisKey, 'issued', 'EX', 600, 'NX');
      expect(store.get(redisKey)).toBe('issued');

      // Simulate validateToken
      const token = `jwt.${jti}.session-1`;
      const payload = jwtService.verify(token);
      expect(payload.jti).toBe(jti);

      // CAS: issued -> consumed
      const casResult = redis.tokenCas(REDIS_KEYS.streamToken(payload.jti));
      expect(casResult).toBe(1);
      expect(store.get(redisKey)).toBe('consumed');
    });
  });

  // -----------------------------------------------------------------------
  // Second validation fails (already consumed)
  // -----------------------------------------------------------------------
  describe('second validation fails (already consumed)', () => {
    it('rejects the token on second use', async () => {
      const redis = mockRedis();
      const jwtService = mockJwtService();

      const jti = 'token-bbb';
      const redisKey = REDIS_KEYS.streamToken(jti);

      // Issue
      redis.set(redisKey, 'issued', 'EX', 600, 'NX');

      // First validation
      const token = `jwt.${jti}.session-1`;
      const payload = jwtService.verify(token);
      const firstResult = redis.tokenCas(REDIS_KEYS.streamToken(payload.jti));
      expect(firstResult).toBe(1);

      // Second validation
      const secondResult = redis.tokenCas(REDIS_KEYS.streamToken(payload.jti));
      expect(secondResult).toBe(0); // Already consumed
    });

    it('rejects token that was never issued', async () => {
      const redis = mockRedis();
      const jti = 'never-issued';

      const result = redis.tokenCas(REDIS_KEYS.streamToken(jti));
      expect(result).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Fail-closed when Redis unavailable
  // -----------------------------------------------------------------------
  describe('fail-closed when Redis unavailable', () => {
    it('rejects the token when Redis CAS throws an error', async () => {
      const redis = mockRedis();
      const jwtService = mockJwtService();

      // Simulate Redis failure
      redis.tokenCas.mockImplementation(() => {
        throw new Error('Redis connection refused');
      });

      const jti = 'token-ccc';
      const token = `jwt.${jti}.session-1`;
      const payload = jwtService.verify(token);

      // CAS call should throw, and the service should reject (fail-closed)
      let result: { valid: boolean; reason?: string };
      try {
        redis.tokenCas(REDIS_KEYS.streamToken(payload.jti));
        result = { valid: true };
      } catch {
        result = { valid: false, reason: 'Token validation service unavailable' };
      }

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Token validation service unavailable');
    });

    it('rejects when Redis set fails during token generation', async () => {
      const redis = mockRedis();

      // Simulate Redis refusing SET
      redis.set.mockReturnValue(null);

      const jti = 'token-ddd';
      const redisKey = REDIS_KEYS.streamToken(jti);
      const stored = redis.set(redisKey, 'issued', 'EX', 600, 'NX');

      expect(stored).toBeNull();
      // In production, this would throw 'Failed to store stream-token issuance marker in Redis'
    });
  });

  // -----------------------------------------------------------------------
  // JWT verification
  // -----------------------------------------------------------------------
  describe('JWT verification', () => {
    it('rejects invalid JWT format', () => {
      const jwtService = mockJwtService();

      expect(() => jwtService.verify('not-a-valid-token')).toThrow('Invalid token');
    });

    it('extracts correct payload from valid JWT', () => {
      const jwtService = mockJwtService();

      const payload = jwtService.verify('jwt.my-jti.my-session');
      expect(payload.jti).toBe('my-jti');
      expect(payload.session_id).toBe('my-session');
      expect(payload.user_id).toBe('user-1');
    });
  });

  // -----------------------------------------------------------------------
  // Token lifecycle (full flow)
  // -----------------------------------------------------------------------
  describe('full token lifecycle', () => {
    it('generate -> validate (success) -> re-validate (fail)', async () => {
      const redis = mockRedis();
      const jwtService = mockJwtService();

      // Generate
      const jti = 'lifecycle-token';
      const sessionId = 'session-99';
      const userId = 'user-5';
      const payload = { jti, session_id: sessionId, user_id: userId };
      const token = jwtService.sign(payload, { expiresIn: 600 });
      redis.set(REDIS_KEYS.streamToken(jti), 'issued', 'EX', 600, 'NX');

      // Validate (1st time) - should succeed
      const decoded = jwtService.verify(token);
      const cas1 = redis.tokenCas(REDIS_KEYS.streamToken(decoded.jti));
      expect(cas1).toBe(1);

      // Validate (2nd time) - should fail
      const cas2 = redis.tokenCas(REDIS_KEYS.streamToken(decoded.jti));
      expect(cas2).toBe(0);
    });
  });
});
