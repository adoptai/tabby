import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { TenantEntity } from './tenant.entity';
import { ApplicationEntity } from './application.entity';

/**
 * Service Profile Entity (ADR-014).
 *
 * Versioned service profiles define login configuration, credential types
 * with volatility classification, and target domains. Profiles follow
 * a STAGING → CANARY → ACTIVE → RETIRED lifecycle with canary validation.
 */
@Entity('service_profiles')
export class ServiceProfileEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  tenant_id: string;

  @ManyToOne(() => TenantEntity)
  @JoinColumn({ name: 'tenant_id' })
  tenant: TenantEntity;

  /** FK to the application this profile targets (nullable for backfill) */
  @Column({ type: 'uuid', nullable: true })
  app_id: string | null;

  @ManyToOne(() => ApplicationEntity)
  @JoinColumn({ name: 'app_id' })
  application: ApplicationEntity;

  /** Semantic name (e.g., "salesforce-standard") */
  @Column({ type: 'varchar' })
  profile_id: string;

  /** Semver string (e.g., "1.0.0") */
  @Column({ type: 'varchar' })
  version: string;

  @Column({
    type: 'enum',
    enum: ['STAGING', 'CANARY', 'ACTIVE', 'RETIRED'],
    default: 'STAGING',
  })
  version_state: string;

  /** Parent version for rollback (self-referencing FK) */
  @Column({ type: 'uuid', nullable: true })
  parent_version_id: string | null;

  /** Login DSL steps (jsonb) */
  @Column({ type: 'jsonb' })
  login_config: Record<string, unknown>;

  /** Per-field volatility classification (jsonb) */
  @Column({ type: 'jsonb' })
  credential_types: Record<string, unknown>;

  /** Target domains (jsonb string[]) */
  @Column({ type: 'jsonb' })
  target_domains: string[];

  /** Per-profile login concurrency override */
  @Column({ type: 'integer', nullable: true })
  login_concurrency_limit: number | null;

  /** Extra config: keepalive, export policy, etc. */
  @Column({ type: 'jsonb', nullable: true })
  extra_config: Record<string, unknown> | null;

  /** Canary metrics: total request count */
  @Column({ type: 'integer', default: 0 })
  canary_request_count: number;

  /** Canary metrics: error count */
  @Column({ type: 'integer', default: 0 })
  canary_error_count: number;

  /** Timestamp of last promotion */
  @Column({ type: 'timestamptz', nullable: true })
  promoted_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  /** External user ID for per-user profile isolation (federated auth). Null = shared/tenant-scoped (backward compat). */
  @Column({ type: 'varchar', nullable: true })
  owner_user_id: string | null;
}
