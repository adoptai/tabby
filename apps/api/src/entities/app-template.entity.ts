import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { TenantEntity } from './tenant.entity';

@Entity('app_templates')
export class AppTemplateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
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

  /**
   * Whether apps auto-provisioned from this template have the execute capability
   * (POST /execute/fetch | /execute/browser). The controller only provisions the
   * worker Service + NetworkPolicy ingress + JWT_SIGNING_KEY when the app's
   * execute_enabled is true, so this must be carried onto each cloned app or the
   * per-user connection can never run execute calls. Mirrors applications.execute_enabled.
   */
  @Column({ type: 'boolean', default: false })
  execute_enabled: boolean;

  /**
   * Whether apps auto-provisioned from this template route their browser session
   * egress through the residential proxy (Oxylabs) chained upstream of Tabby's
   * egress proxy. App-level default for the app's execute sessions; a session may
   * override via sessions.residential_proxy_enabled. Mirrors
   * applications.residential_proxy_enabled. Whole-session scope; `.adopt.ai`/internal
   * hosts always dial direct regardless of this flag.
   */
  @Column({ type: 'boolean', default: false })
  residential_proxy_enabled: boolean;

  /**
   * Whether this template is active. Inactive templates are skipped by
   * auto-provisioning (autoProvisionFromTemplate treats is_active=false like a
   * missing template), so no new per-user apps are cloned from them. Existing
   * provisioned apps/profiles/sessions are unaffected — this is a soft on/off
   * switch, not a teardown. Not propagated to linked apps and not part of the
   * content hash, so toggling it never version-bumps downstream profiles.
   */
  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  /**
   * Extra egress domains cloned onto every app auto-provisioned from this
   * template. Mirrors applications.extra_egress_allowlist. NoUI populates this
   * from recorded HAR so per-user sessions inherit the full domain set.
   */
  @Column({ type: 'jsonb', default: () => `'[]'` })
  extra_egress_allowlist: string[];

  @Column({ type: 'integer', nullable: true })
  idle_shutdown_seconds: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
