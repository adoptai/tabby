import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as Minio from 'minio';
import { ArtifactBundleEntity, TenantEntity } from '../../entities';
import { MinioProvisionerService } from '../tenants/minio-provisioner.service';

@Injectable()
export class MinioOrphanSweepService {
  private readonly logger = new Logger(MinioOrphanSweepService.name);
  private readonly client: Minio.Client;

  constructor(
    private readonly minioProvisioner: MinioProvisionerService,
    @InjectRepository(ArtifactBundleEntity)
    private readonly artifactRepo: Repository<ArtifactBundleEntity>,
    @InjectRepository(TenantEntity)
    private readonly tenantRepo: Repository<TenantEntity>,
  ) {
    this.client = this.minioProvisioner.getClient();
  }

  @Cron('0 * * * *') // every hour
  async sweepOrphans(): Promise<void> {
    this.logger.log('Running MinIO orphan sweep...');
    const maxAgeHours = parseInt(process.env.MINIO_ORPHAN_MAX_AGE_HOURS || '2', 10);
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const tenants = await this.tenantRepo.find({ select: ['id'] });
    let totalRemoved = 0;

    for (const tenant of tenants) {
      const bucket = this.minioProvisioner.bucketName(tenant.id);
      try {
        const exists = await this.client.bucketExists(bucket);
        if (!exists) continue;

        const orphans: string[] = [];
        const stream = this.client.listObjects(bucket, '', true);

        for await (const obj of stream) {
          if (!obj.lastModified || obj.lastModified >= cutoff) continue;
          // Check if DB row exists
          const dbRow = await this.artifactRepo.findOne({
            where: { encrypted_payload_ref: obj.name, tenant_id: tenant.id },
            select: ['id'],
          });
          if (!dbRow) orphans.push(obj.name as string);
        }

        if (orphans.length > 0) {
          await this.client.removeObjects(bucket, orphans);
          totalRemoved += orphans.length;
          this.logger.log(`Removed ${orphans.length} orphan(s) from ${bucket}`);
        }
      } catch (err) {
        this.logger.error(`Orphan sweep failed for ${bucket}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Orphan sweep complete: ${totalRemoved} object(s) removed`);
  }
}
