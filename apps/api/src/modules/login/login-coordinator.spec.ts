import { DEFAULTS } from '@browser-hitl/shared';
import { LoginCoordinatorService, EnqueueResult } from './login-coordinator.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockQueueRepo() {
  return {
    create: jest.fn().mockImplementation((data: any) => ({ id: 'queue-uuid-1', ...data, requested_at: new Date() })),
    save: jest.fn().mockImplementation((data: any) => Promise.resolve({ ...data, id: data.id || 'queue-uuid-1' })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getRawMany: jest.fn().mockResolvedValue([]),
    }),
  };
}

function createMockAuthRequestRepo() {
  return {
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function createMockDataSource() {
  return {
    createQueryRunner: jest.fn().mockReturnValue({
      connect: jest.fn(),
      query: jest.fn(),
      release: jest.fn(),
      databaseConnection: { on: jest.fn() },
    }),
  };
}

function buildService(overrides: {
  queueRepo?: any;
  authRequestRepo?: any;
  dataSource?: any;
} = {}) {
  const queueRepo = overrides.queueRepo ?? createMockQueueRepo();
  const authRequestRepo = overrides.authRequestRepo ?? createMockAuthRequestRepo();
  const dataSource = overrides.dataSource ?? createMockDataSource();

  const service = Object.create(LoginCoordinatorService.prototype);
  (service as any).queueRepo = queueRepo;
  (service as any).authRequestRepo = authRequestRepo;
  (service as any).dataSource = dataSource;
  (service as any).processIntervalMs = DEFAULTS.QUEUE_PROCESS_INTERVAL_MS;
  (service as any).startupStaggerMs = 0; // No stagger in tests
  (service as any).globalMaxConcurrent = DEFAULTS.GLOBAL_MAX_CONCURRENT_LOGINS;
  (service as any).defaultMaxPerDomain = DEFAULTS.MAX_CONCURRENT_PER_DOMAIN;
  (service as any).processing = false;
  (service as any).started = true; // Skip stagger in tests
  (service as any).loginTrigger = null;
  (service as any).processTimer = null;
  (service as any).pgListenerConnection = null;
  (service as any).logger = {
    log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  };

  return { service: service as LoginCoordinatorService, queueRepo, authRequestRepo, dataSource };
}

const TEST_PARAMS = {
  authRequestId: 'ar-uuid-1',
  tenantId: 'tenant-uuid-1',
  appId: 'app-uuid-1',
  targetDomain: 'https://login.salesforce.com/auth',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LoginCoordinatorService (ADR-015)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Enqueue
  // =========================================================================

  describe('enqueue', () => {
    it('should create a QUEUED entry with normalized domain', async () => {
      const { service, queueRepo } = buildService();

      const result = await service.enqueue(TEST_PARAMS);

      expect(result.enqueued).toBe(true);
      expect(queueRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        auth_request_id: TEST_PARAMS.authRequestId,
        tenant_id: TEST_PARAMS.tenantId,
        app_id: TEST_PARAMS.appId,
        target_domain: 'salesforce.com', // normalized
        state: 'QUEUED',
      }));
      expect(queueRepo.save).toHaveBeenCalled();
    });

    it('should set priority when provided', async () => {
      const { service, queueRepo } = buildService();

      await service.enqueue({ ...TEST_PARAMS, priority: 10 });

      expect(queueRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        priority: 10,
      }));
    });

    it('should default priority to 0', async () => {
      const { service, queueRepo } = buildService();

      await service.enqueue(TEST_PARAMS);

      expect(queueRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        priority: 0,
      }));
    });

    it('should return failure when save throws', async () => {
      const { service, queueRepo } = buildService();
      queueRepo.save.mockRejectedValueOnce(new Error('FK violation'));

      const result = await service.enqueue(TEST_PARAMS);

      expect(result.enqueued).toBe(false);
      expect((result as any).reason).toContain('FK violation');
    });
  });

  // =========================================================================
  // Domain Normalization
  // =========================================================================

  describe('normalizeDomain', () => {
    it('should extract hostname from full URL', () => {
      const { service } = buildService();
      expect(service.normalizeDomain('https://login.salesforce.com/auth/login')).toBe('salesforce.com');
    });

    it('should strip "login." prefix', () => {
      const { service } = buildService();
      expect(service.normalizeDomain('login.salesforce.com')).toBe('salesforce.com');
    });

    it('should strip "auth." prefix', () => {
      const { service } = buildService();
      expect(service.normalizeDomain('auth.example.com')).toBe('example.com');
    });

    it('should strip "sso." prefix', () => {
      const { service } = buildService();
      expect(service.normalizeDomain('sso.corp.net')).toBe('corp.net');
    });

    it('should strip "accounts." prefix', () => {
      const { service } = buildService();
      expect(service.normalizeDomain('accounts.google.com')).toBe('google.com');
    });

    it('should strip "id." prefix', () => {
      const { service } = buildService();
      expect(service.normalizeDomain('id.atlassian.com')).toBe('atlassian.com');
    });

    it('should strip "signin." prefix', () => {
      const { service } = buildService();
      expect(service.normalizeDomain('signin.aws.amazon.com')).toBe('aws.amazon.com');
    });

    it('should not strip prefix if result has no dots', () => {
      const { service } = buildService();
      // "login.localhost" → would leave "localhost" with no dot → keep as-is
      expect(service.normalizeDomain('login.localhost')).toBe('login.localhost');
    });

    it('should handle bare domain without prefix', () => {
      const { service } = buildService();
      expect(service.normalizeDomain('example.com')).toBe('example.com');
    });

    it('should lowercase the domain', () => {
      const { service } = buildService();
      expect(service.normalizeDomain('Login.SalesForce.COM')).toBe('salesforce.com');
    });
  });

  // =========================================================================
  // Queue Processing: FIFO Ordering
  // =========================================================================

  describe('processQueue: FIFO ordering', () => {
    it('should process QUEUED entries in FIFO order (oldest first)', async () => {
      const { service, queueRepo } = buildService();
      const candidates = [
        { id: 'q-1', target_domain: 'salesforce.com', priority: 0, requested_at: new Date('2026-01-01T00:00:00Z') },
        { id: 'q-2', target_domain: 'salesforce.com', priority: 0, requested_at: new Date('2026-01-01T00:01:00Z') },
      ];

      const mockQb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(candidates),
      };
      queueRepo.createQueryBuilder.mockReturnValue(mockQb);

      // No running entries, domain running = 0
      queueRepo.count.mockResolvedValue(0);
      const rawQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      // Second call to createQueryBuilder is for domain running counts
      queueRepo.createQueryBuilder
        .mockReturnValueOnce(mockQb)
        .mockReturnValueOnce(rawQb);

      queueRepo.findOne.mockImplementation(({ where }: any) =>
        Promise.resolve({ ...candidates.find(c => c.id === where.id), state: 'RUNNING' }),
      );

      const dequeued = await service.processQueue();

      expect(dequeued).toBe(2);
      // q-1 should be updated first (FIFO)
      expect(queueRepo.update).toHaveBeenNthCalledWith(1, 'q-1', expect.objectContaining({
        state: 'RUNNING',
      }));
      expect(queueRepo.update).toHaveBeenNthCalledWith(2, 'q-2', expect.objectContaining({
        state: 'RUNNING',
      }));
    });

    it('should process higher priority first', async () => {
      const { service, queueRepo } = buildService();
      const candidates = [
        { id: 'q-high', target_domain: 'example.com', priority: 10, requested_at: new Date('2026-01-01T00:01:00Z') },
        { id: 'q-low', target_domain: 'other.com', priority: 0, requested_at: new Date('2026-01-01T00:00:00Z') },
      ];

      const mockQb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(candidates),
      };
      const rawQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      queueRepo.createQueryBuilder
        .mockReturnValueOnce(mockQb)
        .mockReturnValueOnce(rawQb);

      queueRepo.count.mockResolvedValue(0);
      queueRepo.findOne.mockResolvedValue({ id: 'q-high', state: 'RUNNING' });

      const dequeued = await service.processQueue();

      expect(dequeued).toBe(2);
      // High priority should be processed first
      expect(queueRepo.update).toHaveBeenNthCalledWith(1, 'q-high', expect.objectContaining({
        state: 'RUNNING',
      }));
    });

    it('should return 0 when queue is empty', async () => {
      const { service, queueRepo } = buildService();
      queueRepo.count.mockResolvedValue(0);

      const mockQb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      const rawQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      queueRepo.createQueryBuilder
        .mockReturnValueOnce(mockQb)
        .mockReturnValueOnce(rawQb);

      const dequeued = await service.processQueue();

      expect(dequeued).toBe(0);
    });
  });

  // =========================================================================
  // Queue Processing: Global Concurrent Limit (LIMIT 1)
  // =========================================================================

  describe('processQueue: LIMIT 1 — global concurrency', () => {
    it('should skip processing when global limit is reached', async () => {
      const { service, queueRepo } = buildService();
      // Already at global max (5)
      queueRepo.count.mockResolvedValue(DEFAULTS.GLOBAL_MAX_CONCURRENT_LOGINS);

      const dequeued = await service.processQueue();

      expect(dequeued).toBe(0);
    });

    it('should stop dequeuing when global limit is reached mid-processing', async () => {
      const { service, queueRepo } = buildService();
      // Currently 4 running (one away from limit of 5)
      queueRepo.count.mockResolvedValue(4);

      const candidates = [
        { id: 'q-1', target_domain: 'a.com', priority: 0 },
        { id: 'q-2', target_domain: 'b.com', priority: 0 },
        { id: 'q-3', target_domain: 'c.com', priority: 0 },
      ];

      const mockQb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(candidates),
      };
      const rawQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      queueRepo.createQueryBuilder
        .mockReturnValueOnce(mockQb)
        .mockReturnValueOnce(rawQb);

      queueRepo.findOne.mockResolvedValue({ id: 'q-1', state: 'RUNNING' });

      const dequeued = await service.processQueue();

      // Only 1 dequeued (4 running + 1 = 5 = limit)
      expect(dequeued).toBe(1);
      expect(queueRepo.update).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Queue Processing: Per-Domain Limit (LIMIT 2)
  // =========================================================================

  describe('processQueue: LIMIT 2 — per-domain concurrency', () => {
    it('should skip domain that has reached its concurrent limit', async () => {
      const { service, queueRepo } = buildService();
      queueRepo.count.mockResolvedValue(0); // Global: plenty of room

      const candidates = [
        { id: 'q-1', target_domain: 'salesforce.com', priority: 0 },
        { id: 'q-2', target_domain: 'example.com', priority: 0 },
      ];

      const mockQb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(candidates),
      };
      // Domain running: salesforce.com already at limit 3
      const rawQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { target_domain: 'salesforce.com', count: '3' }, // At limit
        ]),
      };
      queueRepo.createQueryBuilder
        .mockReturnValueOnce(mockQb)
        .mockReturnValueOnce(rawQb);

      queueRepo.findOne.mockResolvedValue({ id: 'q-2', state: 'RUNNING' });

      const dequeued = await service.processQueue();

      // Only q-2 (example.com) should be dequeued, q-1 (salesforce.com) skipped
      expect(dequeued).toBe(1);
      expect(queueRepo.update).toHaveBeenCalledWith('q-2', expect.objectContaining({
        state: 'RUNNING',
      }));
    });

    it('should allow parallel processing across different domains', async () => {
      const { service, queueRepo } = buildService();
      queueRepo.count.mockResolvedValue(0);

      const candidates = [
        { id: 'q-1', target_domain: 'salesforce.com', priority: 0 },
        { id: 'q-2', target_domain: 'servicenow.com', priority: 0 },
        { id: 'q-3', target_domain: 'sap.com', priority: 0 },
      ];

      const mockQb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(candidates),
      };
      const rawQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]), // No running entries
      };
      queueRepo.createQueryBuilder
        .mockReturnValueOnce(mockQb)
        .mockReturnValueOnce(rawQb);

      queueRepo.findOne.mockResolvedValue({ state: 'RUNNING' });

      const dequeued = await service.processQueue();

      // All 3 domains can run in parallel
      expect(dequeued).toBe(3);
    });

    it('should respect per-domain limit of 3 (RT-06 amendment)', async () => {
      const { service, queueRepo } = buildService();
      queueRepo.count.mockResolvedValue(0);

      // 4 entries for same domain, but limit is 3
      const candidates = [
        { id: 'q-1', target_domain: 'salesforce.com', priority: 0 },
        { id: 'q-2', target_domain: 'salesforce.com', priority: 0 },
        { id: 'q-3', target_domain: 'salesforce.com', priority: 0 },
        { id: 'q-4', target_domain: 'salesforce.com', priority: 0 },
      ];

      const mockQb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(candidates),
      };
      const rawQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      queueRepo.createQueryBuilder
        .mockReturnValueOnce(mockQb)
        .mockReturnValueOnce(rawQb);

      queueRepo.findOne.mockResolvedValue({ state: 'RUNNING' });

      const dequeued = await service.processQueue();

      // Only 3 dequeued (per-domain limit)
      expect(dequeued).toBe(3);
      expect(queueRepo.update).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // Startup Stagger
  // =========================================================================

  describe('Startup stagger', () => {
    it('should not process queue before startup stagger completes', async () => {
      const { service, queueRepo } = buildService();
      (service as any).started = false; // Simulate pre-stagger

      const dequeued = await service.processQueue();

      expect(dequeued).toBe(0);
      expect(queueRepo.count).not.toHaveBeenCalled();
    });

    it('should process queue after startup stagger completes', async () => {
      const { service, queueRepo } = buildService();
      // started = true by default in buildService()

      const mockQb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      const rawQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      queueRepo.createQueryBuilder
        .mockReturnValueOnce(mockQb)
        .mockReturnValueOnce(rawQb);

      queueRepo.count.mockResolvedValue(0);

      const dequeued = await service.processQueue();

      expect(dequeued).toBe(0);
      // Should have checked count (processing happened)
      expect(queueRepo.count).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Complete & Fail
  // =========================================================================

  describe('complete / fail', () => {
    it('should mark entry as DONE with completed_at timestamp', async () => {
      const { service, queueRepo } = buildService();

      await service.complete('q-1');

      expect(queueRepo.update).toHaveBeenCalledWith('q-1', expect.objectContaining({
        state: 'DONE',
        completed_at: expect.any(Date),
      }));
    });

    it('should mark entry as FAILED with reason', async () => {
      const { service, queueRepo } = buildService();

      await service.fail('q-1', 'Login timeout');

      expect(queueRepo.update).toHaveBeenCalledWith('q-1', expect.objectContaining({
        state: 'FAILED',
        completed_at: expect.any(Date),
        failure_reason: 'Login timeout',
      }));
    });
  });

  // =========================================================================
  // Stale Sweep
  // =========================================================================

  describe('sweepStaleEntries', () => {
    it('should expire RUNNING entries older than threshold', async () => {
      const { service, queueRepo } = buildService();
      const staleEntry = {
        id: 'q-stale',
        target_domain: 'salesforce.com',
        state: 'RUNNING',
        started_at: new Date(Date.now() - 700_000), // 11+ minutes ago
      };

      const mockQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([staleEntry]),
      };
      queueRepo.createQueryBuilder.mockReturnValue(mockQb);

      const count = await service.sweepStaleEntries(600_000);

      expect(count).toBe(1);
      expect(queueRepo.update).toHaveBeenCalledWith('q-stale', expect.objectContaining({
        state: 'FAILED',
        completed_at: expect.any(Date),
        failure_reason: expect.stringContaining('Stale'),
      }));
    });

    it('should return 0 when no stale entries', async () => {
      const { service, queueRepo } = buildService();
      const mockQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      queueRepo.createQueryBuilder.mockReturnValue(mockQb);

      const count = await service.sweepStaleEntries();

      expect(count).toBe(0);
    });
  });

  // =========================================================================
  // Queue Metrics
  // =========================================================================

  describe('Queue metrics', () => {
    it('should report queue depth', async () => {
      const { service, queueRepo } = buildService();
      queueRepo.count.mockResolvedValue(7);

      const depth = await service.getQueueDepth();

      expect(depth).toBe(7);
      expect(queueRepo.count).toHaveBeenCalledWith({ where: { state: 'QUEUED' } });
    });

    it('should report running count', async () => {
      const { service, queueRepo } = buildService();
      queueRepo.count.mockResolvedValue(3);

      const running = await service.getRunningCount();

      expect(running).toBe(3);
      expect(queueRepo.count).toHaveBeenCalledWith({ where: { state: 'RUNNING' } });
    });

    it('should report running count by domain', async () => {
      const { service, queueRepo } = buildService();
      queueRepo.count.mockResolvedValue(2);

      const running = await service.getRunningCountByDomain('https://login.salesforce.com');

      expect(running).toBe(2);
      expect(queueRepo.count).toHaveBeenCalledWith({
        where: { state: 'RUNNING', target_domain: 'salesforce.com' },
      });
    });
  });

  // =========================================================================
  // Login Trigger Callback
  // =========================================================================

  describe('Login trigger callback', () => {
    it('should invoke registered callback when entry is dequeued', async () => {
      const { service, queueRepo } = buildService();
      const trigger = jest.fn().mockResolvedValue(undefined);
      service.registerLoginTrigger(trigger);

      queueRepo.count.mockResolvedValue(0);

      const candidates = [
        { id: 'q-1', target_domain: 'example.com', priority: 0 },
      ];
      const mockQb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(candidates),
      };
      const rawQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      queueRepo.createQueryBuilder
        .mockReturnValueOnce(mockQb)
        .mockReturnValueOnce(rawQb);

      queueRepo.findOne.mockResolvedValue({ id: 'q-1', state: 'RUNNING', target_domain: 'example.com' });

      await service.processQueue();

      // Give the void promise a tick to resolve
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ id: 'q-1' }));
    });

    it('should mark entry as FAILED if trigger throws', async () => {
      const { service, queueRepo } = buildService();
      const trigger = jest.fn().mockRejectedValue(new Error('Worker unavailable'));
      service.registerLoginTrigger(trigger);

      queueRepo.count.mockResolvedValue(0);

      const candidates = [
        { id: 'q-1', target_domain: 'example.com', priority: 0 },
      ];
      const mockQb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(candidates),
      };
      const rawQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      queueRepo.createQueryBuilder
        .mockReturnValueOnce(mockQb)
        .mockReturnValueOnce(rawQb);

      queueRepo.findOne.mockResolvedValue({ id: 'q-1', state: 'RUNNING', target_domain: 'example.com' });

      await service.processQueue();

      // Give the void promise a tick to resolve
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(queueRepo.update).toHaveBeenCalledWith('q-1', expect.objectContaining({
        state: 'FAILED',
        failure_reason: 'Worker unavailable',
      }));
    });
  });

  // =========================================================================
  // Concurrency Guard (processQueue reentrancy)
  // =========================================================================

  describe('Concurrency guard', () => {
    it('should prevent concurrent processQueue calls', async () => {
      const { service, queueRepo } = buildService();
      (service as any).processing = true;

      const dequeued = await service.processQueue();

      expect(dequeued).toBe(0);
      expect(queueRepo.count).not.toHaveBeenCalled();
    });
  });
});
