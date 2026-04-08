import { UnauthorizedException } from '@nestjs/common';

// Minimal mocks
function createMockIdpRepo() {
  return { findOne: jest.fn() };
}
function createMockIdentityRepo() {
  return { findOne: jest.fn(), create: jest.fn(), save: jest.fn() };
}
function createMockJwksService() {
  return { getPublicKey: jest.fn(), forceRefresh: jest.fn() };
}
function createMockJwtService() {
  return { sign: jest.fn().mockReturnValue('mock-federated-jwt'), verify: jest.fn() };
}
function createMockAuditService() {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

function buildService(overrides: Record<string, any> = {}) {
  const { TokenExchangeService } = require('./token-exchange.service');
  const idpRepo = overrides.idpRepo ?? createMockIdpRepo();
  const identityRepo = overrides.identityRepo ?? createMockIdentityRepo();
  const jwksService = overrides.jwksService ?? createMockJwksService();
  const jwtService = overrides.jwtService ?? createMockJwtService();
  const auditService = overrides.auditService ?? createMockAuditService();

  const service = Object.create(TokenExchangeService.prototype);
  (service as any).idpRepo = idpRepo;
  (service as any).identityRepo = identityRepo;
  (service as any).jwksService = jwksService;
  (service as any).jwtService = jwtService;
  (service as any).auditService = auditService;

  return { service, idpRepo, identityRepo, jwksService, jwtService, auditService };
}

describe('TokenExchangeService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('agent_assertion mode', () => {
    it('issues user-scoped token when agent vouches for end-user', async () => {
      const { service, jwtService, auditService } = buildService();

      const result = await service.exchange({
        subject_token: 'agent-jwt',
        subject_token_type: 'agent_assertion',
        target_user_id: 'end-user-123',
        agent_payload: {
          sub: 'agent:agent_cl_abc',
          tenant_id: 'tenant-1',
          token_type: 'agent',
          role: 'Operator',
          agent_client_id: 'agent_cl_abc',
          allowed_profiles: ['sfdc-standard'],
        },
      });

      expect(result.access_token).toBe('mock-federated-jwt');
      expect(result.owner_user_id).toBe('end-user-123');
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'federated:end-user-123',
          token_type: 'federated',
          owner_user_id: 'end-user-123',
          allowed_profiles: ['sfdc-standard'],
        }),
        expect.any(Object),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'auth.token_exchange.issued' }),
      );
    });

    it('rejects if no agent payload', async () => {
      const { service } = buildService();
      await expect(service.exchange({
        subject_token: 'jwt',
        subject_token_type: 'agent_assertion',
        target_user_id: 'user-1',
      })).rejects.toThrow(UnauthorizedException);
    });

    it('rejects if agent token_type is not agent', async () => {
      const { service } = buildService();
      await expect(service.exchange({
        subject_token: 'jwt',
        subject_token_type: 'agent_assertion',
        target_user_id: 'user-1',
        agent_payload: { sub: 'user-1', tenant_id: 't', token_type: 'human', role: 'Admin' },
      })).rejects.toThrow(UnauthorizedException);
    });

    it('rejects if no target_user_id', async () => {
      const { service } = buildService();
      await expect(service.exchange({
        subject_token: 'jwt',
        subject_token_type: 'agent_assertion',
        agent_payload: { sub: 'a', tenant_id: 't', token_type: 'agent', role: 'Operator' },
      })).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('oidc_jwt mode', () => {
    // Create a minimal JWT for testing (header.payload.signature)
    const fakeJwt = [
      Buffer.from(JSON.stringify({ kid: 'key-1', alg: 'RS256' })).toString('base64url'),
      Buffer.from(JSON.stringify({ iss: 'https://auth.example.com', sub: 'user-abc', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })).toString('base64url'),
      'fake-signature',
    ].join('.');

    it('rejects when no IdP matches the issuer', async () => {
      const { service, idpRepo } = buildService();
      idpRepo.findOne.mockResolvedValue(null);

      await expect(service.exchange({
        subject_token: fakeJwt,
        subject_token_type: 'oidc_jwt',
      }, 'tenant-1')).rejects.toThrow('No registered IdP');
    });

    it('verifies JWT and issues federated token', async () => {
      const { service, idpRepo, jwtService, jwksService, identityRepo, auditService } = buildService();

      idpRepo.findOne.mockResolvedValue({
        id: 'idp-1',
        tenant_id: 'tenant-1',
        issuer_url: 'https://auth.example.com',
        audience: null,
        user_id_claim: 'sub',
        default_role: 'Viewer',
      });

      jwksService.getPublicKey.mockResolvedValue('mock-pem');
      jwtService.verify.mockReturnValue({
        iss: 'https://auth.example.com',
        sub: 'user-abc',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      });
      identityRepo.findOne.mockResolvedValue(null);
      identityRepo.create.mockReturnValue({});
      identityRepo.save.mockResolvedValue({});

      const result = await service.exchange({
        subject_token: fakeJwt,
        subject_token_type: 'oidc_jwt',
      }, 'tenant-1');

      expect(result.access_token).toBe('mock-federated-jwt');
      expect(result.owner_user_id).toBe('user-abc');
      expect(jwksService.getPublicKey).toHaveBeenCalledWith('https://auth.example.com', 'key-1');
      expect(auditService.log).toHaveBeenCalled();
    });
  });

  it('rejects unsupported subject_token_type', async () => {
    const { service } = buildService();
    await expect(service.exchange({
      subject_token: 'jwt',
      subject_token_type: 'unknown' as any,
    })).rejects.toThrow('Unsupported');
  });
});
