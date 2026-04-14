import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, ManyToOne, JoinColumn,
} from 'typeorm';
import { AuthRequestEntity } from './auth-request.entity';

/**
 * Login Queue Entity (ADR-015).
 *
 * PostgreSQL-backed queue for global login coordination.
 * Survives Redis outages (durability requirement per ADR-015).
 *
 * The coordinator enforces three rate limits:
 *   LIMIT 1: Max concurrent logins system-wide (default: 5)
 *   LIMIT 2: Max concurrent logins per target domain (default: 3, configurable)
 *   LIMIT 3: Min interval between logins for same credential set (60s, via ADR-012)
 */
@Entity('login_queue')
@Index('idx_login_queue_domain_requested', ['target_domain', 'requested_at'])
@Index('idx_login_queue_state', ['state'])
export class LoginQueueEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  auth_request_id: string;

  @ManyToOne(() => AuthRequestEntity)
  @JoinColumn({ name: 'auth_request_id' })
  auth_request: AuthRequestEntity;

  @Column({ type: 'varchar' })
  tenant_id: string;

  @Column({ type: 'uuid' })
  app_id: string;

  /** Normalized root domain (e.g., "salesforce.com" for login.salesforce.com) */
  @Column({ type: 'varchar' })
  target_domain: string;

  @Column({ type: 'integer', default: 0 })
  priority: number;

  @Column({
    type: 'enum',
    enum: ['QUEUED', 'RUNNING', 'DONE', 'FAILED'],
    default: 'QUEUED',
  })
  state: string;

  @CreateDateColumn({ type: 'timestamptz' })
  requested_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  started_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date | null;

  @Column({ type: 'text', nullable: true })
  failure_reason: string | null;
}
