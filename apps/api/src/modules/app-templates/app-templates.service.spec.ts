import { AppTemplatesService } from './app-templates.service';
import { AppTemplateEntity } from '../../entities/app-template.entity';

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
    export_policy: { target_domains: ['salesforce.com'] },
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

function buildService(overrides: {
  templateRepo?: any;
  appRepo?: any;
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

  const auditService = overrides.auditService ?? {
    log: jest.fn().mockResolvedValue(undefined),
  };

  const service = Object.create(AppTemplatesService.prototype);
  (service as any).templateRepo = templateRepo;
  (service as any).appRepo = appRepo;
  (service as any).auditService = auditService;
  (service as any).logger = {
    log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  };

  return { service: service as AppTemplatesService, templateRepo, appRepo, auditService };
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
});
