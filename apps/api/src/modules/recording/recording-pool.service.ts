import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RECORDING_POOL, type RecordingMode } from '@browser-hitl/shared';
import { ApplicationEntity, SessionEntity } from '../../entities';
import { AppsService } from '../apps/apps.service';

/**
 * Warm recording-session pool.
 *
 * Maintains, per opt-in tenant, a dedicated "pool app" whose sessions are
 * pre-warmed recording pods sitting on about:blank (browser up, noVNC serving,
 * health PASS). A recording request atomically CLAIMS one of these spares and
 * reassigns it to a per-target recording-shell app, then binds it (navigate +
 * seed cookies) — turning a ~1-2min cold pod bring-up into a sub-second claim.
 *
 * Cross-tenant reuse is impossible: recording bundles are stored in the tenant's
 * MinIO bucket under its encryption key, so a spare can only ever serve its own
 * tenant. The pool is therefore strictly per-tenant and opt-in via
 * RECORDING_POOL_TENANTS (empty = feature off → cold path everywhere).
 */
@Injectable()
export class RecordingPoolService implements OnModuleInit {
  private readonly logger = new Logger(RecordingPoolService.name);
  private readonly poolSize: number;
  private readonly poolTenants: Set<string>;
  private readonly allTenants: boolean;

  constructor(
    private readonly appsService: AppsService,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    private readonly dataSource: DataSource,
  ) {
    this.poolSize = Math.max(0, parseInt(process.env.RECORDING_POOL_SIZE || '0', 10) || 0);
    const raw = (process.env.RECORDING_POOL_TENANTS || '').trim();
    this.allTenants = raw === '*';
    this.poolTenants = new Set(
      raw && raw !== '*' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [],
    );
  }

  /** Pool active for this tenant? size>0 AND (tenant listed OR wildcard). */
  isEnabledForTenant(tenantId: string): boolean {
    if (this.poolSize <= 0) return false;
    return this.allTenants || this.poolTenants.has(tenantId);
  }

  async onModuleInit(): Promise<void> {
    if (this.poolSize <= 0) return;
    // Eagerly ensure pool apps for explicitly-listed tenants so spares warm
    // before the first request. A '*' wildcard can't be pre-enumerated, so those
    // tenants warm lazily on their first recording request.
    for (const tenantId of this.poolTenants) {
      try {
        await this.ensurePoolApp(tenantId);
      } catch (err) {
        this.logger.warn(`Failed to ensure pool app for tenant ${tenantId}: ${err}`);
      }
    }
  }

  /**
   * Find-or-create the tenant's pool app and keep its desired_session_count in
   * sync with RECORDING_POOL_SIZE. Idempotent + safe under concurrent API
   * replicas (re-reads on create race). Returns the pool app id.
   */
  async ensurePoolApp(tenantId: string): Promise<string> {
    const existing = await this.appRepo.findOne({
      where: { tenant_id: tenantId, name: RECORDING_POOL.APP_NAME },
    });
    if (existing) {
      if (existing.desired_session_count !== this.poolSize) {
        await this.appRepo.update(existing.id, { desired_session_count: this.poolSize });
      }
      return existing.id;
    }
    try {
      const { app_id } = await this.appsService.create(
        this.buildPoolAppInput(),
        tenantId,
        'system:recording-pool',
      );
      this.logger.log(
        `Created recording pool app ${app_id} for tenant ${tenantId} (size ${this.poolSize})`,
      );
      return app_id;
    } catch (err) {
      const raced = await this.appRepo.findOne({
        where: { tenant_id: tenantId, name: RECORDING_POOL.APP_NAME },
      });
      if (raced) return raced.id;
      throw err;
    }
  }

  /**
   * Atomically claim one WARM+HEALTHY spare and reassign it to the target
   * recording-shell app (stamping owner + CLAIMED) in a single UPDATE. FOR UPDATE
   * SKIP LOCKED lets concurrent API replicas grab distinct spares. Returns the
   * claimed session (with pod_name) or null if the pool is empty/not present.
   * Reassigning out of the pool app drops its active count, so the controller's
   * reconcile refills the spare on its next tick — top-up is free, off the
   * request path.
   */
  async claimWarmSession(
    tenantId: string,
    targetAppId: string,
    ownerUserId: string | null,
  ): Promise<SessionEntity | null> {
    const poolApp = await this.appRepo.findOne({
      where: { tenant_id: tenantId, name: RECORDING_POOL.APP_NAME },
    });
    if (!poolApp) return null;

    // Select-then-update inside one transaction. FOR UPDATE SKIP LOCKED locks
    // the picked spare for the txn so concurrent API replicas grab distinct
    // rows. (We don't use UPDATE ... RETURNING here: TypeORM's query() does not
    // reliably surface RETURNING rows for an UPDATE, which would make the claim
    // look empty even though it committed.)
    return this.dataSource.transaction(async (manager) => {
      const picked = await manager.query(
        `SELECT id FROM sessions
          WHERE app_id = $1 AND tenant_id = $2 AND pool_state = $3
            AND state = 'HEALTHY' AND pod_name IS NOT NULL
          ORDER BY started_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [poolApp.id, tenantId, RECORDING_POOL.WARM],
      );
      if (!picked || picked.length === 0) return null;
      const claimedId = picked[0].id;
      await manager.query(
        `UPDATE sessions SET app_id = $1, owner_user_id = $2, pool_state = $3 WHERE id = $4`,
        [targetAppId, ownerUserId, RECORDING_POOL.CLAIMED, claimedId],
      );
      return manager.getRepository(SessionEntity).findOne({ where: { id: claimedId } });
    });
  }

  private buildPoolAppInput() {
    // HTTPS placeholder: app validation requires https target_urls / goto steps,
    // and about:blank fails it. The value is inert — recording mode runs
    // unrestricted egress (resolveEgressOptions allowAll), so a claimed spare can
    // navigate to ANY target on bind with no per-target egress sync. The spare
    // warms on this page and bind re-navigates it to the real target.
    const PLACEHOLDER_URL = process.env.RECORDING_POOL_WARM_URL || 'https://example.com';
    return {
      name: RECORDING_POOL.APP_NAME,
      target_urls: [PLACEHOLDER_URL],
      login_config: {
        login_url: PLACEHOLDER_URL,
        credential_ref: 'manual:',
        steps: [{ action: 'goto', url: PLACEHOLDER_URL }],
      },
      keepalive_config: {
        interval_seconds: 60,
        actions: [],
        health_checks: [{ type: 'dom_check', selector: 'body', exists: true }],
      },
      export_policy: {
        artifact_types: ['cookies'],
        encryption: { algo: 'AES-256-GCM', key_version: 'v1' },
        ttl_seconds: 300,
      },
      browser_policy: {
        downloads: false,
        clipboard: false,
        file_chooser: false,
        recording_mode: 'login' as RecordingMode,
      },
      notification_config: {},
      desired_session_count: this.poolSize,
    };
  }
}
