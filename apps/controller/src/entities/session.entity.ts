import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
} from 'typeorm';
import { ApplicationEntity } from './application.entity';
import { TenantEntity } from './tenant.entity';

@Entity('sessions')
export class SessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  app_id: string;

  @ManyToOne(() => ApplicationEntity)
  @JoinColumn({ name: 'app_id' })
  application: ApplicationEntity;

  @Column({ type: 'uuid' })
  tenant_id: string;

  @ManyToOne(() => TenantEntity)
  @JoinColumn({ name: 'tenant_id' })
  tenant: TenantEntity;

  @Column({
    type: 'enum',
    enum: ['STARTING', 'HEALTHY', 'UNHEALTHY', 'LOGIN_NEEDED', 'LOGIN_IN_PROGRESS', 'FAILED', 'TERMINATED'],
    default: 'STARTING',
  })
  state: string;

  @Column({ type: 'bigint', default: 0 })
  state_version: number;

  @Column({
    type: 'enum',
    enum: ['PASS', 'TRANSIENT_FAIL', 'AUTH_FAIL'],
    nullable: true,
  })
  health_result_type: string | null;

  @Column({ type: 'varchar', nullable: true })
  pod_name: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_health_check: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_login_at: Date | null;

  @Column({ type: 'integer', default: 0 })
  intervention_count: number;

  @Column({ type: 'integer', default: 0 })
  hitl_attempt_count: number;

  @Column({ type: 'timestamptz', nullable: true })
  hitl_pause_until: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  artifacts_last_exported_at: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  started_at: Date;

  @Column({ type: 'integer', default: 0 })
  retry_count: number;

  @Column({ type: 'jsonb', nullable: true })
  pending_input_request: Record<string, unknown> | null;
}
