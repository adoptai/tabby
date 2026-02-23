import { DEFAULTS, ProfileVersionState, isValidProfileTransition, PROFILE_VERSION_TRANSITIONS } from '@browser-hitl/shared';
import { ProfilesService } from './profiles.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProfileRepo() {
  return {
    create: jest.fn().mockImplementation((data: any) => ({ id: 'profile-uuid-1', ...data, created_at: new Date(), updated_at: new Date() })),
    save: jest.fn().mockImplementation((data: any) => Promise.resolve({ ...data, id: data.id || 'profile-uuid-1' })),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    increment: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function createMockAppRepo() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
  };
}

function createMockDataSource() {
  return {
    transaction: jest.fn().mockImplementation(async (fn: any) => {
      const manager = {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        save: jest.fn().mockImplementation((data: any) => Promise.resolve(data)),
        findOne: jest.fn().mockResolvedValue(null),
      };
      return fn(manager);
    }),
  };
}

function createMockAuditService() {
  return {
    log: jest.fn().mockResolvedValue({ id: 'audit-1' }),
  };
}

function buildService(overrides: {
  profileRepo?: any;
  appRepo?: any;
  dataSource?: any;
  auditService?: any;
} = {}) {
  const profileRepo = overrides.profileRepo ?? createMockProfileRepo();
  const appRepo = overrides.appRepo ?? createMockAppRepo();
  const dataSource = overrides.dataSource ?? createMockDataSource();
  const auditService = overrides.auditService ?? createMockAuditService();

  // Default: appRepo returns a valid application belonging to TEST_TENANT
  if (!overrides.appRepo) {
    appRepo.findOne.mockResolvedValue({
      id: 'app-uuid-1',
      tenant_id: 'tenant-uuid-1',
      name: 'Salesforce Prod',
    });
  }

  const service = Object.create(ProfilesService.prototype);
  (service as any).profileRepo = profileRepo;
  (service as any).appRepo = appRepo;
  (service as any).dataSource = dataSource;
  (service as any).auditService = auditService;
  (service as any).logger = {
    log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  };

  return { service: service as ProfilesService, profileRepo, appRepo, dataSource, auditService };
}

const TEST_TENANT = 'tenant-uuid-1';
const TEST_ACTOR = 'user-uuid-1';
const TEST_APP_ID = 'app-uuid-1';

const TEST_DTO = {
  profile_id: 'salesforce-standard',
  app_id: TEST_APP_ID,
  version: '1.0.0',
  login_config: { steps: ['navigate', 'fill', 'submit'] },
  credential_types: {
    cookies: [{ name: 'sid', volatility: 'STABLE' }],
    headers: [{ name: 'Authorization', volatility: 'SEMI_STABLE' }],
    csrf: { header_name: 'X-CSRF-Token', volatility: 'VOLATILE' },
  },
  target_domains: ['salesforce.com'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfilesService (ADR-014)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Create
  // =========================================================================

  describe('create', () => {
    it('should create a profile in STAGING state', async () => {
      const { service, profileRepo } = buildService();

      const result = await service.create(TEST_DTO, TEST_TENANT, TEST_ACTOR);

      expect(profileRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        tenant_id: TEST_TENANT,
        profile_id: 'salesforce-standard',
        version: '1.0.0',
        version_state: ProfileVersionState.STAGING,
      }));
      expect(profileRepo.save).toHaveBeenCalled();
      expect(result.version_state).toBe(ProfileVersionState.STAGING);
    });

    it('should validate tenant isolation', async () => {
      const { service, profileRepo } = buildService();

      await service.create(TEST_DTO, TEST_TENANT, TEST_ACTOR);

      expect(profileRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        tenant_id: TEST_TENANT,
      }));
    });

    it('should set parent_version_id when provided', async () => {
      const { service, profileRepo } = buildService();
      const dto = { ...TEST_DTO, parent_version_id: 'parent-uuid' };

      await service.create(dto, TEST_TENANT, TEST_ACTOR);

      expect(profileRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        parent_version_id: 'parent-uuid',
      }));
    });

    it('should create audit log on profile creation', async () => {
      const { service, auditService } = buildService();

      await service.create(TEST_DTO, TEST_TENANT, TEST_ACTOR);

      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({
        tenant_id: TEST_TENANT,
        actor_type: 'human',
        actor_id: TEST_ACTOR,
        event_type: 'profile.created',
      }));
    });

    it('should reject duplicate version via repository error', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.save.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));

      await expect(service.create(TEST_DTO, TEST_TENANT, TEST_ACTOR)).rejects.toThrow('duplicate key');
    });

    it('should set app_id on the created profile', async () => {
      const { service, profileRepo } = buildService();

      await service.create(TEST_DTO, TEST_TENANT, TEST_ACTOR);

      expect(profileRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        app_id: TEST_APP_ID,
      }));
    });

    it('should reject when application does not exist', async () => {
      const appRepo = createMockAppRepo();
      appRepo.findOne.mockResolvedValueOnce(null);
      const { service } = buildService({ appRepo });

      await expect(service.create(TEST_DTO, TEST_TENANT, TEST_ACTOR)).rejects.toThrow(
        'Application app-uuid-1 not found',
      );
    });

    it('should reject when application belongs to a different tenant (cross-tenant)', async () => {
      const appRepo = createMockAppRepo();
      appRepo.findOne.mockResolvedValueOnce({
        id: TEST_APP_ID,
        tenant_id: 'other-tenant-uuid',
        name: 'Other Tenant App',
      });
      const { service } = buildService({ appRepo });

      await expect(service.create(TEST_DTO, TEST_TENANT, TEST_ACTOR)).rejects.toThrow(
        'Application does not belong to your tenant',
      );
    });
  });

  // =========================================================================
  // findAll / findOne
  // =========================================================================

  describe('findAll', () => {
    it('should return paginated profiles for tenant', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.find.mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }]);

      const result = await service.findAll(TEST_TENANT, 10, 0);

      expect(result).toHaveLength(2);
      expect(profileRepo.find).toHaveBeenCalledWith(expect.objectContaining({
        where: { tenant_id: TEST_TENANT },
        take: 10,
        skip: 0,
      }));
    });
  });

  describe('findOne', () => {
    it('should return profile by id and tenant', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({ id: 'p1', tenant_id: TEST_TENANT });

      const result = await service.findOne('p1', TEST_TENANT);

      expect(result.id).toBe('p1');
    });

    it('should throw NotFoundException when profile not found', async () => {
      const { service } = buildService();

      await expect(service.findOne('missing', TEST_TENANT)).rejects.toThrow('not found');
    });
  });

  // =========================================================================
  // Promote: STAGING → CANARY
  // =========================================================================

  describe('promote: STAGING → CANARY', () => {
    it('should transition from STAGING to CANARY', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({
        id: 'p1', tenant_id: TEST_TENANT, profile_id: 'sf',
        version_state: ProfileVersionState.STAGING,
        canary_request_count: 0, canary_error_count: 0,
      });

      const result = await service.promote('p1', TEST_TENANT, TEST_ACTOR);

      expect(result.version_state).toBe(ProfileVersionState.CANARY);
      expect(profileRepo.save).toHaveBeenCalled();
    });

    it('should set promoted_at timestamp', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({
        id: 'p1', tenant_id: TEST_TENANT, profile_id: 'sf',
        version_state: ProfileVersionState.STAGING,
      });

      const result = await service.promote('p1', TEST_TENANT, TEST_ACTOR);

      expect(result.promoted_at).toBeInstanceOf(Date);
    });
  });

  // =========================================================================
  // Promote: CANARY → ACTIVE
  // =========================================================================

  describe('promote: CANARY → ACTIVE', () => {
    it('should transition from CANARY to ACTIVE with sufficient traffic', async () => {
      const { service, profileRepo, dataSource } = buildService();
      const profile = {
        id: 'p1', tenant_id: TEST_TENANT, profile_id: 'sf',
        version_state: ProfileVersionState.CANARY,
        canary_request_count: 10, canary_error_count: 0,
        version: '1.0.0',
      };
      profileRepo.findOne.mockResolvedValueOnce(profile);

      const result = await service.promote('p1', TEST_TENANT, TEST_ACTOR);

      expect(result.version_state).toBe(ProfileVersionState.ACTIVE);
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it('should reject when canary traffic below minimum', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({
        id: 'p1', tenant_id: TEST_TENANT, profile_id: 'sf',
        version_state: ProfileVersionState.CANARY,
        canary_request_count: 2, canary_error_count: 0,
      });

      await expect(service.promote('p1', TEST_TENANT, TEST_ACTOR)).rejects.toThrow(
        `at least ${DEFAULTS.CANARY_MIN_REQUESTS} requests`,
      );
    });

    it('should reject when canary error rate exceeds threshold', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({
        id: 'p1', tenant_id: TEST_TENANT, profile_id: 'sf',
        version_state: ProfileVersionState.CANARY,
        canary_request_count: 10, canary_error_count: 5, // 50% error rate
      });

      await expect(service.promote('p1', TEST_TENANT, TEST_ACTOR)).rejects.toThrow('error rate too high');
    });

    it('should retire previous ACTIVE version in transaction', async () => {
      const { service, profileRepo, dataSource } = buildService();
      const profile = {
        id: 'p1', tenant_id: TEST_TENANT, profile_id: 'sf',
        version_state: ProfileVersionState.CANARY,
        canary_request_count: 10, canary_error_count: 0,
        version: '2.0.0',
      };
      profileRepo.findOne.mockResolvedValueOnce(profile);

      const txManager = {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        save: jest.fn().mockImplementation((data: any) => Promise.resolve(data)),
      };
      dataSource.transaction.mockImplementation(async (fn: any) => fn(txManager));

      await service.promote('p1', TEST_TENANT, TEST_ACTOR);

      // Verify old ACTIVE was retired
      expect(txManager.update).toHaveBeenCalledWith(
        expect.anything(), // ServiceProfileEntity class
        expect.objectContaining({
          tenant_id: TEST_TENANT,
          profile_id: 'sf',
          version_state: ProfileVersionState.ACTIVE,
        }),
        expect.objectContaining({
          version_state: ProfileVersionState.RETIRED,
        }),
      );
    });
  });

  // =========================================================================
  // Promote: Invalid States
  // =========================================================================

  describe('promote: invalid states', () => {
    it('should reject promotion from ACTIVE', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({
        id: 'p1', tenant_id: TEST_TENANT,
        version_state: ProfileVersionState.ACTIVE,
      });

      await expect(service.promote('p1', TEST_TENANT, TEST_ACTOR)).rejects.toThrow(
        'Cannot promote from ACTIVE',
      );
    });

    it('should reject promotion from RETIRED', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({
        id: 'p1', tenant_id: TEST_TENANT,
        version_state: ProfileVersionState.RETIRED,
      });

      await expect(service.promote('p1', TEST_TENANT, TEST_ACTOR)).rejects.toThrow(
        'Cannot promote from RETIRED',
      );
    });
  });

  // =========================================================================
  // Rollback: CANARY → STAGING
  // =========================================================================

  describe('rollback: CANARY → STAGING', () => {
    it('should reset counters on CANARY rollback', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({
        id: 'p1', tenant_id: TEST_TENANT, profile_id: 'sf',
        version_state: ProfileVersionState.CANARY,
        canary_request_count: 10, canary_error_count: 3,
      });

      const result = await service.rollback('p1', TEST_TENANT, TEST_ACTOR);

      expect(result.version_state).toBe(ProfileVersionState.STAGING);
      expect(result.canary_request_count).toBe(0);
      expect(result.canary_error_count).toBe(0);
    });
  });

  // =========================================================================
  // Rollback: ACTIVE → Parent
  // =========================================================================

  describe('rollback: ACTIVE → parent', () => {
    it('should retire ACTIVE and reactivate parent', async () => {
      const { service, profileRepo, dataSource } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({
        id: 'p2', tenant_id: TEST_TENANT, profile_id: 'sf',
        version_state: ProfileVersionState.ACTIVE,
        parent_version_id: 'p1',
      });

      const parentProfile = {
        id: 'p1', tenant_id: TEST_TENANT, profile_id: 'sf',
        version_state: ProfileVersionState.RETIRED,
      };

      const txManager = {
        save: jest.fn().mockImplementation((data: any) => Promise.resolve(data)),
        findOne: jest.fn().mockResolvedValue(parentProfile),
      };
      dataSource.transaction.mockImplementation(async (fn: any) => fn(txManager));

      const result = await service.rollback('p2', TEST_TENANT, TEST_ACTOR);

      expect(result.version_state).toBe(ProfileVersionState.RETIRED);
      expect(parentProfile.version_state).toBe(ProfileVersionState.ACTIVE);
    });

    it('should reject rollback when no parent_version_id', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({
        id: 'p1', tenant_id: TEST_TENANT,
        version_state: ProfileVersionState.ACTIVE,
        parent_version_id: null,
      });

      await expect(service.rollback('p1', TEST_TENANT, TEST_ACTOR)).rejects.toThrow(
        'without parent_version_id',
      );
    });
  });

  // =========================================================================
  // Rollback: Invalid States
  // =========================================================================

  describe('rollback: invalid states', () => {
    it('should reject rollback from STAGING', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({
        id: 'p1', tenant_id: TEST_TENANT,
        version_state: ProfileVersionState.STAGING,
      });

      await expect(service.rollback('p1', TEST_TENANT, TEST_ACTOR)).rejects.toThrow(
        'Cannot rollback from STAGING',
      );
    });

    it('should reject rollback from RETIRED', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({
        id: 'p1', tenant_id: TEST_TENANT,
        version_state: ProfileVersionState.RETIRED,
      });

      await expect(service.rollback('p1', TEST_TENANT, TEST_ACTOR)).rejects.toThrow(
        'Cannot rollback from RETIRED',
      );
    });
  });

  // =========================================================================
  // Canary Evaluation
  // =========================================================================

  describe('evaluateCanary', () => {
    it('should report healthy when error rate is below threshold', () => {
      const { service } = buildService();
      const profile = { canary_request_count: 10, canary_error_count: 1 } as any;

      const result = service.evaluateCanary(profile);

      expect(result.healthy).toBe(true);
      expect(result.errorRate).toBe(0.1);
    });

    it('should report unhealthy when error rate exceeds threshold', () => {
      const { service } = buildService();
      const profile = { canary_request_count: 10, canary_error_count: 5 } as any;

      const result = service.evaluateCanary(profile);

      expect(result.healthy).toBe(false);
      expect(result.errorRate).toBe(0.5);
    });

    it('should skip evaluation below minimum sample size', () => {
      const { service } = buildService();
      const profile = { canary_request_count: 2, canary_error_count: 2 } as any;

      const result = service.evaluateCanary(profile);

      // Below CANARY_MIN_SAMPLE_SIZE (3) — treated as healthy
      expect(result.healthy).toBe(true);
      expect(result.errorRate).toBe(0);
    });

    it('should report healthy at exactly the threshold', () => {
      const { service } = buildService();
      // 20% error rate = exactly at threshold (0.20)
      const profile = { canary_request_count: 10, canary_error_count: 2 } as any;

      const result = service.evaluateCanary(profile);

      expect(result.healthy).toBe(true);
      expect(result.errorRate).toBe(0.2);
    });
  });

  // =========================================================================
  // Canary Metrics Recording
  // =========================================================================

  describe('recordCanaryResult', () => {
    it('should increment request count on success', async () => {
      const { service, profileRepo } = buildService();

      await service.recordCanaryResult('p1', false);

      expect(profileRepo.increment).toHaveBeenCalledWith({ id: 'p1' }, 'canary_request_count', 1);
      expect(profileRepo.increment).not.toHaveBeenCalledWith({ id: 'p1' }, 'canary_error_count', 1);
    });

    it('should increment both counts on error', async () => {
      const { service, profileRepo } = buildService();

      await service.recordCanaryResult('p1', true);

      expect(profileRepo.increment).toHaveBeenCalledWith({ id: 'p1' }, 'canary_error_count', 1);
      expect(profileRepo.increment).toHaveBeenCalledWith({ id: 'p1' }, 'canary_request_count', 1);
    });
  });

  // =========================================================================
  // getActiveProfile
  // =========================================================================

  describe('getActiveProfile', () => {
    it('should return the ACTIVE version for a profile_id', async () => {
      const { service, profileRepo } = buildService();
      profileRepo.findOne.mockResolvedValueOnce({
        id: 'p1', tenant_id: TEST_TENANT, profile_id: 'sf',
        version_state: ProfileVersionState.ACTIVE,
      });

      const result = await service.getActiveProfile(TEST_TENANT, 'sf');

      expect(result.version_state).toBe(ProfileVersionState.ACTIVE);
      expect(profileRepo.findOne).toHaveBeenCalledWith({
        where: {
          tenant_id: TEST_TENANT,
          profile_id: 'sf',
          version_state: ProfileVersionState.ACTIVE,
        },
      });
    });

    it('should throw when no ACTIVE version exists', async () => {
      const { service } = buildService();

      await expect(service.getActiveProfile(TEST_TENANT, 'missing')).rejects.toThrow('No active profile');
    });
  });

  // =========================================================================
  // State Machine Transitions
  // =========================================================================

  describe('State machine transitions (shared package)', () => {
    it('should allow STAGING → CANARY', () => {
      expect(isValidProfileTransition(ProfileVersionState.STAGING, ProfileVersionState.CANARY)).toBe(true);
    });

    it('should allow CANARY → ACTIVE', () => {
      expect(isValidProfileTransition(ProfileVersionState.CANARY, ProfileVersionState.ACTIVE)).toBe(true);
    });

    it('should allow CANARY → STAGING (rollback)', () => {
      expect(isValidProfileTransition(ProfileVersionState.CANARY, ProfileVersionState.STAGING)).toBe(true);
    });

    it('should allow ACTIVE → RETIRED', () => {
      expect(isValidProfileTransition(ProfileVersionState.ACTIVE, ProfileVersionState.RETIRED)).toBe(true);
    });

    it('should reject STAGING → ACTIVE (must go through CANARY)', () => {
      expect(isValidProfileTransition(ProfileVersionState.STAGING, ProfileVersionState.ACTIVE)).toBe(false);
    });

    it('should reject RETIRED → any (terminal state)', () => {
      expect(isValidProfileTransition(ProfileVersionState.RETIRED, ProfileVersionState.STAGING)).toBe(false);
      expect(isValidProfileTransition(ProfileVersionState.RETIRED, ProfileVersionState.CANARY)).toBe(false);
      expect(isValidProfileTransition(ProfileVersionState.RETIRED, ProfileVersionState.ACTIVE)).toBe(false);
    });

    it('should have correct transitions record', () => {
      expect(PROFILE_VERSION_TRANSITIONS[ProfileVersionState.STAGING]).toEqual([ProfileVersionState.CANARY]);
      expect(PROFILE_VERSION_TRANSITIONS[ProfileVersionState.CANARY]).toEqual([ProfileVersionState.ACTIVE, ProfileVersionState.STAGING]);
      expect(PROFILE_VERSION_TRANSITIONS[ProfileVersionState.ACTIVE]).toEqual([ProfileVersionState.RETIRED]);
      expect(PROFILE_VERSION_TRANSITIONS[ProfileVersionState.RETIRED]).toEqual([]);
    });
  });
});
