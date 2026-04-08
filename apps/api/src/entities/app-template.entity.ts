import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { TenantEntity } from './tenant.entity';

@Entity('app_templates')
export class AppTemplateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenant_id: string;

  @ManyToOne(() => TenantEntity)
  @JoinColumn({ name: 'tenant_id' })
  tenant: TenantEntity;

  @Column({ type: 'varchar' })
  name: string;

  /** Matches the profile_id in credential requests for auto-provisioning */
  @Column({ type: 'varchar' })
  profile_name_pattern: string;

  @Column({ type: 'jsonb' })
  login_config: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  keepalive_config: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  export_policy: Record<string, unknown>;

  @Column({ type: 'jsonb', default: '{"clipboard":false,"downloads":false,"file_chooser":false}' })
  browser_policy: Record<string, unknown>;

  @Column({ type: 'jsonb', default: '{}' })
  notification_config: Record<string, unknown>;

  @Column({ type: 'varchar', default: 'manual:' })
  credential_ref_default: string;

  @Column({ type: 'integer', nullable: true })
  idle_shutdown_seconds: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
