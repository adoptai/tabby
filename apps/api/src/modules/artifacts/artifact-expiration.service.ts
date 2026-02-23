import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import * as Minio from 'minio';
import { ArtifactBundleEntity } from '../../entities';
import { MinioProvisionerService } from '../tenants/minio-provisioner.service';

/**
 * Periodically purges expired artifact bundles from both MinIO and the database.
 *
 * Runs every 15 minutes via @nestjs/schedule.  For each expired row:
 *  1. Deletes the corresponding object in MinIO.
 *  2. Removes the database row (cascade handles consumption records via FK).
 */
@Injectable()
export class ArtifactExpirationService {
  private readonly logger = new Logger(ArtifactExpirationService.name);
  private readonly minioClient: Minio.Client;

  constructor(
    @InjectRepository(ArtifactBundleEntity)
    private readonly artifactRepo: Repository<ArtifactBundleEntity>,
    private readonly minioProvisioner: MinioProvisionerService,
  ) {
    this.minioClient = this.minioProvisioner.getClient();
  }

  /**
   * Cron handler -- every 15 minutes, find and purge expired artifact bundles.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleExpiredArtifacts(): Promise<void> {
    this.logger.log('Running artifact expiration sweep...');

    const now = new Date();
    const expired = await this.artifactRepo.find({
      where: { expires_at: LessThan(now) },
      take: 500, // Process in batches to avoid memory pressure
    });

    if (expired.length === 0) {
      this.logger.log('No expired artifacts found');
      return;
    }

    this.logger.log(`Found ${expired.length} expired artifact(s) to purge`);

    let successCount = 0;
    let failureCount = 0;

    for (const artifact of expired) {
      try {
        // 1. Delete the object from MinIO
        const bucket = this.minioProvisioner.bucketName(artifact.tenant_id);
        await this.minioClient.removeObject(bucket, artifact.encrypted_payload_ref);

        // 2. Delete the database row
        await this.artifactRepo.remove(artifact);

        successCount++;
      } catch (err) {
        failureCount++;
        this.logger.error(
          `Failed to purge artifact ${artifact.id}: ${(err as Error).message}`,
        );
        // Continue processing other artifacts; failures will be retried
        // on the next cron tick.
      }
    }

    this.logger.log(
      `Artifact expiration sweep complete: ${successCount} purged, ${failureCount} failed`,
    );
  }
}
