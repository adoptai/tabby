import { UnauthorizedException } from '@nestjs/common';
import { DEFAULTS, PASSWORD_RULES } from '@browser-hitl/shared';

/**
 * Adversarial tests for account lockout + password complexity (C2 remediation).
 *
 * These tests verify:
 * 1. Account locks after N consecutive failed logins
 * 2. Locked accounts cannot log in even with correct password
 * 3. Lock expires after configured duration
 * 4. Successful login resets the failed count
 * 5. PASSWORD_RULES pattern rejects weak passwords
 * 6. Source code enforces lockout and password complexity
 */

const mockCompare = jest.fn();
const mockHash = jest.fn();

jest.mock('bcryptjs', () => ({
  compare: (...args: any[]) => mockCompare(...args),
  hash: (...args: any[]) => mockHash(...args),
}));

import { AuthService } from './auth.service';

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
    verify: jest.fn(),
  };
}

function buildService(overrides: { userRepo?: any; jwtService?: any } = {}) {
  const userRepo = overrides.userRepo ?? createMockUserRepo();
  const jwtService = overrides.jwtService ?? createMockJwtService();

  const service = Object.create(AuthService.prototype);
  (service as any).userRepo = userRepo;
  (service as any).jwtService = jwtService;
  return { service: service as AuthService, userRepo, jwtService };
}

// ---------------------------------------------------------------------------
// Account lockout tests
// ---------------------------------------------------------------------------

describe('Account Lockout (C2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCompare.mockResolvedValue(false);
    mockHash.mockResolvedValue('$2b$12$hash');
  });

  it('increments failed_login_count on wrong password', async () => {
    const user = {
      id: 'user-1',
      tenant_id: 'tenant-1',
      email: 'user@example.com',
      password_hash: '$2b$12$hash',
      role: 'Admin',
      status: 'ACTIVE',
      failed_login_count: 0,
      locked_until: null,
    };
    const userRepo = createMockUserRepo(user);
    const { service } = buildService({ userRepo });

    await expect(
      service.validateUser('user@example.com', 'wrong'),
    ).rejects.toThrow(UnauthorizedException);

    expect(userRepo.update).toHaveBeenCalledWith('user-1', expect.objectContaining({
      failed_login_count: 1,
    }));
  });

  it('locks account after ACCOUNT_LOCKOUT_THRESHOLD consecutive failures', async () => {
    const user = {
      id: 'user-1',
      tenant_id: 'tenant-1',
      email: 'user@example.com',
      password_hash: '$2b$12$hash',
      role: 'Admin',
      status: 'ACTIVE',
      failed_login_count: DEFAULTS.ACCOUNT_LOCKOUT_THRESHOLD - 1, // One more failure = lock
      locked_until: null,
    };
    const userRepo = createMockUserRepo(user);
    const { service } = buildService({ userRepo });

    await expect(
      service.validateUser('user@example.com', 'wrong'),
    ).rejects.toThrow(UnauthorizedException);

    expect(userRepo.update).toHaveBeenCalledWith('user-1', expect.objectContaining({
      failed_login_count: DEFAULTS.ACCOUNT_LOCKOUT_THRESHOLD,
      locked_until: expect.any(Date),
    }));

    // Verify lock duration is approximately ACCOUNT_LOCKOUT_DURATION_MINUTES
    const updateCall = userRepo.update.mock.calls[0][1];
    const lockExpiry = updateCall.locked_until.getTime();
    const expectedExpiry = Date.now() + DEFAULTS.ACCOUNT_LOCKOUT_DURATION_MINUTES * 60000;
    expect(lockExpiry).toBeGreaterThan(expectedExpiry - 5000);
    expect(lockExpiry).toBeLessThanOrEqual(expectedExpiry + 1000);
  });

  it('rejects login for a currently locked account', async () => {
    const user = {
      id: 'user-1',
      tenant_id: 'tenant-1',
      email: 'user@example.com',
      password_hash: '$2b$12$hash',
      role: 'Admin',
      status: 'ACTIVE',
      failed_login_count: 5,
      locked_until: new Date(Date.now() + 600000), // Locked for 10 more minutes
    };
    const userRepo = createMockUserRepo(user);
    const { service } = buildService({ userRepo });

    mockCompare.mockResolvedValue(true); // Even with correct password!

    await expect(
      service.validateUser('user@example.com', 'correct-password'),
    ).rejects.toThrow(/Account is locked/);

    // Should NOT even check the password
    expect(mockCompare).not.toHaveBeenCalled();
  });

  it('allows login after lock period expires', async () => {
    mockCompare.mockResolvedValue(true);

    const user = {
      id: 'user-1',
      tenant_id: 'tenant-1',
      email: 'user@example.com',
      password_hash: '$2b$12$hash',
      role: 'Admin',
      status: 'ACTIVE',
      failed_login_count: 5,
      locked_until: new Date(Date.now() - 1000), // Lock expired 1 second ago
    };
    const userRepo = createMockUserRepo(user);
    const { service } = buildService({ userRepo });

    const result = await service.validateUser('user@example.com', 'correct-password');
    expect(result).toBe(user);
  });

  it('resets failed_login_count on successful login', async () => {
    mockCompare.mockResolvedValue(true);

    const user = {
      id: 'user-1',
      tenant_id: 'tenant-1',
      email: 'user@example.com',
      password_hash: '$2b$12$hash',
      role: 'Admin',
      status: 'ACTIVE',
      failed_login_count: 3,
      locked_until: null,
    };
    const userRepo = createMockUserRepo(user);
    const { service } = buildService({ userRepo });

    await service.validateUser('user@example.com', 'correct-password');

    expect(userRepo.update).toHaveBeenCalledWith('user-1', expect.objectContaining({
      failed_login_count: 0,
      locked_until: null,
    }));
  });

  it('does not update DB when failed_login_count is already 0 on successful login', async () => {
    mockCompare.mockResolvedValue(true);

    const user = {
      id: 'user-1',
      tenant_id: 'tenant-1',
      email: 'user@example.com',
      password_hash: '$2b$12$hash',
      role: 'Admin',
      status: 'ACTIVE',
      failed_login_count: 0,
      locked_until: null,
    };
    const userRepo = createMockUserRepo(user);
    const { service } = buildService({ userRepo });

    await service.validateUser('user@example.com', 'correct-password');

    // No unnecessary DB update
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it('lock message includes remaining minutes', async () => {
    const user = {
      id: 'user-1',
      tenant_id: 'tenant-1',
      email: 'user@example.com',
      password_hash: '$2b$12$hash',
      role: 'Admin',
      status: 'ACTIVE',
      failed_login_count: 5,
      locked_until: new Date(Date.now() + 5 * 60000), // 5 minutes left
    };
    const userRepo = createMockUserRepo(user);
    const { service } = buildService({ userRepo });

    await expect(
      service.validateUser('user@example.com', 'any'),
    ).rejects.toThrow(/5 minute/);
  });
});

// ---------------------------------------------------------------------------
// Password complexity tests
// ---------------------------------------------------------------------------

describe('Password Complexity (C2)', () => {
  it('PASSWORD_RULES.PATTERN accepts a strong password', () => {
    expect(PASSWORD_RULES.PATTERN.test('MyStr0ng!Pass')).toBe(true);
  });

  it('PASSWORD_RULES.PATTERN rejects password without uppercase', () => {
    expect(PASSWORD_RULES.PATTERN.test('mystr0ng!pass')).toBe(false);
  });

  it('PASSWORD_RULES.PATTERN rejects password without lowercase', () => {
    expect(PASSWORD_RULES.PATTERN.test('MYSTR0NG!PASS')).toBe(false);
  });

  it('PASSWORD_RULES.PATTERN rejects password without digit', () => {
    expect(PASSWORD_RULES.PATTERN.test('MyStrong!Pass!')).toBe(false);
  });

  it('PASSWORD_RULES.PATTERN rejects password without special character', () => {
    expect(PASSWORD_RULES.PATTERN.test('MyStr0ngPasswd')).toBe(false);
  });

  it('PASSWORD_RULES.PATTERN rejects short password (< 12 chars)', () => {
    expect(PASSWORD_RULES.PATTERN.test('MyS1r!ng')).toBe(false);
  });

  it('ACCOUNT_LOCKOUT_THRESHOLD constant is 5', () => {
    expect(DEFAULTS.ACCOUNT_LOCKOUT_THRESHOLD).toBe(5);
  });

  it('ACCOUNT_LOCKOUT_DURATION_MINUTES constant is 15', () => {
    expect(DEFAULTS.ACCOUNT_LOCKOUT_DURATION_MINUTES).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Source verification (anti-regression)
// ---------------------------------------------------------------------------

describe('C2 source verification', () => {
  it('auth.service.ts checks locked_until before password comparison', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'auth.service.ts'),
      'utf-8',
    );
    expect(source).toContain('locked_until');
    expect(source).toContain('Account is locked');
    expect(source).toContain('failed_login_count');
  });

  it('users.service.ts validates password against PASSWORD_RULES', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'users', 'users.service.ts'),
      'utf-8',
    );
    expect(source).toContain('PASSWORD_RULES');
    expect(source).toContain('PASSWORD_RULES.PATTERN');
  });

  it('user entity has failed_login_count and locked_until columns', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'entities', 'user.entity.ts'),
      'utf-8',
    );
    expect(source).toContain('failed_login_count');
    expect(source).toContain('locked_until');
  });
});
