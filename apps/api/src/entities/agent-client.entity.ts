import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { TenantEntity } from './tenant.entity';

/**
 * Agent client entity for OAuth 2.0 Client Credentials (ADR-010).
 *
 * Each agent deployment is registered as a client with:
 * - Scoped access to specific service profiles
 * - HMAC-SHA256 hashed secret (NOT bcrypt — machine secrets are high-entropy)
 * - Independent revocation and rotation
 * - Per-agent rate limiting
 */
@Entity('agent_clients')
export class AgentClientEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  @Index()
  client_id: string;

  @Column({ type: 'varchar' })
  client_secret_hash: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar' })
  tenant_id: string;

  @ManyToOne(() => TenantEntity)
  @JoinColumn({ name: 'tenant_id' })
  tenant: TenantEntity;

  @Column({ type: 'simple-array' })
  allowed_profiles: string[];

  @Column({ type: 'integer', default: 3600 })
  token_ttl_seconds: number;

  @Column({ type: 'integer', default: 30 })
  rate_limit_per_minute: number;

  @Column({ type: 'boolean', default: false })
  unrestricted_profiles: boolean;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  last_used_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
