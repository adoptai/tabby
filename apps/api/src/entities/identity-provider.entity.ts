import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { TenantEntity } from './tenant.entity';

@Entity('identity_providers')
export class IdentityProviderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenant_id: string;

  @ManyToOne(() => TenantEntity)
  @JoinColumn({ name: 'tenant_id' })
  tenant: TenantEntity;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar' })
  provider_type: 'oidc' | 'saml';

  // OIDC fields
  @Column({ type: 'varchar', nullable: true })
  issuer_url: string | null;

  @Column({ type: 'varchar', nullable: true })
  jwks_uri: string | null;

  @Column({ type: 'varchar', nullable: true })
  audience: string | null;

  @Column({ type: 'varchar', nullable: true })
  client_id: string | null;

  // Claim mapping
  @Column({ type: 'varchar', nullable: true })
  tenant_id_claim: string | null;

  @Column({ type: 'varchar', default: 'sub' })
  user_id_claim: string;

  @Column({ type: 'varchar', default: 'email' })
  email_claim: string;

  @Column({ type: 'jsonb', nullable: true })
  claim_mappings: Record<string, string> | null;

  // Behavior
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'boolean', default: false })
  allow_auto_provision: boolean;

  @Column({ type: 'varchar', default: 'Viewer' })
  default_role: string;

  @Column({ type: 'boolean', default: false })
  allow_shared_session_fallback: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
