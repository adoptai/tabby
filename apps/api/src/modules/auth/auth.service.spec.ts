import { UnauthorizedException } from '@nestjs/common';
import { DEFAULTS } from '@browser-hitl/shared';

// ---------------------------------------------------------------------------
// Mock bcryptjs (pure-JS bcrypt replacement).
// We mock the module used by auth.service.ts: `import * as bcrypt from 'bcryptjs'`
// ---------------------------------------------------------------------------

const mockCompare = jest.fn();
const mockHash = jest.fn();

jest.mock('bcryptjs', () => ({
  compare: (...args: any[]) => mockCompare(...args),
  hash: (...args: any[]) => mockHash(...args),
}));

import { AuthService, JwtPayload } from './auth.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockUserRepo(findOneResult: any = null) {
  return {
    findOne: jest.fn().mockResolvedValue(findOneResult),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function createMockJwtService() {
  return {
    sign: jest.fn().mockReturnValue('signed.jwt.token'),
    verify: jest.fn().mockImplementation((token: string) => {
      if (token === 'signed.jwt.token') {
        return { sub: 'user-1', tenant_id: 'tenant-1', role: 'Admin', kid: 'v1' };
      }
      throw new Error('invalid token');
    }),
  };
}

function buildService(overrides: { userRepo?: any; jwtService?: any } = {}) {
  const userRepo = overrides.userRepo ?? createMockUserRepo();
  const jwtService = overrides.jwtService ?? createMockJwtService();

  // Use Object.create to instantiate without the NestJS DI constructor
  const service = Object.create(AuthService.prototype);
  (service as any).userRepo = userRepo;
  (service as any).jwtService = jwtService;
  return { service: service as AuthService, userRepo, jwtService };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SERVICE_AUTH_CLIENT_ID;
    delete process.env.SERVICE_AUTH_CLIENT_SECRET;
    delete process.env.SERVICE_AUTH_ALLOWED_TENANT_IDS;
    delete process.env.SERVICE_AUTH_ALLOW_WILDCARD_TENANT_SCOPE;
    delete process.env.SERVICE_AUTH_ALLOWED_ROLES;
    delete process.env.SERVICE_AUTH_DEFAULT_ROLE;
    delete process.env.SERVICE_AUTH_TOKEN_TTL_SECONDS;
    // Default: compare returns false (wrong password)
    mockCompare.mockResolvedValue(false);
    // Default: hash returns a bcrypt-like string
    mockHash.mockResolvedValue('$2b$12$saltsaltsaltsaltsaltsehashedhashedhashedhash');
  });

  // -----------------------------------------------------------------------
  // validateUser
  // -----------------------------------------------------------------------
  describe('validateUser', () => {
    it('throws UnauthorizedException when user is not found', async () => {
      const { service } = buildService({
        userRepo: createMockUserRepo(null),
      });

      await expect(
        service.validateUser('nobody@example.com', 'password'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when password does not match', async () => {
      mockCompare.mockResolvedValue(false);

      const { service } = buildService({
        userRepo: createMockUserRepo({
          id: 'user-1',
          tenant_id: 'tenant-1',
          email: 'user@example.com',
          password_hash: '$2b$12$fakehash',
          role: 'Admin',
          status: 'ACTIVE',
        }),
      });

      await expect(
        service.validateUser('user@example.com', 'wrong-password'),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockCompare).toHaveBeenCalledWith('wrong-password', '$2b$12$fakehash');
    });

    it('returns user for correct credentials', async () => {
      mockCompare.mockResolvedValue(true);

      const fakeUser = {
        id: 'user-1',
        tenant_id: 'tenant-1',
        email: 'user@example.com',
        password_hash: '$2b$12$correcthash',
        role: 'Admin',
        status: 'ACTIVE',
      };
      const { service } = buildService({
        userRepo: createMockUserRepo(fakeUser),
      });

      const result = await service.validateUser('user@example.com', 'correct-password');

      expect(result).toBe(fakeUser);
      expect(mockCompare).toHaveBeenCalledWith('correct-password', '$2b$12$correcthash');
    });

    it('queries for ACTIVE users only', async () => {
      const { service, userRepo } = buildService({
        userRepo: createMockUserRepo(null),
      });

      try {
        await service.validateUser('user@example.com', 'pw');
      } catch {
        // expected
      }

      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { email: 'user@example.com', status: 'ACTIVE' },
      });
    });

    it('calls bcrypt.compare with the submitted password and stored hash', async () => {
      mockCompare.mockResolvedValue(true);

      const fakeUser = {
        id: 'user-1',
        tenant_id: 'tenant-1',
        email: 'user@example.com',
        password_hash: '$2b$12$stored_hash_value',
        role: 'Admin',
        status: 'ACTIVE',
      };
      const { service } = buildService({
        userRepo: createMockUserRepo(fakeUser),
      });

      await service.validateUser('user@example.com', 'my-secret');

      expect(mockCompare).toHaveBeenCalledTimes(1);
      expect(mockCompare).toHaveBeenCalledWith('my-secret', '$2b$12$stored_hash_value');
    });
  });

  // -----------------------------------------------------------------------
  // login
  // -----------------------------------------------------------------------
  describe('login', () => {
    it('returns JWT with correct claims (tenant_id, user_id, role)', async () => {
      mockCompare.mockResolvedValue(true);

      const fakeUser = {
        id: 'user-42',
        tenant_id: 'tenant-99',
        email: 'admin@example.com',
        password_hash: '$2b$12$hash',
        role: 'Operator',
        status: 'ACTIVE',
      };
      const jwtService = createMockJwtService();
      const { service } = buildService({
        userRepo: createMockUserRepo(fakeUser),
        jwtService,
      });

      const result = await service.login('admin@example.com', 'password123');

      // jwtService.sign should have been called with the correct payload
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-42',
          tenant_id: 'tenant-99',
          role: 'Operator',
          token_type: 'human',
        }),
      );

      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('expires_at');
      expect(typeof result.token).toBe('string');
    });

    it('returns a token that expires in JWT_TTL_HOURS', async () => {
      mockCompare.mockResolvedValue(true);

      const fakeUser = {
        id: 'user-1',
        tenant_id: 'tenant-1',
        email: 'admin@example.com',
        password_hash: '$2b$12$hash',
        role: 'Admin',
        status: 'ACTIVE',
      };
      const { service } = buildService({
        userRepo: createMockUserRepo(fakeUser),
      });

      const before = Date.now();
      const result = await service.login('admin@example.com', 'password123');
      const after = Date.now();

      const expiresAt = new Date(result.expires_at).getTime();
      const expectedMinMs = before + DEFAULTS.JWT_TTL_HOURS * 60 * 60 * 1000;
      const expectedMaxMs = after + DEFAULTS.JWT_TTL_HOURS * 60 * 60 * 1000;

      expect(expiresAt).toBeGreaterThanOrEqual(expectedMinMs);
      expect(expiresAt).toBeLessThanOrEqual(expectedMaxMs);
    });

    it('includes kid in JWT payload from env or default "v1"', async () => {
      mockCompare.mockResolvedValue(true);

      const fakeUser = {
        id: 'user-1',
        tenant_id: 'tenant-1',
        email: 'admin@example.com',
        password_hash: '$2b$12$hash',
        role: 'Admin',
        status: 'ACTIVE',
      };
      const jwtService = createMockJwtService();
      const { service } = buildService({
        userRepo: createMockUserRepo(fakeUser),
        jwtService,
      });

      // Ensure env is clear so default is used
      delete process.env.JWT_SIGNING_KEY_ID;
      await service.login('admin@example.com', 'password123');

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ kid: 'v1', token_type: 'human' }),
      );
    });

    it('calls validateUser internally before signing', async () => {
      const { service } = buildService({
        userRepo: createMockUserRepo(null),
      });

      // login should throw because validateUser will fail
      await expect(
        service.login('nobody@example.com', 'password'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // -----------------------------------------------------------------------
  // issueServiceToken
  // -----------------------------------------------------------------------
  describe('issueServiceToken', () => {
    it('issues a scoped service JWT when client credentials are valid', async () => {
      const tenantId = 'f7732a80-ca66-4596-abc1-1635ffbddde7';
      process.env.SERVICE_AUTH_CLIENT_ID = 'slack-bot';
      process.env.SERVICE_AUTH_CLIENT_SECRET = 'super-secret';
      process.env.SERVICE_AUTH_ALLOWED_TENANT_IDS = tenantId;
      process.env.SERVICE_AUTH_DEFAULT_ROLE = 'Operator';
      process.env.SERVICE_AUTH_ALLOWED_ROLES = 'Operator,Viewer';

      const jwtService = createMockJwtService();
      const { service } = buildService({ jwtService });

      const result = await service.issueServiceToken(
        'slack-bot',
        'super-secret',
        tenantId,
      );

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'svc:slack-bot',
          tenant_id: tenantId,
          role: 'Operator',
          token_type: 'service',
          service_client_id: 'slack-bot',
        }),
        expect.objectContaining({ expiresIn: 3600 }),
      );
      expect(result).toHaveProperty('token', 'signed.jwt.token');
      expect(result).toHaveProperty('token_type', 'Bearer');
    });

    it('rejects invalid service credentials', async () => {
      process.env.SERVICE_AUTH_CLIENT_ID = 'slack-bot';
      process.env.SERVICE_AUTH_CLIENT_SECRET = 'correct-secret';

      const { service } = buildService();

      await expect(
        service.issueServiceToken('slack-bot', 'wrong-secret', 'f7732a80-ca66-4596-abc1-1635ffbddde7'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects wildcard tenant scope when not explicitly enabled', async () => {
      process.env.SERVICE_AUTH_CLIENT_ID = 'slack-bot';
      process.env.SERVICE_AUTH_CLIENT_SECRET = 'super-secret';
      process.env.SERVICE_AUTH_ALLOWED_TENANT_IDS = '*';

      const { service } = buildService();

      await expect(
        service.issueServiceToken('slack-bot', 'super-secret', 'f7732a80-ca66-4596-abc1-1635ffbddde7'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects tenant IDs that are not allowlisted', async () => {
      process.env.SERVICE_AUTH_CLIENT_ID = 'slack-bot';
      process.env.SERVICE_AUTH_CLIENT_SECRET = 'super-secret';
      process.env.SERVICE_AUTH_ALLOWED_TENANT_IDS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

      const { service } = buildService();

      await expect(
        service.issueServiceToken('slack-bot', 'super-secret', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // -----------------------------------------------------------------------
  // hashPassword
  // -----------------------------------------------------------------------
  describe('hashPassword', () => {
    it('calls bcrypt.hash with DEFAULTS.BCRYPT_COST (12)', async () => {
      mockHash.mockResolvedValue('$2b$12$resultinghash');

      const { service } = buildService();

      const hash = await service.hashPassword('my-secret');

      expect(mockHash).toHaveBeenCalledWith('my-secret', DEFAULTS.BCRYPT_COST);
      expect(mockHash).toHaveBeenCalledWith('my-secret', 12);
      expect(hash).toBe('$2b$12$resultinghash');
    });

    it('DEFAULTS.BCRYPT_COST is 12', () => {
      expect(DEFAULTS.BCRYPT_COST).toBe(12);
    });

    it('returns the hash produced by bcrypt', async () => {
      const expectedHash = '$2b$12$uniquesaltuniquesaltuniquehashedresult';
      mockHash.mockResolvedValue(expectedHash);

      const { service } = buildService();
      const hash = await service.hashPassword('test-password');

      expect(hash).toBe(expectedHash);
    });
  });
});
