import { ReconcileService } from './reconcile.service';

function buildService(overrides: Record<string, any> = {}) {
  const appRepo = overrides.appRepo ?? { find: jest.fn(), update: jest.fn(), findByIds: jest.fn().mockResolvedValue([]) };
  const sessionRepo = overrides.sessionRepo ?? { count: jest.fn(), find: jest.fn(), update: jest.fn() };
  const batonRepo = overrides.batonRepo ?? {};
  const circuitRepo = overrides.circuitRepo ?? {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue({}),
  };
  const dataSource = overrides.dataSource ?? {
    transaction: jest.fn().mockResolvedValue([]),
    query: jest.fn().mockResolvedValue([]),
  };
  const stateMachine = overrides.stateMachine ?? {
    evaluateSession: jest.fn().mockResolvedValue(undefined),
    transition: jest.fn().mockResolvedValue(true),
  };
  const podManager = overrides.podManager ?? {
    deleteWorkerPod: jest.fn().mockResolvedValue(undefined),
    deleteNoVncService: jest.fn().mockResolvedValue(undefined),
    deleteCdpService: jest.fn().mockResolvedValue(undefined),
    deleteWorkerService: jest.fn().mockResolvedValue(undefined),
    deleteNetworkPolicy: jest.fn().mockResolvedValue(undefined),
    syncEgressAllowlist: jest.fn().mockResolvedValue(undefined),
    listWorkerPods: jest.fn().mockResolvedValue([]),
    podExists: jest.fn().mockResolvedValue(true),
  };

  const templateRepo = { findByIds: jest.fn().mockResolvedValue([]) };

  return new ReconcileService(
    appRepo as any,
    sessionRepo as any,
    batonRepo as any,
    circuitRepo as any,
    templateRepo as any,
    dataSource as any,
    stateMachine as any,
    podManager as any,
  );
}

// ---------------------------------------------------------------------------
// Circuit breaker — now uses DB table (circuitRepo) instead of in-memory Maps
// ---------------------------------------------------------------------------

describe('ReconcileService circuit breaker', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CIRCUIT_BREAKER_APP_FAILURE_THRESHOLD: '2',
      CIRCUIT_BREAKER_TENANT_FAILURE_THRESHOLD: '4',
      CIRCUIT_BREAKER_WINDOW_SECONDS: '900',
      CIRCUIT_BREAKER_COOLDOWN_SECONDS: '300',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('opens app circuit when app failure threshold is reached', async () => {
    const sessionRepo = {
      count: jest.fn()
        .mockResolvedValueOnce(2) // app failures
        .mockResolvedValueOnce(1), // tenant failures
      find: jest.fn(),
      update: jest.fn(),
    };
    // No existing circuit breaker paused
    const circuitRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue({}),
    };
    const dataSource = {
      query: jest.fn().mockResolvedValue([]),
    };
    const service = buildService({ sessionRepo, circuitRepo, dataSource });

    const isOpen = await (service as any).isProvisioningCircuitOpen({
      id: 'app-1',
      tenant_id: 'tenant-1',
    });

    expect(isOpen).toBe(true);
    expect(sessionRepo.count).toHaveBeenCalledTimes(2);
    // Should have upserted the circuit breaker record
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO circuit_breaker_state'),
      expect.arrayContaining(['app', 'app-1']),
    );
  });

  it('opens tenant circuit when tenant failure threshold is reached', async () => {
    const sessionRepo = {
      count: jest.fn()
        .mockResolvedValueOnce(1) // app failures (below threshold of 2)
        .mockResolvedValueOnce(4), // tenant failures (meets threshold of 4)
      find: jest.fn(),
      update: jest.fn(),
    };
    const circuitRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue({}),
    };
    const dataSource = {
      query: jest.fn().mockResolvedValue([]),
    };
    const service = buildService({ sessionRepo, circuitRepo, dataSource });

    const isOpen = await (service as any).isProvisioningCircuitOpen({
      id: 'app-2',
      tenant_id: 'tenant-2',
    });

    expect(isOpen).toBe(true);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO circuit_breaker_state'),
      expect.arrayContaining(['tenant', 'tenant-2']),
    );
  });

  it('keeps circuit closed below thresholds', async () => {
    const sessionRepo = {
      count: jest.fn()
        .mockResolvedValueOnce(1) // app failures
        .mockResolvedValueOnce(2), // tenant failures
      find: jest.fn(),
      update: jest.fn(),
    };
    const circuitRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    const dataSource = { query: jest.fn().mockResolvedValue([]) };
    const service = buildService({ sessionRepo, circuitRepo, dataSource });

    const isOpen = await (service as any).isProvisioningCircuitOpen({
      id: 'app-3',
      tenant_id: 'tenant-3',
    });

    expect(isOpen).toBe(false);
  });

  it('short-circuits while a DB circuit breaker is active', async () => {
    const sessionRepo = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn(),
      update: jest.fn(),
    };
    const futureDate = new Date(Date.now() + 60_000);
    const circuitRepo = {
      findOne: jest.fn().mockResolvedValue({ pause_until: futureDate, failure_count: 5 }),
    };
    const service = buildService({ sessionRepo, circuitRepo });

    const isOpen = await (service as any).isProvisioningCircuitOpen({
      id: 'app-4',
      tenant_id: 'tenant-4',
    });

    expect(isOpen).toBe(true);
    // No DB failure count queries needed — already paused
    expect(sessionRepo.count).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// doReconcile — restart_requested flag
// Now uses dataSource.transaction; we stub it to avoid needing a real DB.
// ---------------------------------------------------------------------------

describe('ReconcileService restart_requested', () => {
  function makeSessionForRestart(overrides: Record<string, any> = {}) {
    return {
      id: 'sess-restart-1',
      tenant_id: 'tenant-1',
      app_id: 'app-1',
      pod_name: 'pod-r1',
      state: 'HEALTHY',
      state_version: 1,
      retry_count: 0,
      restart_requested: true,
      owner_user_id: null,
      last_credential_request_at: null,
      started_at: new Date(),
      ...overrides,
    };
  }

  it('terminates the session and clears the flag when restart_requested is true', async () => {
    const session = makeSessionForRestart({ restart_requested: true });

    const sessionRepo = {
      find: jest.fn().mockResolvedValue([session]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const appRepo = { find: jest.fn().mockResolvedValue([]), update: jest.fn(), findByIds: jest.fn().mockResolvedValue([]) };
    const stateMachine = {
      evaluateSession: jest.fn().mockResolvedValue(undefined),
      transition: jest.fn().mockResolvedValue(true),
    };
    const podManager = {
      deleteWorkerPod: jest.fn().mockResolvedValue(undefined),
      deleteNoVncService: jest.fn().mockResolvedValue(undefined),
      deleteCdpService: jest.fn().mockResolvedValue(undefined),
      deleteWorkerService: jest.fn().mockResolvedValue(undefined),
      deleteNetworkPolicy: jest.fn().mockResolvedValue(undefined),
      syncEgressAllowlist: jest.fn().mockResolvedValue(undefined),
      listWorkerPods: jest.fn().mockResolvedValue([]),
      podExists: jest.fn().mockResolvedValue(true),
    };

    // Stub dataSource.transaction to execute the callback with a manager that
    // processes our session and calls the raw UPDATE
    const transactionManager = {
      query: jest.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('FOR UPDATE SKIP LOCKED') && sql.includes('sessions')) {
          // Return our session for the evaluation batch
          return [session];
        }
        if (sql.includes('FOR UPDATE SKIP LOCKED') && sql.includes('applications')) {
          return [];
        }
        // UPDATE last_evaluated_at
        return [];
      }),
    };

    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: any) => {
        return cb(transactionManager);
      }),
      query: jest.fn().mockResolvedValue([]),
    };

    const service = buildService({
      sessionRepo, appRepo, stateMachine, podManager, batonRepo: {}, dataSource,
    });

    await (service as any).doReconcile();

    // Restart_requested session should be terminated via stateMachine.transition
    expect(stateMachine.transition).toHaveBeenCalled();
    // evaluateSession should NOT be called for the restart session
    expect(stateMachine.evaluateSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkRecycling — idle shutdown + FAILED session cleanup
// ---------------------------------------------------------------------------

describe('ReconcileService checkRecycling', () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    process.env = originalEnv;
  });

  function makeSession(overrides: Record<string, any>) {
    return {
      id: 'sess-x',
      tenant_id: 'tenant-1',
      app_id: 'app-1',
      pod_name: 'pod-x',
      state: 'HEALTHY',
      state_version: 1,
      retry_count: 0,
      owner_user_id: null,
      last_credential_request_at: null,
      started_at: new Date(),
      ...overrides,
    };
  }

  function buildForRecycling() {
    const sessionRepo = {
      find: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    };
    const appRepo = { update: jest.fn(), find: jest.fn(), findByIds: jest.fn().mockResolvedValue([]) };
    const stateMachine = { transition: jest.fn().mockResolvedValue(true) };
    const podManager = {
      deleteWorkerPod: jest.fn().mockResolvedValue(undefined),
      deleteNoVncService: jest.fn().mockResolvedValue(undefined),
      deleteCdpService: jest.fn().mockResolvedValue(undefined),
      deleteWorkerService: jest.fn().mockResolvedValue(undefined),
      deleteNetworkPolicy: jest.fn().mockResolvedValue(undefined),
    };
    const service = buildService({
      sessionRepo, appRepo, stateMachine, podManager,
      batonRepo: {},
    });
    return { service, sessionRepo, appRepo, stateMachine, podManager };
  }

  it('terminates FAILED sessions older than half the idle TTL and zeroes desired_session_count', async () => {
    process.env = { ...originalEnv, IDLE_SHUTDOWN_SECONDS: '120', MAX_SESSION_AGE_HOURS: '24' };
    const { service, sessionRepo, appRepo, stateMachine } = buildForRecycling();

    const failed = makeSession({
      id: 'failed-1',
      state: 'FAILED',
      started_at: new Date(Date.now() - 120_000),
    });
    sessionRepo.find
      .mockResolvedValueOnce([])       // HEALTHY
      .mockResolvedValueOnce([failed]); // FAILED

    await (service as any).checkRecycling();

    expect(appRepo.update).toHaveBeenCalledWith('app-1', { desired_session_count: 0 });
    expect(stateMachine.transition).toHaveBeenCalledWith(failed, expect.anything());
  });

  it('leaves FAILED sessions younger than half TTL alone', async () => {
    process.env = { ...originalEnv, IDLE_SHUTDOWN_SECONDS: '600', MAX_SESSION_AGE_HOURS: '24' };
    const { service, sessionRepo, appRepo, stateMachine } = buildForRecycling();

    const failed = makeSession({
      id: 'failed-young',
      state: 'FAILED',
      started_at: new Date(Date.now() - 10_000), // 10s < 300s (half of 600s)
    });
    sessionRepo.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([failed]);

    await (service as any).checkRecycling();

    expect(appRepo.update).not.toHaveBeenCalled();
    expect(stateMachine.transition).not.toHaveBeenCalled();
  });

  it('skips FAILED cleanup entirely when IDLE_SHUTDOWN_SECONDS is 0 (disabled)', async () => {
    process.env = { ...originalEnv, IDLE_SHUTDOWN_SECONDS: '0', MAX_SESSION_AGE_HOURS: '24' };
    const { service, sessionRepo, appRepo } = buildForRecycling();

    sessionRepo.find.mockResolvedValueOnce([]); // HEALTHY only — no second FAILED query

    await (service as any).checkRecycling();

    expect(sessionRepo.find).toHaveBeenCalledTimes(1); // FAILED branch not taken
    expect(appRepo.update).not.toHaveBeenCalled();
  });

  it('terminates idle per-user sessions (owner_user_id + last_credential_request_at exceeds threshold)', async () => {
    process.env = { ...originalEnv, IDLE_SHUTDOWN_SECONDS: '60', MAX_SESSION_AGE_HOURS: '24' };
    const { service, sessionRepo, appRepo, stateMachine } = buildForRecycling();

    const healthy = makeSession({
      id: 'healthy-idle',
      state: 'HEALTHY',
      owner_user_id: 'user-a',
      last_credential_request_at: new Date(Date.now() - 120_000), // 2 min idle > 60s threshold
      started_at: new Date(Date.now() - 120_000),
    });
    sessionRepo.find
      .mockResolvedValueOnce([healthy])
      .mockResolvedValueOnce([]); // no FAILED

    await (service as any).checkRecycling();

    expect(appRepo.update).toHaveBeenCalledWith('app-1', { desired_session_count: 0 });
    expect(stateMachine.transition).toHaveBeenCalledWith(healthy, expect.anything());
  });

  it('spares a session with recent last_activity_at even when started_at is old (activity-driven)', async () => {
    // A recording session actively viewed via the panel-state heartbeat, or a
    // warm-claimed session, has a fresh last_activity_at even though started_at
    // (the pool spare's warm time) is old. The reaper must judge by activity, not
    // age — otherwise it would kill sessions that are actively in use.
    process.env = { ...originalEnv, IDLE_SHUTDOWN_SECONDS: '60', MAX_SESSION_AGE_HOURS: '24' };
    const { service, sessionRepo, appRepo, stateMachine } = buildForRecycling();

    const healthy = makeSession({
      id: 'recently-active',
      state: 'HEALTHY',
      owner_user_id: 'user-a',
      started_at: new Date(Date.now() - 3_600_000), // 1h old (e.g. long-warmed spare)
      last_activity_at: new Date(Date.now() - 5_000), // but active 5s ago (< 60s threshold)
    });
    sessionRepo.find
      .mockResolvedValueOnce([healthy])
      .mockResolvedValueOnce([]); // no FAILED

    await (service as any).checkRecycling();

    expect(appRepo.update).not.toHaveBeenCalled();
    expect(stateMachine.transition).not.toHaveBeenCalled();
  });
});
