import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { TenantEntity } from './tenant.entity';

@Entity('applications')
export class ApplicationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenant_id: string;

  @ManyToOne(() => TenantEntity)
  @JoinColumn({ name: 'tenant_id' })
  tenant: TenantEntity;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'jsonb' })
  target_urls: string[];

  @Column({ type: 'jsonb' })
  login_config: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  keepalive_config: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  export_policy: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  notification_config: Record<string, unknown>;

  @Column({
    type: 'jsonb',
    default: () => `'{"downloads": false, "clipboard": false, "file_chooser": false}'`,
  })
  browser_policy: Record<string, unknown>;

  @Column({ type: 'integer', default: 1 })
  desired_session_count: number;

  @Column({ type: 'timestamptz', nullable: true })
  credential_last_validated_at: Date | null;

  @Column({ type: 'integer', default: 90 })
  credential_rotation_reminder_days: number;

  /** Owner user ID — if set, sessions created for this app are scoped to this user */
  @Column({ type: 'varchar', nullable: true })
  owner_user_id: string | null;

  /** Template this app was auto-provisioned from (null for manually-created apps) */
  @Column({ type: 'uuid', nullable: true })
  template_id: string | null;

  @Column({ type: 'boolean', default: false })
  execute_enabled: boolean;

  /** Timestamp of last reconcile pass by any controller replica (FOR UPDATE SKIP LOCKED) */
  @Column({ type: 'timestamptz', nullable: true })
  last_reconciled_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
