import { ConflictException } from '@nestjs/common';

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn(),
}));
import * as crypto from 'crypto';

function createMockRepo() {
  return {
    findOne: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn((data) => Promise.resolve(data)),
    findAndCount: jest.fn(),
  };
}

function createMockAudit() {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

function createMockMinio() {
  return { provisionBucket: jest.fn().mockResolvedValue(undefined) };
}

function buildService(overrides: Record<string, any> = {}) {
  const { TenantsService } = require('./tenants.service');
  const tenantRepo = overrides.tenantRepo ?? createMockRepo();
  const auditService = overrides.auditService ?? createMockAudit();
  const minioProvisioner = overrides.minioProvisioner ?? createMockMinio();

  const service = Object.create(TenantsService.prototype);
  (service as any).tenantRepo = tenantRepo;
  (service as any).auditService = auditService;
  (service as any).minioProvisioner = minioProvisioner;
  (service as any).logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };

  return { service, tenantRepo, auditService, minioProvisioner };
}

describe('TenantsService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('generates a UUID when no id is provided', async () => {
      (crypto.randomUUID as jest.Mock).mockReturnValue('generated-uuid-1');
      const { service, tenantRepo, auditService, minioProvisioner } = buildService();
      tenantRepo.findOne.mockResolvedValue(null);

      const result = await service.create('Acme Corp', 'admin-user');

      expect(result).toEqual({ tenant_id: 'generated-uuid-1' });
      expect(tenantRepo.create).toHaveBeenCalledWith({ id: 'generated-uuid-1', name: 'Acme Corp' });
      expect(minioProvisioner.provisionBucket).toHaveBeenCalledWith('generated-uuid-1');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: 'generated-uuid-1',
          event_type: 'tenant.created',
          actor_id: 'admin-user',
        }),
      );
    });

    it('uses the custom id when provided (for multi-tenant cloud routing)', async () => {
      const { service, tenantRepo } = buildService();
      tenantRepo.findOne.mockResolvedValue(null);

      const result = await service.create('AA Inc', 'admin-user', 'org-frontegg-123');

      expect(result).toEqual({ tenant_id: 'org-frontegg-123' });
      expect(tenantRepo.create).toHaveBeenCalledWith({ id: 'org-frontegg-123', name: 'AA Inc' });
      expect(crypto.randomUUID).not.toHaveBeenCalled();
    });

    it('checks for id collision when custom id is provided', async () => {
      const { service, tenantRepo } = buildService();
      // First call: by name → not found. Second call: by id → found (collision).
      tenantRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'org-123', name: 'Other' });

      await expect(
        service.create('New Org', 'admin', 'org-123'),
      ).rejects.toThrow(ConflictException);
      expect(tenantRepo.findOne).toHaveBeenNthCalledWith(2, { where: { id: 'org-123' } });
    });

    it('does not check id collision when no id is provided (UUID is unique)', async () => {
      (crypto.randomUUID as jest.Mock).mockReturnValue('uuid-auto');
      const { service, tenantRepo } = buildService();
      tenantRepo.findOne.mockResolvedValue(null);

      await service.create('No Id', 'admin');

      // Only the name lookup, no id lookup
      expect(tenantRepo.findOne).toHaveBeenCalledTimes(1);
      expect(tenantRepo.findOne).toHaveBeenCalledWith({ where: { name: 'No Id' } });
    });

    it('rejects when tenant name already exists', async () => {
      const { service, tenantRepo } = buildService();
      tenantRepo.findOne.mockResolvedValue({ id: 'x', name: 'Acme Corp' });

      await expect(service.create('Acme Corp', 'admin')).rejects.toThrow(ConflictException);
      expect(tenantRepo.create).not.toHaveBeenCalled();
    });

    it('swallows MinIO provisioning errors (tenant creation still succeeds)', async () => {
      (crypto.randomUUID as jest.Mock).mockReturnValue('uuid-minio-fail');
      const minioProvisioner = createMockMinio();
      minioProvisioner.provisionBucket = jest.fn().mockRejectedValue(new Error('minio down'));
      const { service, tenantRepo, auditService } = buildService({ minioProvisioner });
      tenantRepo.findOne.mockResolvedValue(null);

      const result = await service.create('MinioFail', 'admin');

      expect(result.tenant_id).toBe('uuid-minio-fail');
      expect(auditService.log).toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('returns paginated tenants', async () => {
      const { service, tenantRepo } = buildService();
      const rows = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
      tenantRepo.findAndCount.mockResolvedValue([rows, 2]);

      const result = await service.findAll(10, 0);

      expect(result).toEqual({ data: rows, total: 2, limit: 10, offset: 0 });
      expect(tenantRepo.findAndCount).toHaveBeenCalledWith({
        take: 10,
        skip: 0,
        order: { created_at: 'DESC' },
      });
    });
  });
});
