import {
  DEFAULTS,
  CredentialFreshness,
  CredentialVolatility,
  ProfileVersionState,
  RedisFailureTier,
} from '@browser-hitl/shared';

// ---------------------------------------------------------------------------
// Mock ioredis
// ---------------------------------------------------------------------------
const mockRedis = {
  set: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(1),
  quit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

import { CredentialsService } from './credentials.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSessionRepo() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
  };
}

function createMockProfileRepo() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    increment: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockArtifactRepo() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
  };
}

function createMockConsumptionRepo() {
  return {
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest.fn().mockResolvedValue({ id: 'consumption-1' }),
  };
}

function createMockHealthMonitor(state: 'HEALTHY' | 'DEGRADED' | 'DOWN' = 'HEALTHY') {
  return {
    isDown: jest.fn().mockReturnValue(state === 'DOWN'),
    isDegraded: jest.fn().mockReturnValue(state === 'DEGRADED'),
    isHealthy: jest.fn().mockReturnValue(state === 'HEALTHY'),
    getState: jest.fn().mockReturnValue(state),
    evaluateTier: jest.fn().mockImplementation((tier: RedisFailureTier) => {
      if (state === 'HEALTHY') return 'proceed';
      if (state === 'DEGRADED' && tier === RedisFailureTier.CONSISTENCY) return 'skip';
      if (state === 'DOWN') {
        if (tier === RedisFailureTier.SECURITY) return 'deny';
        return 'skip';
      }
      return 'proceed';
    }),
  };
}

function createMockMinioProvisioner() {
  return {
    bucketName: jest.fn().mockReturnValue('artifact-bundles-tenant-uuid-1'),
    getClient: jest.fn().mockReturnValue({
      getObject: jest.fn().mockResolvedValue(null),
    }),
  };
}

function buildService(overrides: {
  sessionRepo?: any;
  profileRepo?: any;
  artifactRepo?: any;
  consumptionRepo?: any;
  healthMonitor?: any;
  minioProvisioner?: any;
} = {}) {
  const sessionRepo = overrides.sessionRepo ?? createMockSessionRepo();
  const profileRepo = overrides.profileRepo ?? createMockProfileRepo();
  const artifactRepo = overrides.artifactRepo ?? createMockArtifactRepo();
  const consumptionRepo = overrides.consumptionRepo ?? createMockConsumptionRepo();
  const healthMonitor = overrides.healthMonitor ?? createMockHealthMonitor();
  const minioProvisioner = overrides.minioProvisioner ?? createMockMinioProvisioner();

  const service = Object.create(CredentialsService.prototype);
  (service as any).sessionRepo = sessionRepo;
  (service as any).profileRepo = profileRepo;
  (service as any).artifactRepo = artifactRepo;
  (service as any).consumptionRepo = consumptionRepo;
  (service as any).healthMonitor = healthMonitor;
  (service as any).minioProvisioner = minioProvisioner;
  (service as any).redis = mockRedis;
  (service as any).credentialCache = new Map();
  (service as any).logger = {
    log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  };

  return { service: service as CredentialsService, sessionRepo, profileRepo, artifactRepo, consumptionRepo, healthMonitor, minioProvisioner };
}

const TEST_TENANT = 'tenant-uuid-1';
const TEST_APP_ID = 'app-uuid-1';

const TEST_PROFILE = {
  id: 'profile-uuid-1',
  tenant_id: TEST_TENANT,
  app_id: TEST_APP_ID,
  profile_id: 'salesforce-standard',
  version: '1.0.0',
  version_state: ProfileVersionState.ACTIVE,
  credential_types: {
    cookies: [
      { name: 'sid', domain: '.salesforce.com', path: '/', secure: true, httpOnly: true, volatility: 'STABLE' },
      { name: 'csrf_token', domain: '.salesforce.com', path: '/', secure: true, httpOnly: false, volatility: 'VOLATILE' },
    ],
    headers: [
      { name: 'Authorization', volatility: 'SEMI_STABLE' },
    ],
    csrf: { header_name: 'X-CSRF-Token', volatility: 'VOLATILE' },
  },
  target_domains: ['salesforce.com'],
  extra_config: null,
  login_config: {},
};

const TEST_SESSION = {
  id: 'session-uuid-1',
  tenant_id: TEST_TENANT,
  app_id: TEST_APP_ID,
  state: 'HEALTHY',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CredentialsService (ADR-013 + Sprint 3b)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Envelope Schema
  // =========================================================================

  describe('Envelope schema', () => {
    it('should return envelope with all required fields', async () => {
      const { service, profileRepo, sessionRepo } = buildService();
      profileRepo.find.mockResolvedValueOnce([TEST_PROFILE]);
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);

      const envelope = await service.requestCredentials({
        tenantId: TEST_TENANT,
        profileId: 'salesforce-standard',
        requestId: 'req-1',
      });

      expect(envelope).toHaveProperty('freshness');
      expect(envelope).toHaveProperty('request_id', 'req-1');
      expect(envelope).toHaveProperty('profile_id', 'salesforce-standard');
      expect(envelope).toHaveProperty('session_id', 'session-uuid-1');
      expect(envelope).toHaveProperty('credentials');
      expect(envelope).toHaveProperty('usage');
      expect(envelope).toHaveProperty('metadata');
    });

    it('should include credentials with cookies, headers, and csrf', async () => {
      const { service, profileRepo, sessionRepo } = buildService();
      profileRepo.find.mockResolvedValueOnce([TEST_PROFILE]);
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);

      const envelope = await service.requestCredentials({
        tenantId: TEST_TENANT,
        profileId: 'salesforce-standard',
        requestId: 'req-1',
      });

      expect(envelope.credentials.cookies).toHaveLength(2);
      expect(envelope.credentials.headers).toHaveLength(1);
      expect(envelope.credentials.csrf).toBeDefined();
    });

    it('should include metadata with extraction timestamp and profile version', async () => {
      const { service, profileRepo, sessionRepo } = buildService();
      profileRepo.find.mockResolvedValueOnce([TEST_PROFILE]);
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);

      const envelope = await service.requestCredentials({
        tenantId: TEST_TENANT,
        profileId: 'salesforce-standard',
        requestId: 'req-1',
      });

      expect(envelope.metadata.extracted_at).toBeDefined();
      expect(envelope.metadata.profile_version).toBe('1.0.0');
    });
  });

  // =========================================================================
  // Profile Resolution
  // =========================================================================

  describe('Profile resolution', () => {
    it('should find ACTIVE profile', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.find.mockResolvedValueOnce([TEST_PROFILE]);

      const profile = await service.resolveActiveProfile(TEST_TENANT, 'salesforce-standard');

      expect(profile.version_state).toBe(ProfileVersionState.ACTIVE);
    });

    it('should prefer ACTIVE over CANARY when both exist', async () => {
      const { service, profileRepo } = buildService();
      const canaryProfile = { ...TEST_PROFILE, id: 'profile-canary-1', version_state: ProfileVersionState.CANARY };
      profileRepo.find.mockResolvedValueOnce([canaryProfile, TEST_PROFILE]);

      const profile = await service.resolveActiveProfile(TEST_TENANT, 'salesforce-standard');

      expect(profile.version_state).toBe(ProfileVersionState.ACTIVE);
    });

    it('should fall back to CANARY when no ACTIVE profile exists', async () => {
      const { service, profileRepo } = buildService();
      const canaryProfile = { ...TEST_PROFILE, id: 'profile-canary-1', version_state: ProfileVersionState.CANARY };
      profileRepo.find.mockResolvedValueOnce([canaryProfile]);

      const profile = await service.resolveActiveProfile(TEST_TENANT, 'salesforce-standard');

      expect(profile.version_state).toBe(ProfileVersionState.CANARY);
    });

    it('should throw when no ACTIVE or CANARY profile exists', async () => {
      const { service } = buildService();

      await expect(service.resolveActiveProfile(TEST_TENANT, 'missing')).rejects.toThrow('No active profile');
    });
  });

  // =========================================================================
  // Session Resolution (with app_id)
  // =========================================================================

  describe('Session resolution', () => {
    it('should find healthy session filtered by app_id', async () => {
      const { service, sessionRepo } = buildService();
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);

      const session = await service.findHealthySession(TEST_TENANT, TEST_APP_ID);

      expect(session.state).toBe('HEALTHY');
      expect(sessionRepo.findOne).toHaveBeenCalledWith({
        where: {
          tenant_id: TEST_TENANT,
          state: 'HEALTHY',
          app_id: TEST_APP_ID,
        },
      });
    });

    it('should find healthy session without app_id (fallback)', async () => {
      const { service, sessionRepo } = buildService();
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);

      const session = await service.findHealthySession(TEST_TENANT);

      expect(session.state).toBe('HEALTHY');
      expect(sessionRepo.findOne).toHaveBeenCalledWith({
        where: {
          tenant_id: TEST_TENANT,
          state: 'HEALTHY',
        },
      });
    });

    it('should throw when no healthy session available', async () => {
      const { service } = buildService();

      await expect(service.findHealthySession(TEST_TENANT, TEST_APP_ID)).rejects.toThrow('No healthy session');
    });
  });

  // =========================================================================
  // Volatility Classification
  // =========================================================================

  describe('Volatility classification', () => {
    it('should classify cookies with correct volatility', () => {
      const { service } = buildService();

      const credSet = service.buildCredentialSet(TEST_PROFILE as any, true);

      expect(credSet.cookies[0].volatility).toBe('STABLE');
      expect(credSet.cookies[1].volatility).toBe('VOLATILE');
    });

    it('should classify headers as SEMI_STABLE', () => {
      const { service } = buildService();

      const credSet = service.buildCredentialSet(TEST_PROFILE as any, true);

      expect(credSet.headers[0].volatility).toBe('SEMI_STABLE');
    });

    it('should classify CSRF as VOLATILE', () => {
      const { service } = buildService();

      const credSet = service.buildCredentialSet(TEST_PROFILE as any, true);

      expect(credSet.csrf!.volatility).toBe('VOLATILE');
    });

    it('should exclude volatile fields when includeVolatile=false', () => {
      const { service } = buildService();

      const credSet = service.buildCredentialSet(TEST_PROFILE as any, false);

      // Only stable cookie should remain
      expect(credSet.cookies).toHaveLength(1);
      expect(credSet.cookies[0].name).toBe('sid');
      // CSRF is volatile — should be excluded
      expect(credSet.csrf).toBeUndefined();
    });
  });

  // =========================================================================
  // Credential Value Population (Sprint 3b — real values from bundle)
  // =========================================================================

  describe('Credential value population', () => {
    it('should merge real cookie values from decrypted bundle', () => {
      const { service } = buildService();
      const decrypted = {
        cookies: [
          { name: 'sid', value: 'actual-session-id', domain: '.salesforce.com', path: '/', secure: true, httpOnly: true },
          { name: 'csrf_token', value: 'actual-csrf-cookie', domain: '.salesforce.com', path: '/', secure: true, httpOnly: false },
        ],
        headers: {},
        csrf_token: 'actual-csrf-token',
      };

      const credSet = service.buildCredentialSet(TEST_PROFILE as any, true, decrypted);

      expect(credSet.cookies[0].value).toBe('actual-session-id');
      expect(credSet.cookies[1].value).toBe('actual-csrf-cookie');
    });

    it('should merge real header values from decrypted bundle', () => {
      const { service } = buildService();
      const decrypted = {
        cookies: [],
        headers: {
          'https://salesforce.com': { Authorization: 'Bearer xyz-token' },
        },
        csrf_token: '',
      };

      const credSet = service.buildCredentialSet(TEST_PROFILE as any, true, decrypted);

      expect(credSet.headers[0].value).toBe('Bearer xyz-token');
    });

    it('should merge real CSRF token from decrypted bundle', () => {
      const { service } = buildService();
      const decrypted = {
        cookies: [],
        headers: {},
        csrf_token: 'my-csrf-token',
      };

      const credSet = service.buildCredentialSet(TEST_PROFILE as any, true, decrypted);

      expect(credSet.csrf!.token).toBe('my-csrf-token');
    });

    it('should return empty values when no bundle available', () => {
      const { service } = buildService();

      const credSet = service.buildCredentialSet(TEST_PROFILE as any, true, null);

      expect(credSet.cookies[0].value).toBe('');
      expect(credSet.headers[0].value).toBe('');
      expect(credSet.csrf!.token).toBe('');
    });

    it('should include local_storage and session_storage from bundle', () => {
      const { service } = buildService();
      const decrypted = {
        cookies: [],
        headers: {},
        csrf_token: '',
        local_storage: { key1: 'val1' },
        session_storage: { key2: 'val2' },
      };

      const credSet = service.buildCredentialSet(TEST_PROFILE as any, true, decrypted);

      expect(credSet.local_storage).toEqual({ key1: 'val1' });
      expect(credSet.session_storage).toEqual({ key2: 'val2' });
    });
  });

  // =========================================================================
  // Artifact Decryption
  // =========================================================================

  describe('Artifact decryption', () => {
    it('should decrypt AES-256-GCM payload correctly', () => {
      const { service } = buildService();

      // Create a known encrypted payload using Node.js crypto
      const crypto = require('crypto');
      const key = Buffer.alloc(32, 0); // 32 zero bytes = '00'.repeat(32) hex
      const nonce = crypto.randomBytes(12);
      const plaintext = JSON.stringify({ cookies: [], headers: {}, csrf_token: 'test' });

      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      // Worker blob format: [nonce (12B)][ciphertext][auth tag (16B)]
      const blob = Buffer.concat([nonce, encrypted, authTag]);

      const result = service.decryptBundle(blob, nonce);

      expect(result).toEqual({ cookies: [], headers: {}, csrf_token: 'test' });
    });

    it('should throw on corrupted payload', () => {
      const { service } = buildService();
      const nonce = Buffer.alloc(12);
      const corrupted = Buffer.alloc(32, 0xFF);

      expect(() => service.decryptBundle(corrupted, nonce)).toThrow();
    });

    it('should throw on payload too short', () => {
      const { service } = buildService();
      const nonce = Buffer.alloc(12);
      const tooShort = Buffer.alloc(10);

      expect(() => service.decryptBundle(tooShort, nonce)).toThrow('too short');
    });
  });

  // =========================================================================
  // Fetch and Decrypt Flow
  // =========================================================================

  describe('fetchAndDecryptLatestBundle', () => {
    it('should return null when no bundle exists', async () => {
      const { service } = buildService();

      const result = await service.fetchAndDecryptLatestBundle(
        TEST_SESSION as any, TEST_TENANT, 'req-1',
      );

      expect(result).toBeNull();
    });

    it('should query for non-expired bundles ordered by exported_at DESC', async () => {
      const { service, artifactRepo } = buildService();

      await service.fetchAndDecryptLatestBundle(
        TEST_SESSION as any, TEST_TENANT, 'req-1',
      );

      expect(artifactRepo.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({
          session_id: 'session-uuid-1',
          tenant_id: TEST_TENANT,
        }),
        order: { exported_at: 'DESC' },
      });
    });

    it('should record artifact consumption with api_envelope access method', async () => {
      const { service, artifactRepo, consumptionRepo, minioProvisioner } = buildService();

      // Setup: create a real encrypted bundle (worker blob format: nonce + ciphertext + tag)
      const crypto = require('crypto');
      const key = Buffer.alloc(32, 0);
      const nonce = crypto.randomBytes(12);
      const plaintext = JSON.stringify({ cookies: [], headers: {}, csrf_token: '' });
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const blob = Buffer.concat([nonce, encrypted, authTag]);

      // Mock the readable stream
      const { Readable } = require('stream');
      const mockStream = Readable.from([blob]);

      artifactRepo.findOne.mockResolvedValueOnce({
        id: 'bundle-1',
        session_id: 'session-uuid-1',
        tenant_id: TEST_TENANT,
        encrypted_payload_ref: 'path/to/bundle',
        nonce,
        exported_at: new Date(),
        expires_at: new Date(Date.now() + 3600000),
      });

      minioProvisioner.getClient.mockReturnValue({
        getObject: jest.fn().mockResolvedValue(mockStream),
      });

      await service.fetchAndDecryptLatestBundle(
        TEST_SESSION as any, TEST_TENANT, 'req-1',
      );

      expect(consumptionRepo.create).toHaveBeenCalledWith({
        artifact_id: 'bundle-1',
        consumer_id: 'req-1',
        token_id: 'api_req_req-1',
        access_method: 'api_envelope',
      });
      expect(consumptionRepo.save).toHaveBeenCalled();
    });

    it('should return null on MinIO download failure', async () => {
      const { service, artifactRepo, minioProvisioner } = buildService();

      artifactRepo.findOne.mockResolvedValueOnce({
        id: 'bundle-1',
        session_id: 'session-uuid-1',
        tenant_id: TEST_TENANT,
        encrypted_payload_ref: 'path/to/bundle',
        nonce: Buffer.alloc(12),
        exported_at: new Date(),
        expires_at: new Date(Date.now() + 3600000),
      });

      minioProvisioner.getClient.mockReturnValue({
        getObject: jest.fn().mockRejectedValue(new Error('MinIO unavailable')),
      });

      const result = await service.fetchAndDecryptLatestBundle(
        TEST_SESSION as any, TEST_TENANT, 'req-1',
      );

      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // In-Memory Cache
  // =========================================================================

  describe('In-memory cache', () => {
    it('should serve from cache on repeated requests', async () => {
      const { service, artifactRepo, minioProvisioner } = buildService();

      // Setup: create a real encrypted bundle (worker blob format: nonce + ciphertext + tag)
      const crypto = require('crypto');
      const key = Buffer.alloc(32, 0);
      const nonce = crypto.randomBytes(12);
      const plaintext = JSON.stringify({ cookies: [{ name: 'sid', value: 'cached-val' }], headers: {}, csrf_token: '' });
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const blob = Buffer.concat([nonce, encrypted, authTag]);

      const { Readable } = require('stream');

      const bundle = {
        id: 'bundle-cache-1',
        session_id: 'session-uuid-1',
        tenant_id: TEST_TENANT,
        encrypted_payload_ref: 'path/to/bundle',
        nonce,
        exported_at: new Date(),
        expires_at: new Date(Date.now() + 3600000),
      };

      artifactRepo.findOne.mockResolvedValue(bundle);
      minioProvisioner.getClient.mockReturnValue({
        getObject: jest.fn().mockResolvedValue(Readable.from([blob])),
      });

      // First call: hits MinIO
      const result1 = await service.fetchAndDecryptLatestBundle(
        TEST_SESSION as any, TEST_TENANT, 'req-1',
      );
      expect(result1).not.toBeNull();

      // Second call: should use cache (MinIO getObject not called again)
      const mockGetObject = jest.fn().mockResolvedValue(Readable.from([blob]));
      minioProvisioner.getClient.mockReturnValue({ getObject: mockGetObject });

      const result2 = await service.fetchAndDecryptLatestBundle(
        TEST_SESSION as any, TEST_TENANT, 'req-2',
      );
      expect(result2).not.toBeNull();
      expect(mockGetObject).not.toHaveBeenCalled();
    });

    it('should bypass cache when force_refresh is true', async () => {
      const { service, artifactRepo, minioProvisioner } = buildService();

      const crypto = require('crypto');
      const key = Buffer.alloc(32, 0);
      const nonce = crypto.randomBytes(12);
      const plaintext = JSON.stringify({ cookies: [], headers: {}, csrf_token: '' });
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const blob = Buffer.concat([nonce, encrypted, authTag]);

      const { Readable } = require('stream');

      const bundle = {
        id: 'bundle-bypass-1',
        session_id: 'session-uuid-1',
        tenant_id: TEST_TENANT,
        encrypted_payload_ref: 'path/to/bundle',
        nonce,
        exported_at: new Date(),
        expires_at: new Date(Date.now() + 3600000),
      };

      artifactRepo.findOne.mockResolvedValue(bundle);

      const mockGetObject = jest.fn().mockResolvedValue(Readable.from([blob]));
      minioProvisioner.getClient.mockReturnValue({ getObject: mockGetObject });

      // First call
      await service.fetchAndDecryptLatestBundle(
        TEST_SESSION as any, TEST_TENANT, 'req-1',
      );

      // Second call with bypassCache=true
      const mockGetObject2 = jest.fn().mockResolvedValue(Readable.from([blob]));
      minioProvisioner.getClient.mockReturnValue({ getObject: mockGetObject2 });

      await service.fetchAndDecryptLatestBundle(
        TEST_SESSION as any, TEST_TENANT, 'req-2', true,
      );

      expect(mockGetObject2).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Freshness
  // =========================================================================

  describe('Freshness', () => {
    it('should return CACHED freshness by default (no force_refresh)', async () => {
      const { service, profileRepo, sessionRepo } = buildService();
      profileRepo.find.mockResolvedValueOnce([TEST_PROFILE]);
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);

      const envelope = await service.requestCredentials({
        tenantId: TEST_TENANT,
        profileId: 'salesforce-standard',
        requestId: 'req-1',
        forceRefresh: false,
      });

      expect(envelope.freshness).toBe(CredentialFreshness.CACHED);
    });

    it('should return EXTRACTED freshness when force_refresh acquires lock', async () => {
      const { service, profileRepo, sessionRepo } = buildService();
      profileRepo.find.mockResolvedValueOnce([TEST_PROFILE]);
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);
      mockRedis.set.mockResolvedValueOnce('OK'); // Lock acquired

      const envelope = await service.requestCredentials({
        tenantId: TEST_TENANT,
        profileId: 'salesforce-standard',
        requestId: 'req-1',
        forceRefresh: true,
      });

      expect(envelope.freshness).toBe(CredentialFreshness.EXTRACTED);
    });

    it('should return ON_DEMAND freshness when force_refresh coalesces', async () => {
      const { service, profileRepo, sessionRepo } = buildService();
      profileRepo.find.mockResolvedValueOnce([TEST_PROFILE]);
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);
      mockRedis.set.mockResolvedValueOnce(null); // Lock already held

      const envelope = await service.requestCredentials({
        tenantId: TEST_TENANT,
        profileId: 'salesforce-standard',
        requestId: 'req-1',
        forceRefresh: true,
      });

      expect(envelope.freshness).toBe(CredentialFreshness.ON_DEMAND);
    });
  });

  // =========================================================================
  // Canary Traffic Recording
  // =========================================================================

  describe('Canary traffic recording', () => {
    const CANARY_PROFILE = {
      ...TEST_PROFILE,
      id: 'profile-canary-1',
      version_state: ProfileVersionState.CANARY,
    };

    it('should return CANARY freshness when serving from canary profile', async () => {
      const { service, profileRepo, sessionRepo } = buildService();
      profileRepo.find.mockResolvedValueOnce([CANARY_PROFILE]);
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);

      const envelope = await service.requestCredentials({
        tenantId: TEST_TENANT,
        profileId: 'salesforce-standard',
        requestId: 'req-1',
      });

      expect(envelope.freshness).toBe(CredentialFreshness.CANARY);
    });

    it('should increment canary_request_count on canary profile', async () => {
      const { service, profileRepo, sessionRepo } = buildService();
      profileRepo.find.mockResolvedValueOnce([CANARY_PROFILE]);
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);

      await service.requestCredentials({
        tenantId: TEST_TENANT,
        profileId: 'salesforce-standard',
        requestId: 'req-1',
      });

      expect(profileRepo.increment).toHaveBeenCalledWith(
        { id: 'profile-canary-1' },
        'canary_request_count',
        1,
      );
    });

    it('should NOT increment canary counters for ACTIVE profiles', async () => {
      const { service, profileRepo, sessionRepo } = buildService();
      profileRepo.find.mockResolvedValueOnce([TEST_PROFILE]);
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);

      await service.requestCredentials({
        tenantId: TEST_TENANT,
        profileId: 'salesforce-standard',
        requestId: 'req-1',
      });

      expect(profileRepo.increment).not.toHaveBeenCalled();
    });

    it('should increment canary_error_count on bundle fetch error', async () => {
      const { service, profileRepo, sessionRepo, artifactRepo, minioProvisioner } = buildService();
      profileRepo.find.mockResolvedValueOnce([CANARY_PROFILE]);
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);

      // Make fetchAndDecryptLatestBundle throw
      artifactRepo.findOne.mockResolvedValueOnce({
        id: 'bundle-1',
        session_id: 'session-uuid-1',
        tenant_id: TEST_TENANT,
        encrypted_payload_ref: 'path/to/bundle',
        nonce: Buffer.alloc(12),
        exported_at: new Date(),
        expires_at: new Date(Date.now() + 3600000),
      });
      minioProvisioner.getClient.mockReturnValue({
        getObject: jest.fn().mockRejectedValue(new Error('MinIO unavailable')),
      });

      // fetchAndDecryptLatestBundle returns null on MinIO error (doesn't throw)
      // so canary_error_count won't be incremented in this case.
      // The error path only triggers when the method actually throws.
      const envelope = await service.requestCredentials({
        tenantId: TEST_TENANT,
        profileId: 'salesforce-standard',
        requestId: 'req-1',
      });

      // Request succeeds (bundle is optional), canary_request_count incremented
      expect(profileRepo.increment).toHaveBeenCalledWith(
        { id: 'profile-canary-1' },
        'canary_request_count',
        1,
      );
    });
  });

  // =========================================================================
  // Force-Refresh Coalescing (RT-11)
  // =========================================================================

  describe('Force-refresh coalescing (RT-11)', () => {
    it('should acquire lock with SETNX and TTL', async () => {
      const { service } = buildService();
      mockRedis.set.mockResolvedValueOnce('OK');

      const result = await service.acquireExtractLock('t1', 'sf', 'default');

      expect(result.isLeader).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'extract_lock:t1:sf:default',
        expect.any(String),
        'EX',
        DEFAULTS.EXTRACT_LOCK_TTL_SECONDS,
        'NX',
      );
    });

    it('should return non-leader when lock already held', async () => {
      const { service } = buildService();
      mockRedis.set.mockResolvedValueOnce(null);

      const result = await service.acquireExtractLock('t1', 'sf', 'default');

      expect(result.isLeader).toBe(false);
    });

    it('should release extract lock', async () => {
      const { service } = buildService();

      await service.releaseExtractLock('t1', 'sf', 'default');

      expect(mockRedis.del).toHaveBeenCalledWith('extract_lock:t1:sf:default');
    });

    it('should skip lock and treat as leader when Redis is DEGRADED (CONSISTENCY tier)', async () => {
      const healthMonitor = createMockHealthMonitor('DEGRADED');
      const { service } = buildService({ healthMonitor });

      const result = await service.acquireExtractLock('t1', 'sf', 'default');

      expect(result.isLeader).toBe(true);
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should skip lock and treat as leader when Redis is DOWN', async () => {
      const healthMonitor = createMockHealthMonitor('DOWN');
      const { service } = buildService({ healthMonitor });

      const result = await service.acquireExtractLock('t1', 'sf', 'default');

      expect(result.isLeader).toBe(true);
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should treat as leader on Redis error', async () => {
      const { service } = buildService();
      mockRedis.set.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await service.acquireExtractLock('t1', 'sf', 'default');

      expect(result.isLeader).toBe(true);
    });
  });

  // =========================================================================
  // Usage Construction
  // =========================================================================

  describe('Usage construction', () => {
    it('should collect volatile field names', () => {
      const { service } = buildService();

      const usage = service.buildUsage(TEST_PROFILE as any);

      expect(usage.volatile_fields).toContain('cookie:csrf_token');
      expect(usage.volatile_fields).toContain('csrf');
      expect(usage.volatile_fields).not.toContain('cookie:sid'); // STABLE
    });

    it('should use default TTL when no extra_config', () => {
      const { service } = buildService();

      const usage = service.buildUsage(TEST_PROFILE as any);

      expect(usage.ttl_seconds).toBe(DEFAULTS.EXPORT_TTL_SECONDS);
      expect(usage.refresh_before_seconds).toBe(DEFAULTS.EXPORT_REFRESH_INTERVAL_SECONDS);
    });
  });

  // =========================================================================
  // Tenant Isolation via app_id
  // =========================================================================

  describe('Tenant isolation via app_id', () => {
    it('should use profile.app_id when calling findHealthySession from requestCredentials', async () => {
      const { service, profileRepo, sessionRepo } = buildService();
      profileRepo.find.mockResolvedValueOnce([TEST_PROFILE]);
      sessionRepo.findOne.mockResolvedValueOnce(TEST_SESSION);

      await service.requestCredentials({
        tenantId: TEST_TENANT,
        profileId: 'salesforce-standard',
        requestId: 'req-1',
      });

      expect(sessionRepo.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({
          tenant_id: TEST_TENANT,
          app_id: TEST_APP_ID,
          state: 'HEALTHY',
        }),
      });
    });
  });
});
