import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { AuditEventEntity } from '../../entities';

interface AuditLogInput {
  tenant_id?: string;
  actor_type: 'system' | 'human';
  actor_id: string;
  event_type: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditEventEntity)
    private readonly auditRepo: Repository<AuditEventEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Append an audit event with hash chain integrity.
   * Uses pg_advisory_lock(42) for serialized writes per spec section 13.5.
   */
  async log(input: AuditLogInput): Promise<AuditEventEntity> {
    return this.dataSource.transaction(async (manager) => {
      // Acquire advisory lock for serialized audit writes
      await manager.query('SELECT pg_advisory_lock(42)');

      try {
        // Get the previous event's hash for chaining
        const lastEvent = await manager.query(
          `SELECT hash FROM audit_events ORDER BY sequence_num DESC LIMIT 1`
        );
        const prevHash: string | null = lastEvent.length > 0 ? lastEvent[0].hash : null;

        // Canonical JSON payload (sorted keys, no whitespace)
        const canonicalPayload = JSON.stringify(input.payload, Object.keys(input.payload).sort());

        // Compute hash: SHA256(prev_hash + canonical_payload)
        const hashInput = (prevHash || '') + canonicalPayload;
        const hash = createHash('sha256').update(hashInput).digest('hex');

        // Insert the event
        const event = manager.create(AuditEventEntity, {
          tenant_id: input.tenant_id || null,
          actor_type: input.actor_type,
          actor_id: input.actor_id,
          event_type: input.event_type,
          payload: input.payload,
          prev_hash: prevHash,
          hash,
        });

        return manager.save(event);
      } finally {
        await manager.query('SELECT pg_advisory_unlock(42)');
      }
    });
  }
}
