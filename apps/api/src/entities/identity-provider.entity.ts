import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('identity_providers')
export class IdentityProviderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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
  auth_url: string | null;

  @Column({ type: 'varchar', nullable: true })
  token_url: string | null;

  @Column({ type: 'varchar', nullable: true })
  userinfo_url: string | null;

  @Column({ type: 'varchar', nullable: true })
  sign_out_url: string | null;

  /** Comma-separated OAuth scopes, e.g. "openid,email,profile" */
  @Column({ type: 'varchar', nullable: true })
  scopes: string | null;

  /** Email domains that get Admin role on auto-provision, e.g. ["adopt.ai"] */
  @Column({ type: 'jsonb', nullable: true })
  admin_domains: string[] | null;

  /** JWT claim containing source roles array, e.g. "roles" for Frontegg */
  @Column({ type: 'varchar', nullable: true })
  role_claim: string | null;

  /** Source role values that map to Tabby Admin */
  @Column({ type: 'jsonb', nullable: true })
  admin_role_values: string[] | null;

  /** Source role values that map to Tabby Editor */
  @Column({ type: 'jsonb', nullable: true })
  editor_role_values: string[] | null;

  // Claim mapping
  @Column({ type: 'varchar', nullable: true })
  tenant_id_claim: string | null;

  @Column({ type: 'varchar', default: 'sub' })
  user_id_claim: string;

  @Column({ type: 'varchar', default: 'email' })
  email_claim: string;

  @Column({ type: 'varchar', default: 'name' })
  name_claim: string;

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
