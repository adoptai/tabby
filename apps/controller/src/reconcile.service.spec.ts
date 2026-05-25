import { ReconcileService } from './reconcile.service';

function buildService(overrides: Record<string, any> = {}) {
  const appRepo = overrides.appRepo ?? { find: jest.fn() };
  const sessionRepo = overrides.sessionRepo ?? { count: jest.fn(), find: jest.fn(), update: jest.fn() };
  const batonRepo = overrides.batonRepo ?? {};
  const stateMachine = overrides.stateMachine ?? {};
  const podManager = overrides.podManager ?? {};

  return new ReconcileService(
    appRepo as any,
    sessionRepo as any,
    batonRepo as any,
    stateMachine as any,
    podManager as any,
  );
}

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
    const service = buildService({ sessionRepo });

    const isOpen = await (service as any).isProvisioningCircuitOpen({
      id: 'app-1',
      tenant_id: 'tenant-1',
    });

    expect(isOpen).toBe(true);
    expect(sessionRepo.count).toHaveBeenCalledTimes(2);
    expect((service as any).appCircuitPauseUntil.has('app-1')).toBe(true);
  });

  it('opens tenant circuit when tenant failure threshold is reached', async () => {
    const sessionRepo = {
      count: jest.fn()
        .mockResolvedValueOnce(1) // app failures
        .mockResolvedValueOnce(4), // tenant failures
      find: jest.fn(),
      update: jest.fn(),
    };
    const service = buildService({ sessionRepo });

    const isOpen = await (service as any).isProvisioningCircuitOpen({
      id: 'app-2',
      tenant_id: 'tenant-2',
    });

    expect(isOpen).toBe(true);
    expect((service as any).tenantCircuitPauseUntil.has('tenant-2')).toBe(true);
  });

  it('keeps circuit closed below thresholds', async () => {
    const sessionRepo = {
      count: jest.fn()
        .mockResolvedValueOnce(1) // app failures
        .mockResolvedValueOnce(2), // tenant failures
      find: jest.fn(),
      update: jest.fn(),
    };
    const service = buildService({ sessionRepo });

    const isOpen = await (service as any).isProvisioningCircuitOpen({
      id: 'app-3',
      tenant_id: 'tenant-3',
    });

    expect(isOpen).toBe(false);
  });

  it('short-circuits while cooldown window is active', async () => {
    const sessionRepo = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn(),
      update: jest.fn(),
    };
    const service = buildService({ sessionRepo });

    (service as any).appCircuitPauseUntil.set('app-4', Date.now() + 60_000);
    const isOpen = await (service as any).isProvisioningCircuitOpen({
      id: 'app-4',
      tenant_id: 'tenant-4',
    });

    expect(isOpen).toBe(true);
    expect(sessionRepo.count).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// doReconcile — restart_requested flag
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

  function buildForRestart() {
    const sessionRepo = {
      find: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const appRepo = { find: jest.fn().mockResolvedValue([]), update: jest.fn() };
    const stateMachine = {
      evaluateSession: jest.fn().mockResolvedValue(undefined),
      transition: jest.fn().mockResolvedValue(undefined),
    };
    const podManager = {
      deleteWorkerPod: jest.fn().mockResolvedValue(undefined),
      deleteNoVncService: jest.fn().mockResolvedValue(undefined),
      deleteCdpService: jest.fn().mockResolvedValue(undefined),
      deleteNetworkPolicy: jest.fn().mockResolvedValue(undefined),
      syncEgressAllowlist: jest.fn().mockResolvedValue(undefined),
      listWorkerPods: jest.fn().mockResolvedValue([]),
      podExists: jest.fn().mockResolvedValue(true),
    };
    const service = buildService({
      sessionRepo, appRepo, stateMachine, podManager,
      batonRepo: {},
    });
    return { service, sessionRepo, appRepo, stateMachine, podManager };
  }

  it('terminates the session and clears the flag when restart_requested is true', async () => {
    const { service, sessionRepo, stateMachine } = buildForRestart();
    const session = makeSessionForRestart({ restart_requested: true });

    // All find() calls return our session so doReconcile sees it in the active-session loop
    sessionRepo.find.mockResolvedValue([session]);

    await (service as any).doReconcile();

    expect(sessionRepo.update).toHaveBeenCalledWith('sess-restart-1', { restart_requested: false });
    expect(stateMachine.evaluateSession).not.toHaveBeenCalledWith(session, expect.anything());
  });

  it('does not terminate sessions where restart_requested is false', async () => {
    const { service, sessionRepo, stateMachine } = buildForRestart();
    const session = makeSessionForRestart({ restart_requested: false });

    sessionRepo.find.mockResolvedValue([session]);

    await (service as any).doReconcile();

    expect(sessionRepo.update).not.toHaveBeenCalledWith('sess-restart-1', { restart_requested: false });
    expect(stateMachine.evaluateSession).toHaveBeenCalledWith(session);
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
    const appRepo = { update: jest.fn(), find: jest.fn() };
    const stateMachine = { transition: jest.fn().mockResolvedValue(undefined) };
    const podManager = {
      deleteWorkerPod: jest.fn().mockResolvedValue(undefined),
      deleteNoVncService: jest.fn().mockResolvedValue(undefined),
      deleteCdpService: jest.fn().mockResolvedValue(undefined),
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

    // HEALTHY session loop: none
    // FAILED session loop: one session, 2 minutes old (= 120s, > 60s = half TTL)
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
});

