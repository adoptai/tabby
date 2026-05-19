import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { SessionEntity, ApplicationEntity, InterventionEntity } from '../../entities';
import { StreamTokenService } from './stream-token.service';
import { StreamingController } from './streaming.controller';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    app_id: 'app-1',
    tenant_id: 'tenant-1',
    owner_user_id: null,
    state: 'HEALTHY',
    health_result_type: 'PASS',
    restart_requested: false,
    pending_input_request: null,
    intervention_count: 3,
    retry_count: 1,
    last_health_check: new Date('2024-01-01T00:00:00Z'),
    started_at: new Date('2024-01-01T00:00:00Z'),
    pod_name: 'pod-1',
    ...overrides,
  } as unknown as SessionEntity;
}

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    browser_policy: null,
    ...overrides,
  } as unknown as ApplicationEntity;
}

function buildModule(overrides: {
  sessionRepo?: Record<string, unknown>;
  appRepo?: Record<string, unknown>;
  interventionRepo?: Record<string, unknown>;
  streamTokenService?: Record<string, unknown>;
  jwtService?: Record<string, unknown>;
} = {}) {
  const sessionRepo = overrides.sessionRepo ?? { findOne: jest.fn(), update: jest.fn() };
  const appRepo = overrides.appRepo ?? { findOne: jest.fn() };
  const interventionRepo = overrides.interventionRepo ?? { findOne: jest.fn() };
  const streamTokenService = overrides.streamTokenService ?? {
    verifyToken: jest.fn().mockReturnValue({ valid: true, payload: { session_id: 'sess-1', user_id: 'user-1' } }),
    generateToken: jest.fn().mockResolvedValue('new-token'),
  };
  const jwtService = overrides.jwtService ?? { verify: jest.fn(), sign: jest.fn() };

  return Test.createTestingModule({
    controllers: [StreamingController],
    providers: [
      { provide: StreamTokenService, useValue: streamTokenService },
      { provide: JwtService, useValue: jwtService },
      { provide: getRepositoryToken(SessionEntity), useValue: sessionRepo },
      { provide: getRepositoryToken(ApplicationEntity), useValue: appRepo },
      { provide: getRepositoryToken(InterventionEntity), useValue: interventionRepo },
      {
        provide: getRepositoryToken(
          require('../../entities').IdentityProviderEntity,
        ),
        useValue: { findOne: jest.fn() },
      },
      {
        provide: getRepositoryToken(require('../../entities').UserEntity),
        useValue: { findOne: jest.fn() },
      },
    ],
  }).compile();
}

describe('StreamingController — panel-state', () => {
  let controller: StreamingController;
  let sessionRepo: any;
  let interventionRepo: any;
  let streamTokenService: any;

  beforeEach(async () => {
    sessionRepo = { findOne: jest.fn(), update: jest.fn() };
    interventionRepo = { findOne: jest.fn() };
    streamTokenService = {
      verifyToken: jest.fn().mockReturnValue({
        valid: true,
        payload: { session_id: 'sess-1', user_id: 'user-1' },
      }),
      generateToken: jest.fn().mockResolvedValue('new-token'),
    };

    const module: TestingModule = await buildModule({ sessionRepo, interventionRepo, streamTokenService });
    controller = module.get(StreamingController);
  });

  it('returns structured panel state for a healthy session', async () => {
    sessionRepo.findOne.mockResolvedValue(makeSession());

    const result = await controller.getPanelState('sess-1', 'valid-token');

    expect(result.state).toBe('HEALTHY');
    expect(result.health_result_type).toBe('PASS');
    expect(result.restart_requested).toBe(false);
    expect(result.intervention_count).toBe(3);
    expect(result.retry_count).toBe(1);
    expect(result.app_id).toBe('app-1');
  });

  it('throws UnauthorizedException when token is missing', async () => {
    await expect(controller.getPanelState('sess-1', undefined)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when token is invalid', async () => {
    streamTokenService.verifyToken.mockReturnValue({ valid: false, reason: 'Expired' });
    await expect(controller.getPanelState('sess-1', 'bad-token')).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when token is for a different session', async () => {
    streamTokenService.verifyToken.mockReturnValue({
      valid: true,
      payload: { session_id: 'sess-OTHER', user_id: 'user-1' },
    });
    await expect(controller.getPanelState('sess-1', 'mismatch-token')).rejects.toThrow(UnauthorizedException);
  });

  it('throws NotFoundException when session does not exist', async () => {
    sessionRepo.findOne.mockResolvedValue(null);
    await expect(controller.getPanelState('sess-1', 'valid-token')).rejects.toThrow(NotFoundException);
  });

  it('falls back to latest intervention when pending_input_request is null and state is LOGIN_NEEDED', async () => {
    sessionRepo.findOne.mockResolvedValue(
      makeSession({ state: 'LOGIN_NEEDED', pending_input_request: null }),
    );
    interventionRepo.findOne.mockResolvedValue({
      input_request_metadata: { input_type: 'otp', label: 'Enter OTP', step_index: 2 },
    });

    const result = await controller.getPanelState('sess-1', 'valid-token');

    expect(result.pending_input_request).toEqual({ input_type: 'otp', label: 'Enter OTP', step_index: 2 });
  });

  it('returns pending_input_request directly from session when present', async () => {
    const pendingInput = { input_type: 'password', step_index: 1 };
    sessionRepo.findOne.mockResolvedValue(makeSession({ pending_input_request: pendingInput }));

    const result = await controller.getPanelState('sess-1', 'valid-token');

    expect(result.pending_input_request).toEqual(pendingInput);
    expect(interventionRepo.findOne).not.toHaveBeenCalled();
  });

  it('returns null pending_input_request for non-LOGIN states without session data', async () => {
    sessionRepo.findOne.mockResolvedValue(makeSession({ state: 'HEALTHY', pending_input_request: null }));

    const result = await controller.getPanelState('sess-1', 'valid-token');

    expect(result.pending_input_request).toBeNull();
    expect(interventionRepo.findOne).not.toHaveBeenCalled();
  });
});

describe('StreamingController — restart', () => {
  let controller: StreamingController;
  let sessionRepo: any;
  let streamTokenService: any;

  beforeEach(async () => {
    sessionRepo = { findOne: jest.fn(), update: jest.fn() };
    streamTokenService = {
      verifyToken: jest.fn().mockReturnValue({
        valid: true,
        payload: { session_id: 'sess-1', user_id: 'user-1' },
      }),
      generateToken: jest.fn().mockResolvedValue('new-token'),
    };

    const module: TestingModule = await buildModule({ sessionRepo, streamTokenService });
    controller = module.get(StreamingController);
  });

  it('sets restart_requested = true and returns expected body', async () => {
    sessionRepo.findOne.mockResolvedValue(makeSession({ state: 'HEALTHY' }));

    const result = await controller.restartSession('sess-1', 'valid-token');

    expect(sessionRepo.update).toHaveBeenCalledWith('sess-1', { restart_requested: true });
    expect(result).toEqual({ message: 'Restart requested', session_id: 'sess-1', app_id: 'app-1' });
  });

  it('throws UnauthorizedException when token is missing', async () => {
    await expect(controller.restartSession('sess-1', undefined)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException for invalid token', async () => {
    streamTokenService.verifyToken.mockReturnValue({ valid: false, reason: 'Expired' });
    await expect(controller.restartSession('sess-1', 'bad')).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when token session_id mismatches', async () => {
    streamTokenService.verifyToken.mockReturnValue({
      valid: true,
      payload: { session_id: 'sess-OTHER', user_id: 'user-1' },
    });
    await expect(controller.restartSession('sess-1', 'mismatch')).rejects.toThrow(UnauthorizedException);
  });

  it('throws NotFoundException when session does not exist', async () => {
    sessionRepo.findOne.mockResolvedValue(null);
    await expect(controller.restartSession('sess-1', 'valid-token')).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException for TERMINATED sessions', async () => {
    sessionRepo.findOne.mockResolvedValue(makeSession({ state: 'TERMINATED' }));
    await expect(controller.restartSession('sess-1', 'valid-token')).rejects.toThrow(BadRequestException);
    expect(sessionRepo.update).not.toHaveBeenCalled();
  });
});

describe('StreamingController — successor', () => {
  let controller: StreamingController;
  let sessionRepo: any;
  let appRepo: any;
  let streamTokenService: any;

  beforeEach(async () => {
    sessionRepo = { findOne: jest.fn(), update: jest.fn() };
    appRepo = { findOne: jest.fn() };
    streamTokenService = {
      verifyToken: jest.fn().mockReturnValue({
        valid: true,
        payload: { session_id: 'sess-1', user_id: 'user-1' },
      }),
      generateToken: jest.fn().mockResolvedValue('new-token'),
    };

    const module: TestingModule = await buildModule({ sessionRepo, appRepo, streamTokenService });
    controller = module.get(StreamingController);
  });

  it('returns successor URL when a new session exists for the same app', async () => {
    sessionRepo.findOne
      .mockResolvedValueOnce(makeSession({ id: 'sess-1', app_id: 'app-1', state: 'TERMINATED' }))
      .mockResolvedValueOnce(makeSession({ id: 'sess-2', app_id: 'app-1', state: 'STARTING' }));
    appRepo.findOne.mockResolvedValue(makeApp({ browser_policy: null }));

    const result = await controller.getSuccessor('sess-1', 'valid-token');

    expect(result.session_id).toBe('sess-2');
    expect(result.url).toContain('sess-2');
    expect(result.url).toContain('new-token');
    expect(streamTokenService.generateToken).toHaveBeenCalledWith('sess-2', 'user-1');
  });

  it('uses CDP URL prefix when streaming_mode is cdp', async () => {
    sessionRepo.findOne
      .mockResolvedValueOnce(makeSession({ id: 'sess-1', app_id: 'app-1', state: 'TERMINATED' }))
      .mockResolvedValueOnce(makeSession({ id: 'sess-2', app_id: 'app-1', state: 'STARTING' }));
    appRepo.findOne.mockResolvedValue(makeApp({ browser_policy: { streaming_mode: 'cdp' } }));

    const result = await controller.getSuccessor('sess-1', 'valid-token');

    expect(result.url).toContain('/cdp/sess-2');
  });

  it('defaults to VNC URL prefix when streaming_mode is not set', async () => {
    sessionRepo.findOne
      .mockResolvedValueOnce(makeSession({ id: 'sess-1', app_id: 'app-1', state: 'TERMINATED' }))
      .mockResolvedValueOnce(makeSession({ id: 'sess-2', app_id: 'app-1', state: 'HEALTHY' }));
    appRepo.findOne.mockResolvedValue(makeApp({ browser_policy: null }));

    const result = await controller.getSuccessor('sess-1', 'valid-token');

    expect(result.url).toContain('/vnc/sess-2');
  });

  it('throws NotFoundException when no active session found yet', async () => {
    sessionRepo.findOne
      .mockResolvedValueOnce(makeSession({ id: 'sess-1', state: 'TERMINATED' }))
      .mockResolvedValueOnce(null);

    await expect(controller.getSuccessor('sess-1', 'valid-token')).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when the session has not terminated yet', async () => {
    sessionRepo.findOne
      .mockResolvedValueOnce(makeSession({ id: 'sess-1', state: 'HEALTHY' }));

    await expect(controller.getSuccessor('sess-1', 'valid-token')).rejects.toThrow(NotFoundException);
  });

  it('throws UnauthorizedException when token is missing', async () => {
    await expect(controller.getSuccessor('sess-1', undefined)).rejects.toThrow(UnauthorizedException);
  });
});
