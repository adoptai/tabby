import { Injectable, Logger } from '@nestjs/common';
import * as Minio from 'minio';
import { DEFAULTS, requireEnv } from '@browser-hitl/shared';

/**
 * Provisions MinIO buckets for new tenants.
 *
 * Each tenant gets an isolated bucket named `artifact-bundles-{tenant_id}`
 * with a lifecycle rule that auto-expires objects after the configured TTL.
 */
@Injectable()
export class MinioProvisionerService {
  private readonly logger = new Logger(MinioProvisionerService.name);
  private readonly client: Minio.Client;

  constructor() {
    const minioEndpoint = requireEnv('MINIO_ENDPOINT', {
      testDefault: 'localhost',
    });
    const minioAccessKey = requireEnv('MINIO_ACCESS_KEY', {
      testDefault: 'minioadmin',
    });
    const minioSecretKey = requireEnv('MINIO_SECRET_KEY', {
      testDefault: 'minioadmin',
    });
    this.client = new Minio.Client({
      endPoint: minioEndpoint,
      port: Number(process.env.MINIO_PORT) || 9000,
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: minioAccessKey,
      secretKey: minioSecretKey,
    });
  }

  /**
   * Returns the canonical artifact-bundles bucket name for a given tenant.
   */
  bucketName(tenantId: string): string {
    return `artifact-bundles-${tenantId}`;
  }

  /**
   * Returns the browser-state bucket name for a given tenant.
   */
  browserStateBucketName(tenantId: string): string {
    return `browser-state-${tenantId}`;
  }

  /**
   * Provision a new MinIO bucket for the tenant.
   *
   * 1. Creates the artifact-bundles bucket (idempotent -- skips if it already exists).
   * 2. Sets a lifecycle rule that expires objects after EXPORT_TTL_SECONDS.
   * 3. Creates the browser-state bucket with a configurable TTL lifecycle rule.
   */
  async provisionBucket(tenantId: string): Promise<void> {
    const bucket = this.bucketName(tenantId);

    const exists = await this.client.bucketExists(bucket);
    if (exists) {
      this.logger.log(`Bucket "${bucket}" already exists, skipping creation`);
    } else {
      await this.client.makeBucket(bucket, 'us-east-1');
      this.logger.log(`Created bucket "${bucket}"`);

      // Set lifecycle rule: expire objects after EXPORT_TTL_SECONDS (converted to days, minimum 1)
      const expiryDays = Math.max(
        1,
        Math.ceil(DEFAULTS.EXPORT_TTL_SECONDS / 86400),
      );

      const lifecycleConfig = {
        Rule: [{
          ID: 'auto-expire-artifacts',
          Status: 'Enabled',
          Filter: { Prefix: '' },
          Expiration: { Days: expiryDays },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        }],
      };

      await this.client.setBucketLifecycle(bucket, lifecycleConfig);
      this.logger.log(
        `Set lifecycle rule on "${bucket}": expire after ${expiryDays} day(s)`,
      );
    }

    await this.provisionBrowserStateBucket(tenantId);
  }

  /**
   * Provision the browser-state bucket for a tenant.
   * Idempotent — skips creation if the bucket already exists.
   */
  async provisionBrowserStateBucket(tenantId: string): Promise<void> {
    const bucket = this.browserStateBucketName(tenantId);

    const exists = await this.client.bucketExists(bucket);
    if (exists) {
      this.logger.log(`Bucket "${bucket}" already exists, skipping creation`);
      return;
    }

    await this.client.makeBucket(bucket, 'us-east-1');
    this.logger.log(`Created bucket "${bucket}"`);

    const ttlSeconds = parseInt(process.env.BROWSER_STATE_TTL_SECONDS || String(DEFAULTS.BROWSER_STATE_TTL_SECONDS), 10);
    const expiryDays = Math.max(1, Math.ceil(ttlSeconds / 86400));

    const lifecycleConfig = {
      Rule: [{
        ID: 'auto-expire-browser-state',
        Status: 'Enabled',
        Filter: { Prefix: '' },
        Expiration: { Days: expiryDays },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      }],
    };

    await this.client.setBucketLifecycle(bucket, lifecycleConfig);
    this.logger.log(
      `Set lifecycle rule on "${bucket}": expire after ${expiryDays} day(s)`,
    );
  }

  /**
   * Expose the underlying MinIO client for other services that need
   * direct access (e.g., presigned URLs, object deletion).
   */
  getClient(): Minio.Client {
    return this.client;
  }
}
