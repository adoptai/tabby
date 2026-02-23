import { TokenBlacklistService } from './token-blacklist.service';

/**
 * Adversarial tests for token revocation (C1 remediation + ADR-011 SECURITY tier).
 * These tests verify the blacklist contract WITHOUT requiring a running Redis instance.
 * They mock Redis and the RedisHealthMonitor to test the service logic in isolation.
 */

// Mock ioredis at module level
const mockRedis = {
  set: jest.fn().mockResolvedValue('OK'),
  get: jest.fn().mockResolvedValue(null),
  quit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

// ---------------------------------------------------------------------------
// Mock RedisHealthMonitor
// ---------------------------------------------------------------------------

function createMockHealthMonitor(state: 'HEALTHY' | 'DEGRADED' | 'DOWN' = 'HEALTHY') {
  return {
    isDown: jest.fn().mockReturnValue(state === 'DOWN'),
    isDegraded: jest.fn().mockReturnValue(state === 'DEGRADED'),
    isHealthy: jest.fn().mockReturnValue(state === 'HEALTHY'),
    getState: jest.fn().mockReturnValue(state),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokenBlacklistService', () => {
  let service: TokenBlacklistService;
  let mockMonitor: ReturnType<typeof createMockHealthMonitor>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMonitor = createMockHealthMonitor();
    service = new TokenBlacklistService(mockMonitor as any);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('revoke() stores jti in Redis with correct TTL', async () => {
    const jti = 'test-jti-123';
    const expiresAtEpoch = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

    await service.revoke(jti, expiresAtEpoch);

    expect(mockRedis.set).toHaveBeenCalledWith(
      'token:revoked:test-jti-123',
      '1',
      'EX',
      expect.any(Number),
    );

    // TTL should be roughly 3600 seconds (within 5s tolerance for test execution time)
    const actualTtl = mockRedis.set.mock.calls[0][3];
    expect(actualTtl).toBeGreaterThan(3590);
    expect(actualTtl).toBeLessThanOrEqual(3600);
  });

  it('isRevoked() returns true for revoked tokens', async () => {
    mockRedis.get.mockResolvedValueOnce('1');

    const result = await service.isRevoked('revoked-jti');

    expect(result).toBe(true);
    expect(mockRedis.get).toHaveBeenCalledWith('token:revoked:revoked-jti');
  });

  it('isRevoked() returns false for non-revoked tokens', async () => {
    mockRedis.get.mockResolvedValueOnce(null);

    const result = await service.isRevoked('valid-jti');

    expect(result).toBe(false);
  });

  it('isRevoked() returns false on empty jti (fail-safe)', async () => {
    const result = await service.isRevoked('');
    expect(result).toBe(false);
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  // =========================================================================
  // ADR-011: SECURITY Tier — Fail-Closed Behavior
  // =========================================================================

  it('isRevoked() fails closed when Redis is unreachable (ADR-011 SECURITY tier)', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await service.isRevoked('any-jti');

    // Fail-closed: assume token is revoked when Redis errors occur
    expect(result).toBe(true);
  });

  it('isRevoked() fails closed when health monitor reports DOWN', async () => {
    mockMonitor.isDown.mockReturnValue(true);

    const result = await service.isRevoked('any-jti');

    expect(result).toBe(true);
    // Should short-circuit: don't even attempt Redis when known DOWN
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('isRevoked() still checks Redis when health monitor reports DEGRADED', async () => {
    mockMonitor.isDown.mockReturnValue(false);
    mockMonitor.isDegraded.mockReturnValue(true);
    mockRedis.get.mockResolvedValueOnce(null);

    const result = await service.isRevoked('test-jti');

    // SECURITY tier: still attempt Redis when degraded
    expect(result).toBe(false);
    expect(mockRedis.get).toHaveBeenCalledWith('token:revoked:test-jti');
  });

  it('revoke() computes minimum TTL of 1 second for nearly-expired tokens', async () => {
    const jti = 'expiring-soon';
    const expiresAtEpoch = Math.floor(Date.now() / 1000) - 10; // Already expired

    await service.revoke(jti, expiresAtEpoch);

    const actualTtl = mockRedis.set.mock.calls[0][3];
    expect(actualTtl).toBe(1); // Floor of 1 second
  });
});

describe('AuthService token jti inclusion', () => {
  it('login tokens include jti field', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'auth.service.ts'),
      'utf-8',
    );
    expect(source).toContain("jti: randomUUID()");
    expect(source).toContain("randomUUID");
  });
});

describe('JwtStrategy blacklist check', () => {
  it('jwt.strategy.ts checks token blacklist on validate', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'jwt.strategy.ts'),
      'utf-8',
    );
    expect(source).toContain('tokenBlacklist.isRevoked');
    expect(source).toContain("throw new UnauthorizedException('Token has been revoked')");
  });
});

describe('AuthController logout endpoint', () => {
  it('auth.controller.ts has a logout endpoint', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'auth.controller.ts'),
      'utf-8',
    );
    expect(source).toContain("@Post('auth/logout')");
    expect(source).toContain('tokenBlacklist.revoke');
    expect(source).toContain("AuthGuard('jwt')");
  });
});
