import { MinioOrphanSweepService } from './minio-orphan-sweep.service';

// ---------------------------------------------------------------------------
// Helpers to build mock repositories and MinIO client
// ---------------------------------------------------------------------------

function makeMockArtifactRepo(dbRow: { id: string } | null) {
  return {
    findOne: jest.fn().mockResolvedValue(dbRow),
  };
}

function makeMockTenantRepo(tenants: Array<{ id: string }>) {
  return {
    find: jest.fn().mockResolvedValue(tenants),
  };
}

function makeAsyncIterator(items: any[]) {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (index < items.length) {
            return Promise.resolve({ value: items[index++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function makeMockMinioClient(opts: {
  bucketExists?: boolean;
  objects?: any[];
}) {
  return {
    bucketExists: jest.fn().mockResolvedValue(opts.bucketExists ?? true),
    listObjects: jest.fn().mockReturnValue(makeAsyncIterator(opts.objects ?? [])),
    removeObjects: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMockProvisioner(client: any) {
  return {
    bucketName: (tenantId: string) => `artifact-bundles-${tenantId}`,
    getClient: () => client,
  };
}

describe('MinioOrphanSweepService', () => {
  it('does nothing when bucket does not exist', async () => {
    const minioClient = makeMockMinioClient({ bucketExists: false });
    const tenantRepo = makeMockTenantRepo([{ id: 'tenant-1' }]);
    const artifactRepo = makeMockArtifactRepo(null);
    const provisioner = makeMockProvisioner(minioClient);

    const service = new MinioOrphanSweepService(
      provisioner as any,
      artifactRepo as any,
      tenantRepo as any,
    );

    await service.sweepOrphans();

    expect(minioClient.removeObjects).not.toHaveBeenCalled();
  });

  it('removes objects with no DB row that are older than 2 hours', async () => {
    const oldDate = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
    const objects = [
      { name: 'old-orphan-key', lastModified: oldDate },
    ];
    const minioClient = makeMockMinioClient({ objects });
    const tenantRepo = makeMockTenantRepo([{ id: 'tenant-1' }]);
    // No DB row found → orphan
    const artifactRepo = makeMockArtifactRepo(null);
    const provisioner = makeMockProvisioner(minioClient);

    const service = new MinioOrphanSweepService(
      provisioner as any,
      artifactRepo as any,
      tenantRepo as any,
    );

    await service.sweepOrphans();

    expect(minioClient.removeObjects).toHaveBeenCalledWith(
      'artifact-bundles-tenant-1',
      ['old-orphan-key'],
    );
  });

  it('does not remove objects that have a matching DB row', async () => {
    const oldDate = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const objects = [
      { name: 'known-object-key', lastModified: oldDate },
    ];
    const minioClient = makeMockMinioClient({ objects });
    const tenantRepo = makeMockTenantRepo([{ id: 'tenant-1' }]);
    // DB row exists → not an orphan
    const artifactRepo = makeMockArtifactRepo({ id: 'some-artifact-id' });
    const provisioner = makeMockProvisioner(minioClient);

    const service = new MinioOrphanSweepService(
      provisioner as any,
      artifactRepo as any,
      tenantRepo as any,
    );

    await service.sweepOrphans();

    expect(minioClient.removeObjects).not.toHaveBeenCalled();
  });

  it('does not remove recent objects (within 2 hours) even if they have no DB row', async () => {
    const recentDate = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
    const objects = [
      { name: 'recent-key', lastModified: recentDate },
    ];
    const minioClient = makeMockMinioClient({ objects });
    const tenantRepo = makeMockTenantRepo([{ id: 'tenant-1' }]);
    const artifactRepo = makeMockArtifactRepo(null);
    const provisioner = makeMockProvisioner(minioClient);

    const service = new MinioOrphanSweepService(
      provisioner as any,
      artifactRepo as any,
      tenantRepo as any,
    );

    await service.sweepOrphans();

    expect(minioClient.removeObjects).not.toHaveBeenCalled();
  });

  it('continues to next tenant if one bucket throws', async () => {
    const minioClient = {
      bucketExists: jest.fn()
        .mockResolvedValueOnce(true)   // tenant-1: exists
        .mockRejectedValueOnce(new Error('MinIO unreachable')), // tenant-2: error
      listObjects: jest.fn().mockReturnValue(makeAsyncIterator([])),
      removeObjects: jest.fn(),
    };
    const tenantRepo = makeMockTenantRepo([{ id: 'tenant-1' }, { id: 'tenant-2' }]);
    const artifactRepo = makeMockArtifactRepo(null);
    const provisioner = makeMockProvisioner(minioClient);

    const service = new MinioOrphanSweepService(
      provisioner as any,
      artifactRepo as any,
      tenantRepo as any,
    );

    // Should not throw
    await expect(service.sweepOrphans()).resolves.toBeUndefined();
    expect(minioClient.bucketExists).toHaveBeenCalledTimes(2);
  });

  it('handles empty tenant list gracefully', async () => {
    const minioClient = makeMockMinioClient({});
    const tenantRepo = makeMockTenantRepo([]);
    const artifactRepo = makeMockArtifactRepo(null);
    const provisioner = makeMockProvisioner(minioClient);

    const service = new MinioOrphanSweepService(
      provisioner as any,
      artifactRepo as any,
      tenantRepo as any,
    );

    await service.sweepOrphans();

    expect(minioClient.bucketExists).not.toHaveBeenCalled();
    expect(minioClient.removeObjects).not.toHaveBeenCalled();
  });
});
