import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { DEFAULTS } from '@browser-hitl/shared';

// ---------------------------------------------------------------------------
// Mock bcryptjs (required — auth.service.ts imports it)
// ---------------------------------------------------------------------------
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

import { AuthService, JwtPayload } from './auth.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockUserRepo() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function createMockAgentClientRepo(findOneResult: any = null) {
  return {
    findOne: jest.fn().mockResolvedValue(findOneResult),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((entity: any) => ({ ...entity, id: 'uuid-1' })),
    save: jest.fn().mockImplementation((entity: any) => ({
      ...entity,
      id: entity.id || 'uuid-1',
      created_at: new Date(),
      updated_at: new Date(),
    })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function createMockJwtService() {
  return {
    sign: jest.fn().mockReturnValue('signed.agent.jwt.token'),
    verify: jest.fn(),
  };
}

function buildService(overrides: {
  userRepo?: any;
  agentClientRepo?: any;
  jwtService?: any;
} = {}) {
  const userRepo = overrides.userRepo ?? createMockUserRepo();
  const agentClientRepo = overrides.agentClientRepo ?? createMockAgentClientRepo();
  const jwtService = overrides.jwtService ?? createMockJwtService();

  const service = Object.create(AuthService.prototype);
  (service as any).userRepo = userRepo;
  (service as any).agentClientRepo = agentClientRepo;
  (service as any).jwtService = jwtService;
  return { service: service as AuthService, userRepo, agentClientRepo, jwtService };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Agent Authentication (ADR-010)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test';
  });

  // =========================================================================
  // HMAC-SHA256 Hashing
  // =========================================================================

  describe('hashAgentSecret / verifyAgentSecret', () => {
    it('should produce a consistent hex hash', () => {
      const { service } = buildService();
      const hash1 = service.hashAgentSecret('secret_sk_test123');
      const hash2 = service.hashAgentSecret('secret_sk_test123');
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 = 64 hex chars
    });

    it('should produce different hashes for different secrets', () => {
      const { service } = buildService();
      const hash1 = service.hashAgentSecret('secret_sk_aaa');
      const hash2 = service.hashAgentSecret('secret_sk_bbb');
      expect(hash1).not.toBe(hash2);
    });

    it('should verify a correct secret', () => {
      const { service } = buildService();
      const hash = service.hashAgentSecret('secret_sk_test');
      expect(service.verifyAgentSecret('secret_sk_test', hash)).toBe(true);
    });

    it('should reject an incorrect secret', () => {
      const { service } = buildService();
      const hash = service.hashAgentSecret('secret_sk_correct');
      expect(service.verifyAgentSecret('secret_sk_wrong', hash)).toBe(false);
    });
  });

  // =========================================================================
  // Credential Generation
  // =========================================================================

  describe('generateAgentCredentials', () => {
    it('should generate client_id with correct prefix', () => {
      const { service } = buildService();
      const { client_id, client_secret } = service.generateAgentCredentials();
      expect(client_id).toMatch(/^agent_cl_[0-9a-f]{32}$/);
      expect(client_secret).toMatch(/^secret_sk_[0-9a-f]{64}$/);
    });

    it('should generate unique credentials each time', () => {
      const { service } = buildService();
      const a = service.generateAgentCredentials();
      const b = service.generateAgentCredentials();
      expect(a.client_id).not.toBe(b.client_id);
      expect(a.client_secret).not.toBe(b.client_secret);
    });
  });

  // =========================================================================
  // Agent Token Issuance
  // =========================================================================

  describe('issueAgentToken', () => {
    const mockClient = {
      id: 'uuid-1',
      client_id: 'agent_cl_abc123',
      client_secret_hash: '', // will be set per test
      name: 'test-agent',
      tenant_id: 'tenant-1',
      allowed_profiles: ['salesforce-standard', 'servicenow-itsm'],
      token_ttl_seconds: 3600,
      rate_limit_per_minute: 30,
      enabled: true,
      revoked_at: null,
      last_used_at: null,
    };

    it('should issue a token for valid credentials', async () => {
      const { service, agentClientRepo, jwtService } = buildService();

      // Compute the correct hash for the mock client
      const secretHash = service.hashAgentSecret('secret_sk_valid');
      const client = { ...mockClient, client_secret_hash: secretHash };
      agentClientRepo.findOne.mockResolvedValue(client);

      const result = await service.issueAgentToken('agent_cl_abc123', 'secret_sk_valid');

      expect(result.access_token).toBe('signed.agent.jwt.token');
      expect(result.token_type).toBe('Bearer');
      expect(result.expires_in).toBe(3600);
      expect(result.refresh_before).toBe(3300); // 5 min before expiry
      expect(result.scope).toContain('auth:request');
      expect(result.scope).toContain('profile:salesforce-standard');

      // Verify JWT payload
      const signCall = jwtService.sign.mock.calls[0];
      const payload: JwtPayload = signCall[0];
      expect(payload.sub).toBe('agent:agent_cl_abc123');
      expect(payload.role).toBe('Agent');
      expect(payload.token_type).toBe('agent');
      expect(payload.allowed_profiles).toEqual(['salesforce-standard', 'servicenow-itsm']);
      expect(payload.jti).toBeDefined();
    });

    it('should update last_used_at on successful issuance', async () => {
      const { service, agentClientRepo } = buildService();
      const secretHash = service.hashAgentSecret('secret_sk_valid');
      agentClientRepo.findOne.mockResolvedValue({ ...mockClient, client_secret_hash: secretHash });

      await service.issueAgentToken('agent_cl_abc123', 'secret_sk_valid');

      expect(agentClientRepo.update).toHaveBeenCalledWith('uuid-1', expect.objectContaining({
        last_used_at: expect.any(Date),
      }));
    });

    it('should clamp TTL to min/max bounds', async () => {
      const { service, agentClientRepo, jwtService } = buildService();
      const secretHash = service.hashAgentSecret('secret_sk_valid');

      // TTL below minimum
      agentClientRepo.findOne.mockResolvedValue({
        ...mockClient,
        client_secret_hash: secretHash,
        token_ttl_seconds: 10, // below AGENT_TOKEN_MIN_TTL_SECONDS (300)
      });

      await service.issueAgentToken('agent_cl_abc123', 'secret_sk_valid');

      const signOpts = jwtService.sign.mock.calls[0][1];
      expect(signOpts.expiresIn).toBe(DEFAULTS.AGENT_TOKEN_MIN_TTL_SECONDS);
    });

    // =====================================================================
    // ADVERSARIAL: Invalid credentials
    // =====================================================================

    it('should reject unknown client_id', async () => {
      const { service, agentClientRepo } = buildService();
      agentClientRepo.findOne.mockResolvedValue(null);

      await expect(service.issueAgentToken('unknown', 'secret'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('should reject wrong secret', async () => {
      const { service, agentClientRepo } = buildService();
      const secretHash = service.hashAgentSecret('secret_sk_correct');
      agentClientRepo.findOne.mockResolvedValue({
        ...mockClient,
        client_secret_hash: secretHash,
      });

      await expect(service.issueAgentToken('agent_cl_abc123', 'secret_sk_wrong'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('should reject revoked client', async () => {
      const { service, agentClientRepo } = buildService();
      const secretHash = service.hashAgentSecret('secret_sk_valid');
      agentClientRepo.findOne.mockResolvedValue({
        ...mockClient,
        client_secret_hash: secretHash,
        revoked_at: new Date(),
      });

      await expect(service.issueAgentToken('agent_cl_abc123', 'secret_sk_valid'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('should reject disabled client', async () => {
      const { service, agentClientRepo } = buildService();
      const secretHash = service.hashAgentSecret('secret_sk_valid');
      agentClientRepo.findOne.mockResolvedValue({
        ...mockClient,
        client_secret_hash: secretHash,
        enabled: false,
      });

      await expect(service.issueAgentToken('agent_cl_abc123', 'secret_sk_valid'))
        .rejects.toThrow(UnauthorizedException);
    });
  });

  // =========================================================================
  // Agent Client Registration
  // =========================================================================

  describe('registerAgentClient', () => {
    it('should create a new client with hashed secret', async () => {
      const { service, agentClientRepo } = buildService();

      const result = await service.registerAgentClient({
        name: 'test-agent',
        tenant_id: 'tenant-1',
        allowed_profiles: ['salesforce-standard'],
      });

      expect(result.client_id).toMatch(/^agent_cl_/);
      expect(result.client_secret).toMatch(/^secret_sk_/);
      expect(result.name).toBe('test-agent');

      // Verify the stored hash matches the returned secret
      const savedEntity = agentClientRepo.create.mock.calls[0][0];
      expect(service.verifyAgentSecret(result.client_secret, savedEntity.client_secret_hash)).toBe(true);
    });

    it('should use default TTL and rate limit when not specified', async () => {
      const { service, agentClientRepo } = buildService();

      await service.registerAgentClient({
        name: 'test',
        tenant_id: 'tenant-1',
        allowed_profiles: ['salesforce-standard'],
      });

      const savedEntity = agentClientRepo.create.mock.calls[0][0];
      expect(savedEntity.token_ttl_seconds).toBe(DEFAULTS.AGENT_TOKEN_TTL_SECONDS);
      expect(savedEntity.rate_limit_per_minute).toBe(DEFAULTS.AGENT_RATE_LIMIT_PER_MINUTE);
    });
  });

  // =========================================================================
  // Agent Client Revocation
  // =========================================================================

  describe('revokeAgentClient', () => {
    it('should set revoked_at and enabled=false', async () => {
      const { service, agentClientRepo } = buildService();
      agentClientRepo.findOne.mockResolvedValue({
        id: 'uuid-1',
        tenant_id: 'tenant-1',
      });

      await service.revokeAgentClient('uuid-1', 'tenant-1');

      expect(agentClientRepo.update).toHaveBeenCalledWith('uuid-1', {
        revoked_at: expect.any(Date),
        enabled: false,
      });
    });

    it('should reject revoking non-existent client', async () => {
      const { service, agentClientRepo } = buildService();
      agentClientRepo.findOne.mockResolvedValue(null);

      await expect(service.revokeAgentClient('unknown', 'tenant-1'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('should reject cross-tenant revocation', async () => {
      const { service, agentClientRepo } = buildService();
      agentClientRepo.findOne.mockResolvedValue(null); // findOne with wrong tenant returns null

      await expect(service.revokeAgentClient('uuid-1', 'wrong-tenant'))
        .rejects.toThrow(UnauthorizedException);
    });
  });

  // =========================================================================
  // Secret Rotation
  // =========================================================================

  describe('rotateAgentSecret', () => {
    it('should generate a new secret and update the hash', async () => {
      const { service, agentClientRepo } = buildService();
      agentClientRepo.findOne.mockResolvedValue({
        id: 'uuid-1',
        client_id: 'agent_cl_abc123',
        tenant_id: 'tenant-1',
        enabled: true,
        revoked_at: null,
      });

      const result = await service.rotateAgentSecret('uuid-1', 'tenant-1');

      expect(result.client_id).toBe('agent_cl_abc123');
      expect(result.client_secret).toMatch(/^secret_sk_/);

      // Verify the new hash was stored
      const updateCall = agentClientRepo.update.mock.calls[0];
      const newHash = updateCall[1].client_secret_hash;
      expect(service.verifyAgentSecret(result.client_secret, newHash)).toBe(true);
    });

    it('should reject rotation for revoked client', async () => {
      const { service, agentClientRepo } = buildService();
      agentClientRepo.findOne.mockResolvedValue({
        id: 'uuid-1',
        tenant_id: 'tenant-1',
        enabled: false,
        revoked_at: new Date(),
      });

      await expect(service.rotateAgentSecret('uuid-1', 'tenant-1'))
        .rejects.toThrow(ForbiddenException);
    });

    // ADVERSARIAL: Old secret should not work after rotation
    it('should invalidate old secret after rotation', async () => {
      const { service, agentClientRepo } = buildService();
      const oldSecret = 'secret_sk_old';
      const oldHash = service.hashAgentSecret(oldSecret);

      agentClientRepo.findOne.mockResolvedValue({
        id: 'uuid-1',
        client_id: 'agent_cl_abc123',
        tenant_id: 'tenant-1',
        enabled: true,
        revoked_at: null,
      });

      const result = await service.rotateAgentSecret('uuid-1', 'tenant-1');
      const newHash = agentClientRepo.update.mock.calls[0][1].client_secret_hash;

      // Old secret should not match new hash
      expect(service.verifyAgentSecret(oldSecret, newHash)).toBe(false);
      // New secret should match new hash
      expect(service.verifyAgentSecret(result.client_secret, newHash)).toBe(true);
    });
  });

  // =========================================================================
  // ADVERSARIAL: Replay and Timing Attacks
  // =========================================================================

  describe('Adversarial: security properties', () => {
    it('should not leak timing information on wrong vs missing client_id', async () => {
      // Both wrong and missing client_id should throw the same error message
      const { service, agentClientRepo } = buildService();
      agentClientRepo.findOne.mockResolvedValue(null);

      const error1 = await service.issueAgentToken('wrong_id', 'any_secret')
        .catch(e => e);
      const error2 = await service.issueAgentToken('another_wrong', 'any_secret')
        .catch(e => e);

      expect(error1.message).toBe(error2.message);
      expect(error1.message).toBe('Invalid agent client credentials');
    });

    it('should use same error message for wrong secret vs wrong client', async () => {
      const { service, agentClientRepo } = buildService();
      const secretHash = service.hashAgentSecret('correct_secret');

      // Test 1: wrong client
      agentClientRepo.findOne.mockResolvedValueOnce(null);
      const err1 = await service.issueAgentToken('wrong_client', 'any').catch(e => e);

      // Test 2: right client, wrong secret
      agentClientRepo.findOne.mockResolvedValueOnce({
        id: 'uuid-1',
        client_id: 'agent_cl_abc',
        client_secret_hash: secretHash,
        enabled: true,
        revoked_at: null,
      });
      const err2 = await service.issueAgentToken('agent_cl_abc', 'wrong_secret').catch(e => e);

      expect(err1.message).toBe('Invalid agent client credentials');
      expect(err2.message).toBe('Invalid agent client credentials');
    });

    it('should never store plaintext secret in entity', async () => {
      const { service, agentClientRepo } = buildService();

      const result = await service.registerAgentClient({
        name: 'test',
        tenant_id: 'tenant-1',
        allowed_profiles: ['sf'],
      });

      const createdEntity = agentClientRepo.create.mock.calls[0][0];
      // The entity should have a hash, not the plaintext secret
      expect(createdEntity.client_secret_hash).not.toBe(result.client_secret);
      expect(createdEntity.client_secret_hash).toMatch(/^[0-9a-f]{64}$/);
      // There should be no plaintext secret field on the entity
      expect(createdEntity.client_secret).toBeUndefined();
    });
  });
});
