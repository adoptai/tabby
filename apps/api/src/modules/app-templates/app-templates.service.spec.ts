import { AppTemplatesService } from './app-templates.service';
import { AppTemplateEntity } from '../../entities/app-template.entity';
import { ServiceProfileEntity } from '../../entities/service-profile.entity';
import { ProfileVersionState } from '@browser-hitl/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTemplate(overrides: Partial<AppTemplateEntity> = {}): AppTemplateEntity {
  return {
    id: 'tpl-uuid-1',
    tenant_id: 'tenant-1',
    name: 'Salesforce Template',
    profile_name_pattern: 'salesforce-*',
    login_config: { login_url: 'https://login.salesforce.com' },
    keepalive_config: { interval: 300 },
    export_policy: { target_domains: ['salesforce.com'], credential_types: { token: 'VOLATILE' } },
    browser_policy: { downloads: false, clipboard: false, file_chooser: false },
    notification_config: {},
    credential_ref_default: 'manual:',
    execute_enabled: false,
    idle_shutdown_seconds: null,
    created_at: new Date(),
    updated_at: new Date(),
    tenant: null as any,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<ServiceProfileEntity> = {}): ServiceProfileEntity {
  return {
    id: 'profile-uuid-1',
    tenant_id: 'tenant-1',
    app_id: 'app-1',
    profile_id: 'salesforce-standard',
    version: '1.0.0',
    version_state: ProfileVersionState.ACTIVE,
    parent_version_id: null,
    login_config: { login_url: 'https://login.salesforce.com' },
    credential_types: { token: 'VOLATILE' },
    target_domains: ['salesforce.com'],
    login_concurrency_limit: null,
    extra_config: null,
    owner_user_id: null,
    canary_request_count: 0,
    canary_error_count: 0,
    promoted_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    tenant: null as any,
    application: null as any,
    ...overrides,
  };
}

function makeDataSource(overrides: Partial<{ transaction: jest.Mock }> = {}) {
  const transaction = overrides.transaction ?? jest.fn().mockImplementation(async (cb: any) => {
    const manager = {
      update: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue({}),
    };
    return cb(manager);
  });
  return { transaction };
}

function buildService(overrides: {
  templateRepo?: any;
  appRepo?: any;
  profileRepo?: any;
  dataSource?: any;
  auditService?: any;
} = {}) {
  const templateRepo = overrides.templateRepo ?? {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((d: any) => d),
    save: jest.fn().mockImplementation((d: any) => Promise.resolve({ id: 'tpl-uuid-1', ...d })),
    remove: jest.fn().mockResolvedValue(undefined),
  };

  const appRepo = overrides.appRepo ?? {
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const profileRepo = overrides.profileRepo ?? {
    find: jest.fn().mockResolvedValue([]),
  };

  const dataSource = overrides.dataSource ?? makeDataSource();

  const auditService = overrides.auditService ?? {
    log: jest.fn().mockResolvedValue(undefined),
  };

  const service = Object.create(AppTemplatesService.prototype);
  (service as any).templateRepo = templateRepo;
  (service as any).appRepo = appRepo;
  (service as any).profileRepo = profileRepo;
  (service as any).dataSource = dataSource;
  (service as any).auditService = auditService;
  (service as any).logger = {
    log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  };

  return { service: service as AppTemplatesService, templateRepo, appRepo, profileRepo, dataSource, auditService };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppTemplatesService — propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('update() — propagation to linked apps', () => {
    it('propagates PROPAGATED_FIELDS to all linked apps when template is updated', async () => {
      const template = makeTemplate();

      const { service, templateRepo, appRepo } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([{ id: 'app-1' }, { id: 'app-2' }]),
          update: jest.fn().mockResolvedValue(undefined),
        },
      });

      await service.update('tenant-1', 'tpl-uuid-1', { name: 'Updated' }, 'actor-1');

      expect(appRepo.update).toHaveBeenCalledTimes(2);

      const expectedPayload = {
        browser_policy: template.browser_policy,
        login_config: template.login_config,
        keepalive_config: template.keepalive_config,
        export_policy: template.export_policy,
        notification_config: template.notification_config,
        execute_enabled: template.execute_enabled,
      };

      expect(appRepo.update).toHaveBeenCalledWith('app-1', expectedPayload);
      expect(appRepo.update).toHaveBeenCalledWith('app-2', expectedPayload);
    });

    it('propagates execute_enabled toggles to linked apps', async () => {
      const template = makeTemplate({ execute_enabled: true });

      const { service, appRepo } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([{ id: 'app-1' }]),
          update: jest.fn().mockResolvedValue(undefined),
        },
      });

      await service.update('tenant-1', 'tpl-uuid-1', { execute_enabled: true }, 'actor-1');

      expect(appRepo.update).toHaveBeenCalledWith(
        'app-1',
        expect.objectContaining({ execute_enabled: true }),
      );
    });

    it('apps without template_id are not affected (find by template_id filters them out)', async () => {
      const template = makeTemplate();

      // appRepo.find is called with where: { template_id: template.id }, so unlinked apps are
      // never returned — this test verifies that update is not called when find returns empty.
      const { service, appRepo } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([]),
          update: jest.fn().mockResolvedValue(undefined),
        },
      });

      await service.update('tenant-1', 'tpl-uuid-1', {}, 'actor-1');

      expect(appRepo.update).not.toHaveBeenCalled();
    });

    it('does not crash when there are no linked apps', async () => {
      const template = makeTemplate();

      const { service } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([]),
          update: jest.fn().mockResolvedValue(undefined),
        },
      });

      await expect(service.update('tenant-1', 'tpl-uuid-1', {}, 'actor-1')).resolves.not.toThrow();
    });

    it('paginates correctly when there are more than 50 linked apps', async () => {
      const template = makeTemplate();

      // First batch: 50 apps; second batch: 10 apps; third batch: empty → stop
      const batch1 = Array.from({ length: 50 }, (_, i) => ({ id: `app-${i}` }));
      const batch2 = Array.from({ length: 10 }, (_, i) => ({ id: `app-${50 + i}` }));

      const findMock = jest.fn()
        .mockResolvedValueOnce(batch1)
        .mockResolvedValueOnce(batch2)
        .mockResolvedValueOnce([]);

      const updateMock = jest.fn().mockResolvedValue(undefined);

      const { service } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: findMock,
          update: updateMock,
        },
      });

      await service.update('tenant-1', 'tpl-uuid-1', {}, 'actor-1');

      expect(updateMock).toHaveBeenCalledTimes(60);

      // Verify skip/take pagination arguments
      expect(findMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ skip: 0, take: 50 }));
      expect(findMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ skip: 50, take: 50 }));
    });

    it('logs a message when apps were propagated', async () => {
      const template = makeTemplate();

      const { service } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([{ id: 'app-1' }]),
          update: jest.fn().mockResolvedValue(undefined),
        },
      });

      await service.update('tenant-1', 'tpl-uuid-1', {}, 'actor-1');

      expect((service as any).logger.log).toHaveBeenCalledWith(
        expect.stringContaining('1 linked app'),
      );
    });

    it('does not log when no apps were propagated', async () => {
      const template = makeTemplate();

      const { service } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([]),
          update: jest.fn().mockResolvedValue(undefined),
        },
      });

      await service.update('tenant-1', 'tpl-uuid-1', {}, 'actor-1');

      expect((service as any).logger.log).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Profile propagation tests
  // ---------------------------------------------------------------------------

  describe('profile propagation', () => {
    it('creates a new ACTIVE profile version and retires the old one when login_config changes', async () => {
      const oldLoginConfig = { login_url: 'https://old.salesforce.com' };
      const newLoginConfig = { login_url: 'https://login.salesforce.com' };
      const template = makeTemplate({ login_config: newLoginConfig });
      const existingProfile = makeProfile({ login_config: oldLoginConfig });

      let savedManagerUpdate: jest.Mock;
      let savedManagerSave: jest.Mock;

      const dataSource = {
        transaction: jest.fn().mockImplementation(async (cb: any) => {
          savedManagerUpdate = jest.fn().mockResolvedValue(undefined);
          savedManagerSave = jest.fn().mockResolvedValue({});
          return cb({ update: savedManagerUpdate, save: savedManagerSave });
        }),
      };

      const { service } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([{ id: 'app-1' }]),
          update: jest.fn().mockResolvedValue(undefined),
        },
        profileRepo: {
          find: jest.fn().mockResolvedValue([existingProfile]),
        },
        dataSource,
      });

      await service.update('tenant-1', 'tpl-uuid-1', { login_config: newLoginConfig }, 'actor-1');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);

      // Old profile retired
      expect(savedManagerUpdate!).toHaveBeenCalledWith(
        expect.any(Function),
        { id: existingProfile.id },
        { version_state: ProfileVersionState.RETIRED },
      );

      // New profile saved with bumped version and updated login_config
      expect(savedManagerSave!).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          version: '1.1.0',
          version_state: ProfileVersionState.ACTIVE,
          parent_version_id: existingProfile.id,
          login_config: newLoginConfig,
        }),
      );
    });

    it('does not create a new profile version when only browser_policy changes', async () => {
      const template = makeTemplate({ browser_policy: { downloads: true, clipboard: false, file_chooser: false } });
      // Profile fields match the template exactly
      const existingProfile = makeProfile({
        login_config: template.login_config,
        credential_types: { token: 'VOLATILE' },
        target_domains: ['salesforce.com'],
      });

      const dataSource = makeDataSource();

      const { service } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([{ id: 'app-1' }]),
          update: jest.fn().mockResolvedValue(undefined),
        },
        profileRepo: {
          find: jest.fn().mockResolvedValue([existingProfile]),
        },
        dataSource,
      });

      await service.update('tenant-1', 'tpl-uuid-1', { browser_policy: { downloads: true, clipboard: false, file_chooser: false } }, 'actor-1');

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('skips apps that have no ACTIVE profile without error', async () => {
      const template = makeTemplate();
      const retiredProfile = makeProfile({ version_state: ProfileVersionState.RETIRED });

      const dataSource = makeDataSource();

      const { service } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([{ id: 'app-1' }]),
          update: jest.fn().mockResolvedValue(undefined),
        },
        profileRepo: {
          // profileRepo.find is called with version_state: ACTIVE, so returns empty (retired not returned)
          find: jest.fn().mockResolvedValue([]),
        },
        dataSource,
      });

      await expect(
        service.update('tenant-1', 'tpl-uuid-1', { login_config: { login_url: 'https://new.example.com' } }, 'actor-1'),
      ).resolves.not.toThrow();

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('inherits non-template fields from the old ACTIVE profile', async () => {
      const newLoginConfig = { login_url: 'https://new.salesforce.com' };
      const template = makeTemplate({ login_config: newLoginConfig });
      const existingProfile = makeProfile({
        login_config: { login_url: 'https://old.salesforce.com' },
        owner_user_id: 'user-42',
        extra_config: { some_key: 'some_value' },
        login_concurrency_limit: 3,
      });

      let capturedSave: jest.Mock;

      const dataSource = {
        transaction: jest.fn().mockImplementation(async (cb: any) => {
          capturedSave = jest.fn().mockResolvedValue({});
          return cb({ update: jest.fn().mockResolvedValue(undefined), save: capturedSave });
        }),
      };

      const { service } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([{ id: 'app-1' }]),
          update: jest.fn().mockResolvedValue(undefined),
        },
        profileRepo: {
          find: jest.fn().mockResolvedValue([existingProfile]),
        },
        dataSource,
      });

      await service.update('tenant-1', 'tpl-uuid-1', { login_config: newLoginConfig }, 'actor-1');

      expect(capturedSave!).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          owner_user_id: 'user-42',
          extra_config: { some_key: 'some_value' },
          login_concurrency_limit: 3,
        }),
      );
    });

    it('propagates profiles independently for each linked app', async () => {
      const newLoginConfig = { login_url: 'https://new.salesforce.com' };
      const template = makeTemplate({ login_config: newLoginConfig });

      const profile1 = makeProfile({ id: 'profile-1', app_id: 'app-1', login_config: { login_url: 'old' } });
      const profile2 = makeProfile({ id: 'profile-2', app_id: 'app-2', login_config: { login_url: 'old' } });
      const profile3 = makeProfile({ id: 'profile-3', app_id: 'app-3', login_config: { login_url: 'old' } });

      const dataSource = makeDataSource();

      const { service } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([{ id: 'app-1' }, { id: 'app-2' }, { id: 'app-3' }]),
          update: jest.fn().mockResolvedValue(undefined),
        },
        profileRepo: {
          find: jest.fn()
            .mockResolvedValueOnce([profile1])
            .mockResolvedValueOnce([profile2])
            .mockResolvedValueOnce([profile3]),
        },
        dataSource,
      });

      await service.update('tenant-1', 'tpl-uuid-1', { login_config: newLoginConfig }, 'actor-1');

      expect(dataSource.transaction).toHaveBeenCalledTimes(3);
    });

    it('emits an audit log event for each propagated profile', async () => {
      const newLoginConfig = { login_url: 'https://new.salesforce.com' };
      const template = makeTemplate({ login_config: newLoginConfig });
      const existingProfile = makeProfile({ login_config: { login_url: 'https://old.salesforce.com' } });

      const auditService = { log: jest.fn().mockResolvedValue(undefined) };

      const { service } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([{ id: 'app-1' }]),
          update: jest.fn().mockResolvedValue(undefined),
        },
        profileRepo: {
          find: jest.fn().mockResolvedValue([existingProfile]),
        },
        dataSource: makeDataSource(),
        auditService,
      });

      await service.update('tenant-1', 'tpl-uuid-1', { login_config: newLoginConfig }, 'actor-1');

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'profile.propagated' }),
      );
    });

    it('handles multiple ACTIVE profiles per app defensively', async () => {
      const newLoginConfig = { login_url: 'https://new.salesforce.com' };
      const template = makeTemplate({ login_config: newLoginConfig });

      const profile1 = makeProfile({ id: 'profile-1', login_config: { login_url: 'old' } });
      const profile2 = makeProfile({ id: 'profile-2', login_config: { login_url: 'old' } });

      const dataSource = makeDataSource();

      const { service } = buildService({
        templateRepo: {
          findOne: jest.fn().mockResolvedValue(template),
          save: jest.fn().mockResolvedValue(template),
        },
        appRepo: {
          find: jest.fn().mockResolvedValue([{ id: 'app-1' }]),
          update: jest.fn().mockResolvedValue(undefined),
        },
        profileRepo: {
          find: jest.fn().mockResolvedValue([profile1, profile2]),
        },
        dataSource,
      });

      await service.update('tenant-1', 'tpl-uuid-1', { login_config: newLoginConfig }, 'actor-1');

      // Both ACTIVE profiles should be updated
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // bumpMinorVersion helper
  // ---------------------------------------------------------------------------

  describe('bumpMinorVersion', () => {
    const cases: [string, string][] = [
      ['1.0.0', '1.1.0'],
      ['2.5.3', '2.6.0'],
      ['0.0.0', '0.1.0'],
      ['10.99.5', '10.100.0'],
    ];

    it.each(cases)('bumps %s → %s', (input, expected) => {
      const service = Object.create(AppTemplatesService.prototype);
      expect((service as any).bumpMinorVersion(input)).toBe(expected);
    });
  });

  // ---------------------------------------------------------------------------
  // stableStringify — key-order-independent comparison
  // ---------------------------------------------------------------------------

  describe('stableStringify', () => {
    const stableStringify = (AppTemplatesService as any).stableStringify;

    it('produces identical output regardless of key order', () => {
      const a = { z: 1, a: 2, m: { b: 3, a: 4 } };
      const b = { a: 2, m: { a: 4, b: 3 }, z: 1 };
      expect(stableStringify(a)).toBe(stableStringify(b));
    });

    it('preserves array order (arrays are order-sensitive)', () => {
      expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
    });

    it('handles nested arrays and objects', () => {
      const a = { items: [{ z: 1, a: 2 }], name: 'test' };
      const b = { name: 'test', items: [{ a: 2, z: 1 }] };
      expect(stableStringify(a)).toBe(stableStringify(b));
    });

    it('handles null and primitives', () => {
      expect(stableStringify(null)).toBe('null');
      expect(stableStringify('hello')).toBe('"hello"');
      expect(stableStringify(42)).toBe('42');
      expect(stableStringify(true)).toBe('true');
    });
  });
});
