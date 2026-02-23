import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditEventEntity, AuditAnchorEntity } from '../../entities';

@Injectable()
export class AuditAnchorService {
  private readonly logger = new Logger(AuditAnchorService.name);

  constructor(
    @InjectRepository(AuditEventEntity)
    private readonly auditEventRepo: Repository<AuditEventEntity>,
    @InjectRepository(AuditAnchorEntity)
    private readonly auditAnchorRepo: Repository<AuditAnchorEntity>,
  ) {}

  /**
   * Cron job: runs daily at midnight to compute the anchor for the previous day.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDailyAnchor(): Promise<void> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    try {
      await this.computeDailyAnchor(yesterday);
      this.logger.log(`Daily anchor computed for ${yesterday.toISOString().slice(0, 10)}`);
    } catch (error) {
      this.logger.error(
        `Failed to compute daily anchor for ${yesterday.toISOString().slice(0, 10)}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Compute the root hash for a given date.
   *
   * The last event's hash for the day IS the root hash because each event's
   * hash chains all previous events (SHA256(prev_hash + canonical_payload)).
   *
   * @param date - The date to compute the anchor for (time portion is ignored)
   */
  async computeDailyAnchor(date: Date): Promise<AuditAnchorEntity> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const anchorDateStr = startOfDay.toISOString().slice(0, 10);

    // Check if anchor already exists for this date
    const existing = await this.auditAnchorRepo.findOne({
      where: { anchor_date: anchorDateStr },
    });
    if (existing) {
      this.logger.warn(`Anchor already exists for ${anchorDateStr}, skipping`);
      return existing;
    }

    // Load all audit events for the day ordered by sequence_num
    const events = await this.auditEventRepo.find({
      where: {
        timestamp: Between(startOfDay, endOfDay),
      },
      order: { sequence_num: 'ASC' },
    });

    if (events.length === 0) {
      this.logger.warn(`No audit events found for ${anchorDateStr}, creating empty anchor`);
      const anchor = this.auditAnchorRepo.create({
        anchor_date: anchorDateStr,
        root_hash: '0'.repeat(64), // null hash for empty days
        event_count: 0,
      });
      return this.auditAnchorRepo.save(anchor);
    }

    // The last event's hash IS the root hash (it chains all previous events)
    const lastEvent = events[events.length - 1];

    const anchor = this.auditAnchorRepo.create({
      anchor_date: anchorDateStr,
      root_hash: lastEvent.hash,
      event_count: events.length,
    });

    return this.auditAnchorRepo.save(anchor);
  }
}
