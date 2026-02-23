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

