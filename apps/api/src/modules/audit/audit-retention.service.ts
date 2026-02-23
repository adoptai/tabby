import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditEventEntity } from '../../entities';
import { TenantEntity } from '../../entities';

/** Default retention period in days if not configured per tenant */
const DEFAULT_RETENTION_DAYS = 90;

/** Batch size for deletion to avoid long-running transactions */
const DELETION_BATCH_SIZE = 1000;

@Injectable()
export class AuditRetentionService {
  private readonly logger = new Logger(AuditRetentionService.name);

  constructor(
    @InjectRepository(AuditEventEntity)
    private readonly auditEventRepo: Repository<AuditEventEntity>,
    @InjectRepository(TenantEntity)
    private readonly tenantRepo: Repository<TenantEntity>,
  ) {}

  /**
   * Cron job: runs daily at 2 AM to clean up expired audit events.
   * Runs after the anchor computation (midnight) to ensure anchors are stored first.
   */
  @Cron('0 2 * * *')
  async handleRetentionCleanup(): Promise<void> {
    try {
      const result = await this.cleanupExpiredEvents();
      this.logger.log(`Retention cleanup completed: ${result.deletedCount} events deleted`);
    } catch (error) {
      this.logger.error(
        'Failed to run retention cleanup',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Delete audit events older than the retention period.
   *
   * The retention period defaults to 90 days but can be configured per tenant
   * via the tenant's settings. System events (tenant_id = null) use the default.
   *
   * Deletes in batches to avoid long-running transactions.
   */
  async cleanupExpiredEvents(): Promise<{ deletedCount: number }> {
    let totalDeleted = 0;

    // Clean up system events (no tenant) with default retention
    const systemCutoff = this.computeCutoffDate(DEFAULT_RETENTION_DAYS);
    totalDeleted += await this.deleteEventsBefore(null, systemCutoff);

    // Load all tenants and clean up per-tenant with their configured retention
    const tenants = await this.tenantRepo.find();
    for (const tenant of tenants) {
      // Use tenant-specific retention if configured, otherwise default
      const retentionDays = this.getTenantRetentionDays(tenant);
      const cutoff = this.computeCutoffDate(retentionDays);
      totalDeleted += await this.deleteEventsBefore(tenant.id, cutoff);
    }

    return { deletedCount: totalDeleted };
  }

  /**
   * Delete audit events for a specific tenant (or system events if tenantId is null)
   * that are older than the given cutoff date.
   */
  private async deleteEventsBefore(tenantId: string | null, cutoff: Date): Promise<number> {
    let totalDeleted = 0;
    let batchDeleted: number;

    do {
      // Find a batch of old events
      const events = await this.auditEventRepo.find({
        where: {
          tenant_id: tenantId as any,
          timestamp: LessThan(cutoff),
        },
        order: { sequence_num: 'ASC' },
        take: DELETION_BATCH_SIZE,
        select: ['id'],
      });

      if (events.length === 0) break;

      const ids = events.map((e) => e.id);
      const result = await this.auditEventRepo
        .createQueryBuilder()
        .delete()
        .whereInIds(ids)
        .execute();

      batchDeleted = result.affected || 0;
      totalDeleted += batchDeleted;

      this.logger.debug(
        `Deleted ${batchDeleted} audit events for tenant ${tenantId || '(system)'} before ${cutoff.toISOString()}`,
      );
    } while (batchDeleted === DELETION_BATCH_SIZE);

    return totalDeleted;
  }

  /**
   * Get retention days for a tenant. Currently uses the default value.
   * Extend this method when per-tenant retention configuration is added
   * to the TenantEntity (e.g., a `retention_days` column).
   */
  private getTenantRetentionDays(_tenant: TenantEntity): number {
    // TODO: Read from tenant.retention_days when the column is added
    return DEFAULT_RETENTION_DAYS;
  }

  private computeCutoffDate(retentionDays: number): Date {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    cutoff.setHours(0, 0, 0, 0);
    return cutoff;
  }
}
