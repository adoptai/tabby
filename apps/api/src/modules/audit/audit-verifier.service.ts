import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { createHash } from 'crypto';
import { AuditEventEntity, AuditAnchorEntity } from '../../entities';

export interface BrokenLink {
  sequence_num: number;
  event_id: string;
  expected_hash: string;
  actual_hash: string;
}

export interface VerificationReport {
  date: string;
  status: 'pass' | 'fail';
  total_events: number;
  verified_events: number;
  broken_links: BrokenLink[];
  anchor_match: boolean | null; // null if no anchor exists
  duration_ms: number;
}

@Injectable()
export class AuditVerifierService {
  private readonly logger = new Logger(AuditVerifierService.name);

  constructor(
    @InjectRepository(AuditEventEntity)
    private readonly auditEventRepo: Repository<AuditEventEntity>,
    @InjectRepository(AuditAnchorEntity)
    private readonly auditAnchorRepo: Repository<AuditAnchorEntity>,
  ) {}

  /**
   * Verify the hash chain integrity for a given date.
   *
   * For each event on the date (ordered by sequence_num):
   *   1. Recompute hash = SHA256(prev_hash + canonical_payload)
   *   2. Compare computed hash to stored hash
   *   3. Verify prev_hash links to the previous event's hash
   *
   * Finally, compare the last event's hash to the daily anchor root_hash.
   */
  async verifyChain(date: Date): Promise<VerificationReport> {
    const startTime = Date.now();

    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const dateStr = startOfDay.toISOString().slice(0, 10);

    // Load all audit events for the date ordered by sequence_num
    const events = await this.auditEventRepo.find({
      where: {
        timestamp: Between(startOfDay, endOfDay),
      },
      order: { sequence_num: 'ASC' },
    });

    const brokenLinks: BrokenLink[] = [];
    let verifiedCount = 0;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      // Determine expected prev_hash: previous event's hash, or null for first
      const expectedPrevHash = i > 0 ? events[i - 1].hash : event.prev_hash;

      // Verify prev_hash linkage (skip first event's prev_hash as it may link to previous day)
      if (i > 0 && event.prev_hash !== events[i - 1].hash) {
        brokenLinks.push({
          sequence_num: Number(event.sequence_num),
          event_id: event.id,
          expected_hash: events[i - 1].hash,
          actual_hash: event.prev_hash || '(null)',
        });
        continue;
      }

      // Recompute hash: SHA256(prev_hash + canonical_payload)
      const canonicalPayload = JSON.stringify(
        event.payload,
        Object.keys(event.payload).sort(),
      );
      const hashInput = (event.prev_hash || '') + canonicalPayload;
      const computedHash = createHash('sha256').update(hashInput).digest('hex');

      if (computedHash !== event.hash) {
        brokenLinks.push({
          sequence_num: Number(event.sequence_num),
          event_id: event.id,
          expected_hash: computedHash,
          actual_hash: event.hash,
        });
      } else {
        verifiedCount++;
      }
    }

    // Compare final hash to audit_anchors.root_hash
    let anchorMatch: boolean | null = null;
    const anchor = await this.auditAnchorRepo.findOne({
      where: { anchor_date: dateStr },
    });

    if (anchor && events.length > 0) {
      const lastEvent = events[events.length - 1];
      anchorMatch = lastEvent.hash === anchor.root_hash;

      if (!anchorMatch) {
        this.logger.warn(
          `Anchor mismatch for ${dateStr}: expected ${anchor.root_hash}, got ${lastEvent.hash}`,
        );
      }
    } else if (anchor && events.length === 0) {
      // Anchor exists but no events -- check if anchor is the null hash
      anchorMatch = anchor.root_hash === '0'.repeat(64) && anchor.event_count === 0;
    }

    const report: VerificationReport = {
      date: dateStr,
      status: brokenLinks.length === 0 && anchorMatch !== false ? 'pass' : 'fail',
      total_events: events.length,
      verified_events: verifiedCount,
      broken_links: brokenLinks,
      anchor_match: anchorMatch,
      duration_ms: Date.now() - startTime,
    };

    this.logger.log(
      `Verification for ${dateStr}: ${report.status} (${verifiedCount}/${events.length} events, ${brokenLinks.length} broken links)`,
    );

    return report;
  }
}
