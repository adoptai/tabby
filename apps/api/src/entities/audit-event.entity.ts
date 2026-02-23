import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
} from 'typeorm';
import { TenantEntity } from './tenant.entity';

@Entity('audit_events')
export class AuditEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'bigint', generated: 'increment', unique: true })
  sequence_num: number;

  @Column({ type: 'uuid', nullable: true })
  tenant_id: string | null;

  @ManyToOne(() => TenantEntity, { nullable: true })
  @JoinColumn({ name: 'tenant_id' })
  tenant: TenantEntity;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  timestamp: Date;

  @Column({ type: 'enum', enum: ['system', 'human'] })
  actor_type: string;

  @Column({ type: 'varchar' })
  actor_id: string;

  @Column({ type: 'varchar' })
  event_type: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 64, nullable: true })
  prev_hash: string | null;

  @Column({ type: 'varchar', length: 64 })
  hash: string;
}
