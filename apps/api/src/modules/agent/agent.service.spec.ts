import { BadRequestException, ConflictException } from '@nestjs/common';
import { SessionState } from '@browser-hitl/shared';
import { AgentService } from './agent.service';

function createMockSessionRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
  };
}

function createMockInterventionRepo() {
  return {
    findOne: jest.fn(),
  };
}

function createMockAppsService() {
  return {
    create: jest.fn(),
  };
}

function createMockSessionsService() {
  return {
    scale: jest.fn(),
  };
}

function createMockHitlService() {
  return {
    generateStreamUrl: jest.fn(),
  };
}

function createMockCredentialsService() {
  return {
    resolveActiveProfile: jest.fn(),
  };
}

function buildService(overrides: Record<string, any> = {}) {
  const sessionRepo = overrides.sessionRepo ?? createMockSessionRepo();
  const interventionRepo = overrides.interventionRepo ?? createMockInterventionRepo();
  const appsService = overrides.appsService ?? createMockAppsService();
  const sessionsService = overrides.sessionsService ?? createMockSessionsService();
  const hitlService = overrides.hitlService ?? createMockHitlService();
  const credentialsService = overrides.credentialsService ?? createMockCredentialsService();

  const service = Object.create(AgentService.prototype);
  (service as any).sessionRepo = sessionRepo;
  (service as any).interventionRepo = interventionRepo;
  (service as any).appsService = appsService;
  (service as any).sessionsService = sessionsService;
  (service as any).hitlService = hitlService;
  (service as any).credentialsService = credentialsService;
  (service as any).sleep = jest.fn().mockResolvedValue(undefined);

  return {
    service: service as AgentService,
    sessionRepo,
    interventionRepo,
    appsService,
    sessionsService,
    hitlService,
    credentialsService,
  };
}

describe('AgentService', () => {
  beforeEach(() => {
    delete process.env.AGENT_DEFAULT_CREDENTIAL_REF;
    delete process.env.AGENT_DEFAULT_SLACK_CHANNEL;
    jest.clearAllMocks();
  });

  it('creates and scales app, then returns session workflow handles', async () => {
    process.env.AGENT_DEFAULT_CREDENTIAL_REF = 'k8s:secret/uat-credentials';
    process.env.AGENT_DEFAULT_SLACK_CHANNEL = '#ops';

    const sessionRepo = createMockSessionRepo();
    sessionRepo.find.mockResolvedValue([
      {
        id: 'session-1',
        state: SessionState.HEALTHY,
        started_at: new Date(),
      },
    ]);

    const appsService = createMockAppsService();
    appsService.create.mockResolvedValue({ app_id: 'app-1' });

    const sessionsService = createMockSessionsService();
    sessionsService.scale.mockResolvedValue({ desired_sessions: 1, app_id: 'app-1' });

    const hitlService = createMockHitlService();
    hitlService.generateStreamUrl.mockResolvedValue({
      url: 'https://stream.example',
      expires_at: '2026-02-19T00:00:00.000Z',
    });

    const { service } = buildService({
      sessionRepo,
      appsService,
      sessionsService,
      hitlService,
    });

    const result = await service.runUrl({
      url: 'https://example.com',
      include_stream_url: true,
    }, 'tenant-1', 'user-1');

    expect(appsService.create).toHaveBeenCalledTimes(1);
    expect(sessionsService.scale).toHaveBeenCalledWith('app-1', 1, 'tenant-1', 'user-1');
    expect(hitlService.generateStreamUrl).toHaveBeenCalledWith('session-1', 'tenant-1', 'user-1');
    expect(result).toEqual(expect.objectContaining({
      app_id: 'app-1',
      session_id: 'session-1',
      state: SessionState.HEALTHY,
      wait_for_state: SessionState.HEALTHY,
    }));
  });

  it('requires credential_ref when no default credential is configured', async () => {
    const { service } = buildService();
    await expect(service.runUrl(
      { url: 'https://example.com' },
      'tenant-1',
      'user-1',
    )).rejects.toThrow(BadRequestException);
  });

  it('replays run-url response when idempotency key is already completed', async () => {
    const { service, appsService, sessionsService } = buildService();

    (service as any).redis = {
      get: jest.fn().mockResolvedValue(JSON.stringify({
        status: 'complete',
        request_hash: '6b16cc6e5f8f91334b8f6eb7952f73f6f995f5f5abff4f8ffb6c4fc2f95fafe8',
        started_at: '2026-02-19T00:00:00.000Z',
        completed_at: '2026-02-19T00:00:10.000Z',
        response: {
          run_id: 'app-replayed',
          app_id: 'app-replayed',
          session_id: 'session-replayed',
          tenant_id: 'tenant-1',
          state: SessionState.HEALTHY,
          target_url: 'https://example.com',
          desired_sessions: 1,
          wait_for_state: SessionState.HEALTHY,
          endpoints: {},
          stream: null,
        },
      })),
      set: jest.fn(),
      del: jest.fn(),
    };
    (service as any).computeRequestHash = jest
      .fn()
      .mockReturnValue('6b16cc6e5f8f91334b8f6eb7952f73f6f995f5f5abff4f8ffb6c4fc2f95fafe8');

    const result = await service.runUrl(
      { url: 'https://example.com' },
      'tenant-1',
      'user-1',
      'replay-key-1',
    );

    expect(result).toEqual(expect.objectContaining({
      app_id: 'app-replayed',
      session_id: 'session-replayed',
      idempotency: {
        key: 'replay-key-1',
        replayed: true,
      },
    }));
    expect(appsService.create).not.toHaveBeenCalled();
    expect(sessionsService.scale).not.toHaveBeenCalled();
  });

  describe('getSessionStatus', () => {
    const mockSession = {
      id: 'session-1',
      state: SessionState.LOGIN_IN_PROGRESS,
      app_id: 'app-1',
      tenant_id: 'tenant-1',
      pending_input_request: null,
      health_result_type: 'AUTH_FAIL',
      intervention_count: 1,
      retry_count: 0,
      last_login_at: new Date('2026-04-01'),
      application: { name: 'Workday' },
    };

    it('returns input_request_metadata from latest intervention when HITL active', async () => {
      const credentialsService = createMockCredentialsService();
      credentialsService.resolveActiveProfile.mockResolvedValue({ app_id: 'app-1' });

      const sessionRepo = createMockSessionRepo();
      sessionRepo.findOne.mockResolvedValue(mockSession);

      const interventionRepo = createMockInterventionRepo();
      interventionRepo.findOne.mockResolvedValue({
        id: 'intervention-1',
        input_request_metadata: { input_type: 'confirm', step_index: 2, label: 'Log in via VNC' },
      });

      const hitlService = createMockHitlService();
      hitlService.generateStreamUrl.mockResolvedValue({ url: 'https://vnc.example', expires_at: '2026-04-01T01:00:00Z' });

      const { service } = buildService({ sessionRepo, interventionRepo, hitlService, credentialsService });

      const result = await service.getSessionStatus('profile-1', 'tenant-1', [], 'Operator');

      expect(result.pending_input_request).toEqual({
        input_type: 'confirm',
        step_index: 2,
        label: 'Log in via VNC',
      });
      expect(result.hitl_active).toBe(true);
      expect(interventionRepo.findOne).toHaveBeenCalledWith({
        where: { session_id: 'session-1' },
        order: { started_at: 'DESC' },
      });
    });

    it('falls back to session.pending_input_request when no intervention exists', async () => {
      const credentialsService = createMockCredentialsService();
      credentialsService.resolveActiveProfile.mockResolvedValue({ app_id: 'app-1' });

      const sessionWithPending = {
        ...mockSession,
        pending_input_request: { input_type: 'otp', step_index: 5 },
      };
      const sessionRepo = createMockSessionRepo();
      sessionRepo.findOne.mockResolvedValue(sessionWithPending);

      const interventionRepo = createMockInterventionRepo();
      interventionRepo.findOne.mockResolvedValue(null);

      const hitlService = createMockHitlService();
      hitlService.generateStreamUrl.mockResolvedValue({ url: 'https://vnc.example', expires_at: '2026-04-01T01:00:00Z' });

      const { service } = buildService({ sessionRepo, interventionRepo, hitlService, credentialsService });

      const result = await service.getSessionStatus('profile-1', 'tenant-1', [], 'Operator');

      expect(result.pending_input_request).toEqual({ input_type: 'otp', step_index: 5 });
    });

    it('returns null pending_input_request for HEALTHY sessions', async () => {
      const credentialsService = createMockCredentialsService();
      credentialsService.resolveActiveProfile.mockResolvedValue({ app_id: 'app-1' });

      const healthySession = { ...mockSession, state: SessionState.HEALTHY };
      const sessionRepo = createMockSessionRepo();
      sessionRepo.findOne.mockResolvedValue(healthySession);

      const interventionRepo = createMockInterventionRepo();

      const { service } = buildService({ sessionRepo, interventionRepo, credentialsService });

      const result = await service.getSessionStatus('profile-1', 'tenant-1', [], 'Operator');

      expect(result.hitl_active).toBe(false);
      expect(result.pending_input_request).toBeNull();
      expect(interventionRepo.findOne).not.toHaveBeenCalled();
    });

    it('rejects Agent role without allowed profile', async () => {
      const { service } = buildService();

      await expect(
        service.getSessionStatus('restricted-profile', 'tenant-1', ['other-profile'], 'Agent'),
      ).rejects.toThrow('Agent is not authorized');
    });
  });

  it('rejects idempotency key reuse for a different payload hash', async () => {
    const { service } = buildService();

    (service as any).redis = {
      get: jest.fn().mockResolvedValue(JSON.stringify({
        status: 'complete',
        request_hash: 'aaaaaaaa',
        started_at: '2026-02-19T00:00:00.000Z',
        completed_at: '2026-02-19T00:00:10.000Z',
        response: { run_id: 'app-old' },
      })),
      set: jest.fn(),
      del: jest.fn(),
    };
    (service as any).computeRequestHash = jest.fn().mockReturnValue('bbbbbbbb');

    await expect(service.runUrl(
      { url: 'https://example.com' },
      'tenant-1',
      'user-1',
      'reuse-key-1',
    )).rejects.toThrow(ConflictException);
  });
});
