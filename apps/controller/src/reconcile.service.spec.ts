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
// DISABLE_NETWORK_POLICY — skips K8s NetworkPolicy, pushes allow_all
// ---------------------------------------------------------------------------

describe('ReconcileService DISABLE_NETWORK_POLICY', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = originalEnv;
  });

  function makeApp() {
    return {
      id: 'app-np',
      tenant_id: 'tenant-np',
      target_urls: ['https://example.com'],
      extra_egress_allowlist: [],
      execute_enabled: false,
      residential_proxy_enabled: false,
      browser_policy: {},
      export_policy: {},
    };
  }

  function makeSession() {
    return {
      id: 'sess-np',
      tenant_id: 'tenant-np',
      app_id: 'app-np',
      pod_name: null,
      state: 'STARTING',
      state_version: 1,
      retry_count: 0,
      owner_user_id: null,
      // resolveResidential reads session.residential_proxy_enabled ?? app.residential_proxy_enabled;
      // null here documents the real field and makes the expected `false` come from the app default.
      residential_proxy_enabled: null,
    };
  }

  it('skips createNetworkPolicy and calls syncEgressAllowlist with allowAll=true when enabled', async () => {
    process.env = { ...originalEnv, DISABLE_NETWORK_POLICY: 'true' };

    const podManager = {
      createWorkerPod: jest.fn().mockResolvedValue('pod-np-1'),
      createNoVncService: jest.fn().mockResolvedValue(undefined),
      createCdpService: jest.fn().mockResolvedValue(undefined),
      createWorkerService: jest.fn().mockResolvedValue(undefined),
      createNetworkPolicy: jest.fn().mockResolvedValue(undefined),
      syncEgressAllowlist: jest.fn().mockResolvedValue(undefined),
      deleteWorkerPod: jest.fn().mockResolvedValue(undefined),
      deleteNoVncService: jest.fn().mockResolvedValue(undefined),
      deleteCdpService: jest.fn().mockResolvedValue(undefined),
      deleteWorkerService: jest.fn().mockResolvedValue(undefined),
      deleteNetworkPolicy: jest.fn().mockResolvedValue(undefined),
      listWorkerPods: jest.fn().mockResolvedValue([]),
      podExists: jest.fn().mockResolvedValue(true),
      resolveStreamingMode: jest.fn().mockReturnValue('vnc'),
    };
    const sessionRepo = {
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const service = buildService({ podManager, sessionRepo });

    await (service as any).provisionSessionRuntime(makeSession(), makeApp());

    expect(podManager.createNetworkPolicy).not.toHaveBeenCalled();
    expect(podManager.syncEgressAllowlist).toHaveBeenCalledWith(
      'sess-np',
      ['https://example.com'],
      [],
      true,
      false,
    );
  });

  it('creates NetworkPolicy normally when DISABLE_NETWORK_POLICY is not set', async () => {
    delete process.env.DISABLE_NETWORK_POLICY;

    const podManager = {
      createWorkerPod: jest.fn().mockResolvedValue('pod-np-2'),
      createNoVncService: jest.fn().mockResolvedValue(undefined),
      createCdpService: jest.fn().mockResolvedValue(undefined),
      createWorkerService: jest.fn().mockResolvedValue(undefined),
      createNetworkPolicy: jest.fn().mockResolvedValue(undefined),
      syncEgressAllowlist: jest.fn().mockResolvedValue(undefined),
      deleteWorkerPod: jest.fn().mockResolvedValue(undefined),
      deleteNoVncService: jest.fn().mockResolvedValue(undefined),
      deleteCdpService: jest.fn().mockResolvedValue(undefined),
      deleteWorkerService: jest.fn().mockResolvedValue(undefined),
      deleteNetworkPolicy: jest.fn().mockResolvedValue(undefined),
      listWorkerPods: jest.fn().mockResolvedValue([]),
      podExists: jest.fn().mockResolvedValue(true),
      resolveStreamingMode: jest.fn().mockReturnValue('vnc'),
    };
    const sessionRepo = {
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const service = buildService({ podManager, sessionRepo });

    await (service as any).provisionSessionRuntime(makeSession(), makeApp());

    expect(podManager.createNetworkPolicy).toHaveBeenCalled();
    expect(podManager.syncEgressAllowlist).not.toHaveBeenCalled();
  });

  it('forces allowAll=true on the reconcile-path allowlist sync for already-active sessions', async () => {
    // Covers the second half of the flag: reconcileApp() re-syncs the egress
    // allowlist for existing sessions every tick (reconcile.service.ts:229),
    // using effectiveAllowAll = disableNetworkPolicy || allowAll. This is the
    // continuously-running path, distinct from one-shot provisionSessionRuntime.
    process.env = { ...originalEnv, DISABLE_NETWORK_POLICY: 'true' };

    const activeSession = { ...makeSession(), state: 'HEALTHY', pod_name: 'pod-np-live' };
    const sessionRepo = {
      find: jest.fn().mockResolvedValue([activeSession]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const podManager = {
      syncEgressAllowlist: jest.fn().mockResolvedValue(undefined),
      resolveStreamingMode: jest.fn().mockReturnValue('vnc'),
    };
    // desired == actual (1), so reconcileApp only runs the allowlist-sync loop.
    const app = { ...makeApp(), desired_session_count: 1 };
    const service = buildService({ podManager, sessionRepo });

    await (service as any).reconcileApp(app);

    expect(podManager.syncEgressAllowlist).toHaveBeenCalledWith(
      'sess-np',
      ['https://example.com'],
      [],
      true,      // effectiveAllowAll — forced on by the flag despite app allowAll=false
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// reconcileApp capacity — FAILED sessions must not occupy the app's slot
// ---------------------------------------------------------------------------

describe('ReconcileService reconcileApp capacity', () => {
  const originalEnv = { ...process.env };
  afterAll(() => {
    process.env = originalEnv;
  });

  function makeApp(overrides: Record<string, any> = {}) {
    return {
      id: 'app-1',
      tenant_id: 'tenant-1',
      name: 'some-app',
      target_urls: ['https://example.com'],
      desired_session_count: 1,
      browser_policy: {},
      extra_egress_allowlist: [],
      ...overrides,
    };
  }

  it('creates a replacement when the only session is FAILED (FAILED is not live capacity)', async () => {
    // The core of the incident: desired=1 with a single FAILED session. The old
    // code counted FAILED as occupying the slot (actual=1==desired) and never
    // provisioned a replacement, so on-demand provisioning silently no-op'd for
    // the whole cleanup window. FAILED must not count → a fresh session is made.
    const failed = {
      id: 'failed-1', app_id: 'app-1', tenant_id: 'tenant-1',
      state: 'FAILED', pod_name: null, started_at: new Date(),
    };
    const sessionRepo = {
      find: jest.fn().mockResolvedValue([failed]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
    };
    const service = buildService({ sessionRepo });
    jest.spyOn(service as any, 'isProvisioningCircuitOpen').mockResolvedValue(false);
    const createSpy = jest
      .spyOn(service as any, 'createSession')
      .mockResolvedValue(undefined);

    await (service as any).reconcileApp(makeApp());

    expect(createSpy).toHaveBeenCalledTimes(1); // one replacement for the dead slot
  });

  it('does NOT create when the circuit breaker is open, even with only a FAILED session', async () => {
    // Fix A relies on the breaker to bound retries when replacements keep failing.
    const failed = {
      id: 'failed-1', app_id: 'app-1', tenant_id: 'tenant-1',
      state: 'FAILED', pod_name: null, started_at: new Date(),
    };
    const sessionRepo = {
      find: jest.fn().mockResolvedValue([failed]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
    };
    const service = buildService({ sessionRepo });
    jest.spyOn(service as any, 'isProvisioningCircuitOpen').mockResolvedValue(true);
    const createSpy = jest
      .spyOn(service as any, 'createSession')
      .mockResolvedValue(undefined);

    await (service as any).reconcileApp(makeApp());

    expect(createSpy).not.toHaveBeenCalled();
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
      count: jest.fn().mockResolvedValue(0), // default: no other live session for the app
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

  it('terminates FAILED sessions older than half the idle TTL and, when the app is idle, zeroes desired_session_count', async () => {
    process.env = { ...originalEnv, IDLE_SHUTDOWN_SECONDS: '120', MAX_SESSION_AGE_HOURS: '24' };
    const { service, sessionRepo, appRepo, stateMachine } = buildForRecycling();

    const failed = makeSession({
      id: 'failed-1',
      state: 'FAILED',
      started_at: new Date(Date.now() - 120_000), // last used 120s ago >= idle threshold → idle
    });
    sessionRepo.find
      .mockResolvedValueOnce([])       // HEALTHY
      .mockResolvedValueOnce([failed]); // FAILED
    sessionRepo.count.mockResolvedValue(0); // no other live session for the app

    await (service as any).checkRecycling();

    expect(appRepo.update).toHaveBeenCalledWith('app-1', { desired_session_count: 0 });
    expect(stateMachine.transition).toHaveBeenCalledWith(failed, expect.anything());
  });

  it('reaps a FAILED session WITHOUT zeroing desired when the app has recent demand', async () => {
    // The incident this fixes: a user is actively driving the app, its session
    // fails (e.g. bank session expired), and the old code zeroed desired on
    // cleanup — so the user's next call found no session and no way to make one.
    // With recent activity, cleanup must reap the corpse but leave desired so
    // reconcile provisions a fresh session for the waiting user.
    process.env = { ...originalEnv, IDLE_SHUTDOWN_SECONDS: '600', MAX_SESSION_AGE_HOURS: '24' };
    const { service, sessionRepo, appRepo, stateMachine } = buildForRecycling();

    const failed = makeSession({
      id: 'failed-active',
      state: 'FAILED',
      started_at: new Date(Date.now() - 400_000), // old enough to reap (> 300s half-TTL)
      last_activity_at: new Date(Date.now() - 5_000), // but used 5s ago → recent demand
    });
    sessionRepo.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([failed]);
    sessionRepo.count.mockResolvedValue(0);

    await (service as any).checkRecycling();

    expect(stateMachine.transition).toHaveBeenCalledWith(failed, expect.anything()); // corpse reaped
    expect(appRepo.update).not.toHaveBeenCalled(); // but desired preserved
  });

  it('reaps a FAILED session WITHOUT zeroing desired when the app still has a live session', async () => {
    // A replacement session already came up (reconcile created it because FAILED
    // no longer counts as capacity). Reaping the old corpse must not scale the
    // app to 0 — that would kill the live replacement.
    process.env = { ...originalEnv, IDLE_SHUTDOWN_SECONDS: '120', MAX_SESSION_AGE_HOURS: '24' };
    const { service, sessionRepo, appRepo, stateMachine } = buildForRecycling();

    const failed = makeSession({
      id: 'failed-with-replacement',
      state: 'FAILED',
      started_at: new Date(Date.now() - 120_000), // idle by activity, but…
    });
    sessionRepo.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([failed]);
    sessionRepo.count.mockResolvedValue(1); // …a live replacement exists

    await (service as any).checkRecycling();

    expect(stateMachine.transition).toHaveBeenCalledWith(failed, expect.anything());
    expect(appRepo.update).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// FAILED sessions must give their pod back immediately
// ---------------------------------------------------------------------------

describe('ReconcileService FAILED session runtime reap', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function makeFailedApp() {
    return {
      id: 'app-f',
      tenant_id: 'tenant-f',
      desired_session_count: 1,
      target_urls: ['https://example.com'],
      extra_egress_allowlist: [],
      execute_enabled: false,
      residential_proxy_enabled: false,
      browser_policy: {},
      export_policy: {},
    };
  }

  function podManagerMock() {
    return {
      createWorkerPod: jest.fn().mockResolvedValue('pod-new'),
      createNoVncService: jest.fn().mockResolvedValue(undefined),
      createCdpService: jest.fn().mockResolvedValue(undefined),
      createWorkerService: jest.fn().mockResolvedValue(undefined),
      createNetworkPolicy: jest.fn().mockResolvedValue(undefined),
      syncEgressAllowlist: jest.fn().mockResolvedValue(undefined),
      deleteWorkerPod: jest.fn().mockResolvedValue(undefined),
      deleteNoVncService: jest.fn().mockResolvedValue(undefined),
      deleteCdpService: jest.fn().mockResolvedValue(undefined),
      deleteWorkerService: jest.fn().mockResolvedValue(undefined),
      deleteNetworkPolicy: jest.fn().mockResolvedValue(undefined),
      listWorkerPods: jest.fn().mockResolvedValue([]),
      podExists: jest.fn().mockResolvedValue(true),
      resolveStreamingMode: jest.fn().mockReturnValue('vnc'),
    };
  }

  it('deletes the pod of a FAILED session with IDLE_SHUTDOWN disabled (the default)', async () => {
    // The FAILED-cleanup pass is gated on IDLE_SHUTDOWN_SECONDS, which defaults
    // to 0 — so without this reap the pod outlives the session forever while
    // reconcile creates replacements on top of it (one leaked pod per failure).
    process.env = { ...originalEnv, IDLE_SHUTDOWN_SECONDS: '0' };

    const failed = {
      id: 'sess-failed',
      tenant_id: 'tenant-f',
      app_id: 'app-f',
      state: 'FAILED',
      pod_name: 'worker-sess-failed',
      started_at: new Date(),
    };
    const sessionRepo = {
      find: jest.fn().mockResolvedValue([failed]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation((v: any) => v),
      save: jest.fn().mockImplementation(async (v: any) => ({ id: 'sess-new', ...v })),
    };
    const podManager = podManagerMock();
    const batonRepo = {
      create: jest.fn().mockImplementation((v: any) => v),
      save: jest.fn().mockResolvedValue({}),
    };
    const service = buildService({ sessionRepo, podManager, batonRepo });

    await (service as any).reconcileApp(makeFailedApp());

    expect(podManager.deleteWorkerPod).toHaveBeenCalledWith('worker-sess-failed');
    expect(podManager.deleteNetworkPolicy).toHaveBeenCalledWith('sess-failed');
    // pod_name cleared so the reap is idempotent across ticks
    expect(sessionRepo.update).toHaveBeenCalledWith('sess-failed', { pod_name: null });
  });

  it('still provisions a replacement — the FAILED session must not hold capacity', async () => {
    process.env = { ...originalEnv, IDLE_SHUTDOWN_SECONDS: '0' };

    const failed = {
      id: 'sess-failed-2',
      tenant_id: 'tenant-f',
      app_id: 'app-f',
      state: 'FAILED',
      pod_name: 'worker-sess-failed-2',
      started_at: new Date(),
    };
    const sessionRepo = {
      find: jest.fn().mockResolvedValue([failed]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation((v: any) => v),
      save: jest.fn().mockImplementation(async (v: any) => ({ id: 'sess-new', ...v })),
    };
    const podManager = podManagerMock();
    const batonRepo = {
      create: jest.fn().mockImplementation((v: any) => v),
      save: jest.fn().mockResolvedValue({}),
    };
    const service = buildService({ sessionRepo, podManager, batonRepo });

    await (service as any).reconcileApp(makeFailedApp());

    expect(podManager.deleteWorkerPod).toHaveBeenCalledWith('worker-sess-failed-2');
    expect(sessionRepo.save).toHaveBeenCalled(); // a fresh session was created
  });

  it('does not touch a FAILED session whose runtime was already released', async () => {
    process.env = { ...originalEnv, IDLE_SHUTDOWN_SECONDS: '0' };

    const failed = {
      id: 'sess-failed-3',
      tenant_id: 'tenant-f',
      app_id: 'app-f',
      state: 'FAILED',
      pod_name: null, // already reaped on an earlier tick
      started_at: new Date(),
    };
    const sessionRepo = {
      find: jest.fn().mockResolvedValue([failed]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation((v: any) => v),
      save: jest.fn().mockImplementation(async (v: any) => ({ id: 'sess-new', ...v })),
    };
    const podManager = podManagerMock();
    const batonRepo = {
      create: jest.fn().mockImplementation((v: any) => v),
      save: jest.fn().mockResolvedValue({}),
    };
    const service = buildService({ sessionRepo, podManager, batonRepo });

    await (service as any).reconcileApp(makeFailedApp());

    expect(podManager.deleteWorkerPod).not.toHaveBeenCalled();
    expect(sessionRepo.update).not.toHaveBeenCalledWith('sess-failed-3', { pod_name: null });
  });
});
