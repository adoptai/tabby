import { DEFAULTS } from '@browser-hitl/shared';

// ---------------------------------------------------------------------------
// Mock ioredis
// ---------------------------------------------------------------------------
const mockRedis = {
  set: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(1),
  quit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

import { LoginSerializationService, AcquireLockResult } from './login-serialization.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAuthRequestRepo() {
  return {
    query: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn().mockImplementation((data: any) => ({ ...data })),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }),
  };
}

function createMockSessionRepo() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function createMockHealthMonitor(state: 'HEALTHY' | 'DEGRADED' | 'DOWN' = 'HEALTHY') {
  return {
    isDown: jest.fn().mockReturnValue(state === 'DOWN'),
    isDegraded: jest.fn().mockReturnValue(state === 'DEGRADED'),
    isHealthy: jest.fn().mockReturnValue(state === 'HEALTHY'),
    getState: jest.fn().mockReturnValue(state),
    evaluateTier: jest.fn().mockReturnValue(
      state === 'DOWN' ? 'deny' : 'proceed',
    ),
  };
}

function buildService(overrides: {
  authRequestRepo?: any;
  sessionRepo?: any;
  healthMonitor?: any;
} = {}) {
  const authRequestRepo = overrides.authRequestRepo ?? createMockAuthRequestRepo();
  const sessionRepo = overrides.sessionRepo ?? createMockSessionRepo();
  const healthMonitor = overrides.healthMonitor ?? createMockHealthMonitor();

  const service = Object.create(LoginSerializationService.prototype);
  (service as any).authRequestRepo = authRequestRepo;
  (service as any).sessionRepo = sessionRepo;
  (service as any).healthMonitor = healthMonitor;
  (service as any).redis = mockRedis;
  (service as any).logger = {
    log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  };

  return { service: service as LoginSerializationService, authRequestRepo, sessionRepo, healthMonitor };
}

const TEST_PARAMS = {
  sessionId: 'session-uuid-1',
  tenantId: 'tenant-uuid-1',
  appId: 'app-uuid-1',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LoginSerializationService (ADR-012)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Barrier 1: Redis Lock
  // =========================================================================

  describe('Barrier 1: Redis Lock', () => {
    it('should acquire Redis lock with SETNX and TTL', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const { service, sessionRepo } = buildService();
      // Barrier 2: PG insert succeeds
      const { authRequestRepo } = buildService();
      (service as any).authRequestRepo = authRequestRepo;
      authRequestRepo.query.mockResolvedValueOnce([{
        id: 'ar-1', session_id: TEST_PARAMS.sessionId,
        tenant_id: TEST_PARAMS.tenantId, app_id: TEST_PARAMS.appId,
        state: 'IN_PROGRESS', created_at: new Date(), updated_at: new Date(),
      }]);
      // Barrier 3: No previous login
      sessionRepo.findOne.mockResolvedValueOnce({ id: TEST_PARAMS.sessionId, last_login_attempt_at: null });

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(mockRedis.set).toHaveBeenCalledWith(
        `auth_req_lock:${TEST_PARAMS.tenantId}:${TEST_PARAMS.appId}`,
        expect.any(String),
        'EX',
        Math.ceil(DEFAULTS.LOGIN_LOCK_TTL_MS / 1000),
        'NX',
      );
      expect(result.acquired).toBe(true);
    });

    it('should reject when Redis lock is already held', async () => {
      mockRedis.set.mockResolvedValueOnce(null); // SETNX returns null when key exists
      const { service } = buildService();

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(result.acquired).toBe(false);
      expect((result as any).reason).toContain('Barrier 1');
      expect((result as any).reason).toContain('Lock already held');
    });

    it('should fail-closed when Redis is DOWN (ADR-011 SECURITY tier)', async () => {
      const healthMonitor = createMockHealthMonitor('DOWN');
      const { service } = buildService({ healthMonitor });

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(result.acquired).toBe(false);
      expect((result as any).reason).toContain('Barrier 1');
      expect((result as any).reason).toContain('SECURITY tier fail-closed');
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should fail-closed on Redis error', async () => {
      mockRedis.set.mockRejectedValueOnce(new Error('Connection timeout'));
      const { service } = buildService();

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(result.acquired).toBe(false);
      expect((result as any).reason).toContain('Barrier 1');
    });
  });

  // =========================================================================
  // Barrier 2: PG Row-Level Lock
  // =========================================================================

  describe('Barrier 2: PG Row-Level Lock', () => {
    it('should insert auth request when no IN_PROGRESS exists', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const { service, authRequestRepo, sessionRepo } = buildService();
      authRequestRepo.query.mockResolvedValueOnce([{
        id: 'ar-1', session_id: TEST_PARAMS.sessionId,
        tenant_id: TEST_PARAMS.tenantId, app_id: TEST_PARAMS.appId,
        state: 'IN_PROGRESS', created_at: new Date(), updated_at: new Date(),
      }]);
      sessionRepo.findOne.mockResolvedValueOnce({ id: TEST_PARAMS.sessionId, last_login_attempt_at: null });

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(result.acquired).toBe(true);
      expect(authRequestRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO auth_requests'),
        [TEST_PARAMS.sessionId, TEST_PARAMS.tenantId, TEST_PARAMS.appId],
      );
    });

    it('should reject when IN_PROGRESS row already exists (concurrent login)', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const { service, authRequestRepo } = buildService();
      // PG INSERT returns empty (DO NOTHING hit)
      authRequestRepo.query.mockResolvedValueOnce([]);

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(result.acquired).toBe(false);
      expect((result as any).reason).toContain('Barrier 2');
      expect((result as any).reason).toContain('PG lock conflict');
      // Redis lock should be released on Barrier 2 failure
      expect(mockRedis.del).toHaveBeenCalled();
    });

    it('should release Redis lock if PG insert fails with error', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const { service, authRequestRepo } = buildService();
      authRequestRepo.query.mockRejectedValueOnce(new Error('PG connection lost'));

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(result.acquired).toBe(false);
      expect((result as any).reason).toContain('Barrier 2');
      expect(mockRedis.del).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Barrier 3: Worker-Side Rate Guard
  // =========================================================================

  describe('Barrier 3: Worker-Side Rate Guard (RT-10)', () => {
    it('should pass when no previous login attempt', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const { service, authRequestRepo, sessionRepo } = buildService();
      authRequestRepo.query.mockResolvedValueOnce([{
        id: 'ar-1', session_id: TEST_PARAMS.sessionId,
        tenant_id: TEST_PARAMS.tenantId, app_id: TEST_PARAMS.appId,
        state: 'IN_PROGRESS', created_at: new Date(), updated_at: new Date(),
      }]);
      sessionRepo.findOne.mockResolvedValueOnce({ id: TEST_PARAMS.sessionId, last_login_attempt_at: null });

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(result.acquired).toBe(true);
    });

    it('should pass when previous login was long enough ago', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const { service, authRequestRepo, sessionRepo } = buildService();
      authRequestRepo.query.mockResolvedValueOnce([{
        id: 'ar-1', session_id: TEST_PARAMS.sessionId,
        tenant_id: TEST_PARAMS.tenantId, app_id: TEST_PARAMS.appId,
        state: 'IN_PROGRESS', created_at: new Date(), updated_at: new Date(),
      }]);
      // Last login was 2 minutes ago (> 60s default interval)
      sessionRepo.findOne.mockResolvedValueOnce({
        id: TEST_PARAMS.sessionId,
        last_login_attempt_at: new Date(Date.now() - 120_000),
      });

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(result.acquired).toBe(true);
    });

    it('should reject when login was too recent', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const { service, authRequestRepo, sessionRepo } = buildService();
      authRequestRepo.query.mockResolvedValueOnce([{
        id: 'ar-1', session_id: TEST_PARAMS.sessionId,
        tenant_id: TEST_PARAMS.tenantId, app_id: TEST_PARAMS.appId,
        state: 'IN_PROGRESS', created_at: new Date(), updated_at: new Date(),
      }]);
      // Last login was 10 seconds ago (< 60s default interval)
      sessionRepo.findOne.mockResolvedValueOnce({
        id: TEST_PARAMS.sessionId,
        last_login_attempt_at: new Date(Date.now() - 10_000),
      });

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(result.acquired).toBe(false);
      expect((result as any).reason).toContain('Barrier 3');
      expect((result as any).reason).toContain('Rate guard');
      // Both Redis lock and PG auth request should be released
      expect(mockRedis.del).toHaveBeenCalled();
      expect(authRequestRepo.update).toHaveBeenCalledWith('ar-1', expect.objectContaining({
        state: 'EXPIRED',
      }));
    });

    it('should reject when session not found', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const { service, authRequestRepo, sessionRepo } = buildService();
      authRequestRepo.query.mockResolvedValueOnce([{
        id: 'ar-1', session_id: TEST_PARAMS.sessionId,
        tenant_id: TEST_PARAMS.tenantId, app_id: TEST_PARAMS.appId,
        state: 'IN_PROGRESS', created_at: new Date(), updated_at: new Date(),
      }]);
      sessionRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(result.acquired).toBe(false);
      expect((result as any).reason).toContain('Barrier 3');
    });

    it('should update last_login_attempt_at on successful acquisition', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const { service, authRequestRepo, sessionRepo } = buildService();
      authRequestRepo.query.mockResolvedValueOnce([{
        id: 'ar-1', session_id: TEST_PARAMS.sessionId,
        tenant_id: TEST_PARAMS.tenantId, app_id: TEST_PARAMS.appId,
        state: 'IN_PROGRESS', created_at: new Date(), updated_at: new Date(),
      }]);
      sessionRepo.findOne.mockResolvedValueOnce({ id: TEST_PARAMS.sessionId, last_login_attempt_at: null });

      await service.acquireLoginLock(TEST_PARAMS);

      expect(sessionRepo.update).toHaveBeenCalledWith(
        TEST_PARAMS.sessionId,
        expect.objectContaining({ last_login_attempt_at: expect.any(Date) }),
      );
    });
  });

  // =========================================================================
  // Release Lock
  // =========================================================================

  describe('releaseLoginLock', () => {
    it('should mark auth request as COMPLETED and release Redis lock', async () => {
      const { service, authRequestRepo } = buildService();

      await service.releaseLoginLock('ar-1', TEST_PARAMS.tenantId, TEST_PARAMS.appId, 'COMPLETED');

      expect(authRequestRepo.update).toHaveBeenCalledWith('ar-1', expect.objectContaining({
        state: 'COMPLETED',
        resolved_at: expect.any(Date),
        failure_reason: null,
      }));
      expect(mockRedis.del).toHaveBeenCalledWith(
        `auth_req_lock:${TEST_PARAMS.tenantId}:${TEST_PARAMS.appId}`,
      );
    });

    it('should mark auth request as FAILED with reason', async () => {
      const { service, authRequestRepo } = buildService();

      await service.releaseLoginLock('ar-1', TEST_PARAMS.tenantId, TEST_PARAMS.appId, 'FAILED', 'Login timeout');

      expect(authRequestRepo.update).toHaveBeenCalledWith('ar-1', expect.objectContaining({
        state: 'FAILED',
        failure_reason: 'Login timeout',
      }));
    });
  });

  // =========================================================================
  // Stale Sweep
  // =========================================================================

  describe('sweepStaleRequests', () => {
    it('should expire IN_PROGRESS requests older than threshold', async () => {
      const staleRequest = {
        id: 'ar-stale',
        tenant_id: TEST_PARAMS.tenantId,
        app_id: TEST_PARAMS.appId,
        state: 'IN_PROGRESS',
        created_at: new Date(Date.now() - 700_000), // 11+ minutes ago
      };

      const mockQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([staleRequest]),
      };
      const { service, authRequestRepo } = buildService();
      authRequestRepo.createQueryBuilder.mockReturnValue(mockQb);

      const count = await service.sweepStaleRequests(600_000); // 10 min threshold

      expect(count).toBe(1);
      expect(authRequestRepo.update).toHaveBeenCalledWith('ar-stale', expect.objectContaining({
        state: 'EXPIRED',
        resolved_at: expect.any(Date),
      }));
      expect(mockRedis.del).toHaveBeenCalledWith(
        `auth_req_lock:${TEST_PARAMS.tenantId}:${TEST_PARAMS.appId}`,
      );
    });

    it('should return 0 when no stale requests found', async () => {
      const mockQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      const { service, authRequestRepo } = buildService();
      authRequestRepo.createQueryBuilder.mockReturnValue(mockQb);

      const count = await service.sweepStaleRequests();

      expect(count).toBe(0);
      expect(authRequestRepo.update).not.toHaveBeenCalled();
    });

    it('should release Redis locks for all expired requests', async () => {
      const staleRequests = [
        { id: 'ar-1', tenant_id: 't1', app_id: 'a1', state: 'IN_PROGRESS', created_at: new Date(0) },
        { id: 'ar-2', tenant_id: 't2', app_id: 'a2', state: 'IN_PROGRESS', created_at: new Date(0) },
      ];

      const mockQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(staleRequests),
      };
      const { service, authRequestRepo } = buildService();
      authRequestRepo.createQueryBuilder.mockReturnValue(mockQb);

      const count = await service.sweepStaleRequests();

      expect(count).toBe(2);
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
      expect(mockRedis.del).toHaveBeenCalledWith('auth_req_lock:t1:a1');
      expect(mockRedis.del).toHaveBeenCalledWith('auth_req_lock:t2:a2');
    });
  });

  // =========================================================================
  // Adversarial: Split-Brain Simulation
  // =========================================================================

  describe('Adversarial: Split-brain scenarios', () => {
    it('should prevent concurrent login even if Redis lock was bypassed', async () => {
      // Scenario: Redis lock was somehow bypassed (e.g., race condition)
      // but PG partial unique index catches the conflict
      mockRedis.set.mockResolvedValueOnce('OK'); // Redis says OK (first caller)
      const { service, authRequestRepo, sessionRepo } = buildService();
      // PG INSERT returns empty (DO NOTHING) — another row exists
      authRequestRepo.query.mockResolvedValueOnce([]);

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(result.acquired).toBe(false);
      expect((result as any).reason).toContain('Barrier 2');
    });

    it('should reject when Redis succeeds but rate guard fails', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const { service, authRequestRepo, sessionRepo } = buildService();
      authRequestRepo.query.mockResolvedValueOnce([{
        id: 'ar-1', session_id: TEST_PARAMS.sessionId,
        tenant_id: TEST_PARAMS.tenantId, app_id: TEST_PARAMS.appId,
        state: 'IN_PROGRESS', created_at: new Date(), updated_at: new Date(),
      }]);
      // Recent login attempt (5 seconds ago)
      sessionRepo.findOne.mockResolvedValueOnce({
        id: TEST_PARAMS.sessionId,
        last_login_attempt_at: new Date(Date.now() - 5_000),
      });

      const result = await service.acquireLoginLock(TEST_PARAMS);

      expect(result.acquired).toBe(false);
      // Both barriers should be rolled back
      expect(mockRedis.del).toHaveBeenCalled(); // Redis lock released
      expect(authRequestRepo.update).toHaveBeenCalledWith('ar-1', expect.objectContaining({
        state: 'EXPIRED',
      }));
    });

    it('should use same error message shape for all barrier failures (no info leakage)', async () => {
      // All rejections include barrier number but no internal details
      mockRedis.set.mockResolvedValueOnce(null);
      const { service: s1 } = buildService();
      const r1 = await s1.acquireLoginLock(TEST_PARAMS) as { acquired: false; reason: string };

      mockRedis.set.mockResolvedValueOnce('OK');
      const { service: s2, authRequestRepo: ar2 } = buildService();
      ar2.query.mockResolvedValueOnce([]);
      const r2 = await s2.acquireLoginLock(TEST_PARAMS) as { acquired: false; reason: string };

      expect(r1.acquired).toBe(false);
      expect(r2.acquired).toBe(false);
      // Both have 'Barrier N' prefix for diagnostic correlation
      expect(r1.reason).toMatch(/^Barrier \d/);
      expect(r2.reason).toMatch(/^Barrier \d/);
    });
  });

  // =========================================================================
  // Full Lifecycle
  // =========================================================================

  describe('Full lifecycle', () => {
    it('should acquire and release lock (happy path)', async () => {
      mockRedis.set.mockResolvedValueOnce('OK');
      const { service, authRequestRepo, sessionRepo } = buildService();
      authRequestRepo.query.mockResolvedValueOnce([{
        id: 'ar-1', session_id: TEST_PARAMS.sessionId,
        tenant_id: TEST_PARAMS.tenantId, app_id: TEST_PARAMS.appId,
        state: 'IN_PROGRESS', created_at: new Date(), updated_at: new Date(),
      }]);
      sessionRepo.findOne.mockResolvedValueOnce({ id: TEST_PARAMS.sessionId, last_login_attempt_at: null });

      // Acquire
      const acquireResult = await service.acquireLoginLock(TEST_PARAMS);
      expect(acquireResult.acquired).toBe(true);

      // Release
      await service.releaseLoginLock('ar-1', TEST_PARAMS.tenantId, TEST_PARAMS.appId, 'COMPLETED');
      expect(authRequestRepo.update).toHaveBeenCalledWith('ar-1', expect.objectContaining({
        state: 'COMPLETED',
      }));
    });
  });
});
