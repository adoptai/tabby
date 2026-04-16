import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
} from 'typeorm';
import { SessionEntity } from './session.entity';
import { TenantEntity } from './tenant.entity';
import { ApplicationEntity } from './application.entity';

@Entity('interventions')
export class InterventionEntity {
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

  @Column({ type: 'timestamptz', default: () => 'now()' })
  started_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date | null;

  @Column({ type: 'enum', enum: ['OTP', 'CAPTCHA', 'MANUAL', 'OTHER'] })
  type: string;

  @Column({ type: 'enum', enum: ['SUCCESS', 'FAIL', 'TIMEOUT'], nullable: true })
  outcome: string | null;

  @Column({ type: 'text', nullable: true })
  human_note: string | null;

  @Column({ type: 'jsonb', nullable: true })
  screenshots_ref: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  input_request_metadata: Record<string, unknown> | null;
}
