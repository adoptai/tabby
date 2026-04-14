import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
  CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';
import { TenantEntity } from './tenant.entity';
import { ApplicationEntity } from './application.entity';
import { SessionEntity } from './session.entity';

/**
 * AuthRequest entity — tracks login serialization requests (ADR-012).
 *
 * Barrier 2 of the three-barrier login serialization system uses a partial
 * unique index on (tenant_id, app_id) WHERE state = 'IN_PROGRESS' to
 * prevent concurrent logins to the same target application.
 *
 * Lifecycle: RECEIVED → IN_PROGRESS → COMPLETED | FAILED | EXPIRED
 */
@Entity('auth_requests')
@Index('idx_auth_requests_tenant_app', ['tenant_id', 'app_id'])
export class AuthRequestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  session_id: string;

  @ManyToOne(() => SessionEntity)
  @JoinColumn({ name: 'session_id' })
  session: SessionEntity;

  @Column({ type: 'varchar' })
  tenant_id: string;

  @ManyToOne(() => TenantEntity)
  @JoinColumn({ name: 'tenant_id' })
  tenant: TenantEntity;

  @Column({ type: 'uuid' })
  app_id: string;

  @ManyToOne(() => ApplicationEntity)
  @JoinColumn({ name: 'app_id' })
  application: ApplicationEntity;

  @Column({
    type: 'enum',
    enum: ['RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXPIRED'],
    default: 'RECEIVED',
  })
  state: string;

  @Column({ type: 'text', nullable: true })
  failure_reason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
