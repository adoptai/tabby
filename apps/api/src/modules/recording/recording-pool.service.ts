import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { RECORDING_POOL, type RecordingMode } from '@browser-hitl/shared';
import { ApplicationEntity, SessionEntity } from '../../entities';
import { AppsService } from '../apps/apps.service';

// Warm-claim miss handling. When the pool is momentarily drained (a burst claimed
// every HEALTHY spare) but a refill is already warming, waiting a few seconds for
// a spare to go HEALTHY beats cold-starting a brand-new pod: a warming spare is
// usually seconds away, whereas a cold bring-up is ~1min AND leaves an extra pod
// behind. Kept as constants (not env) to avoid widening the deploy env chain.
const CLAIM_WAIT_MS = 15_000;
const CLAIM_POLL_MS = 1_500;

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
  private readonly residentialPoolSize: number;
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
    this.residentialPoolSize = Math.max(
      0,
      parseInt(process.env.RECORDING_POOL_RESIDENTIAL_SIZE || '0', 10) || 0,
    );
    const raw = (process.env.RECORDING_POOL_TENANTS || '').trim();
    this.allTenants = raw === '*';
    this.poolTenants = new Set(
      raw && raw !== '*' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [],
    );
  }

  /** Desired warm-spare count for the requested flavor. */
  private sizeFor(residential: boolean): number {
    return residential ? this.residentialPoolSize : this.poolSize;
  }

  /** Well-known pool app name for the requested flavor. */
  private appNameFor(residential: boolean): string {
    return residential ? RECORDING_POOL.RESIDENTIAL_APP_NAME : RECORDING_POOL.APP_NAME;
  }

  /**
   * Pool active for this tenant + flavor? The flavor's size>0 AND (tenant listed
   * OR wildcard). Residential and non-residential capacity are sized
   * independently (RECORDING_POOL_SIZE vs RECORDING_POOL_RESIDENTIAL_SIZE), so a
   * tenant can have a warm pool for one flavor and cold-start the other.
   */
  isEnabledForTenant(tenantId: string, residential = false): boolean {
    if (this.sizeFor(residential) <= 0) return false;
    return this.allTenants || this.poolTenants.has(tenantId);
  }

  async onModuleInit(): Promise<void> {
    if (this.poolSize <= 0 && this.residentialPoolSize <= 0) return;
    // Eagerly ensure pool apps for explicitly-listed tenants so spares warm
    // before the first request. A '*' wildcard can't be pre-enumerated, so those
    // tenants warm lazily on their first recording request. Each enabled flavor
    // gets its own pool app.
    for (const tenantId of this.poolTenants) {
      for (const residential of [false, true]) {
        if (this.sizeFor(residential) <= 0) continue;
        try {
          await this.ensurePoolApp(tenantId, residential);
        } catch (err) {
          this.logger.warn(
            `Failed to ensure ${residential ? 'residential ' : ''}pool app for tenant ${tenantId}: ${err}`,
          );
        }
      }
    }
  }

  /**
   * Find-or-create the tenant's pool app for the given flavor and keep its
   * desired_session_count in sync with the flavor's configured size. Idempotent +
   * safe under concurrent API replicas (re-reads on create race). Returns the
   * pool app id.
   */
  async ensurePoolApp(tenantId: string, residential = false): Promise<string> {
    const appName = this.appNameFor(residential);
    const size = this.sizeFor(residential);
    const existing = await this.appRepo.findOne({
      where: { tenant_id: tenantId, name: appName },
    });
    if (existing) {
      if (existing.desired_session_count !== size) {
        await this.appRepo.update(existing.id, { desired_session_count: size });
      }
      return existing.id;
    }
    try {
      const { app_id } = await this.appsService.create(
        this.buildPoolAppInput(residential),
        tenantId,
        'system:recording-pool',
      );
      this.logger.log(
        `Created ${residential ? 'residential ' : ''}recording pool app ${app_id} for tenant ${tenantId} (size ${size})`,
      );
      return app_id;
    } catch (err) {
      const raced = await this.appRepo.findOne({
        where: { tenant_id: tenantId, name: appName },
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
    residential = false,
  ): Promise<SessionEntity | null> {
    const poolApp = await this.appRepo.findOne({
      where: { tenant_id: tenantId, name: this.appNameFor(residential) },
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
      // Retain the reassigned spare atomically with the claim. The recording-shell
      // app is created with desired_session_count=0 (see the provision controller)
      // so a claim-wait poll can neither spawn a phantom cold pod (desired=1 with 0
      // sessions) nor let reconcile reap the spare (desired=0 with 1 session). Set
      // desired=1 in the SAME transaction so reconcile only ever sees a consistent
      // (desired=1, 1 session) pair.
      await manager.query(
        `UPDATE applications SET desired_session_count = 1 WHERE id = $1`,
        [targetAppId],
      );
      return manager.getRepository(SessionEntity).findOne({ where: { id: claimedId } });
    });
  }

  /**
   * Claim a warm spare, waiting briefly for one to become HEALTHY on a transient
   * miss. Returns immediately on a hit. On a miss it waits ONLY when a spare is
   * already warming (a refill is in flight) — an empty pool with nothing warming
   * cold-starts right away, adding zero latency. Bounded by CLAIM_WAIT_MS so a
   * slow refill still falls back to cold provisioning rather than hanging.
   */
  async claimWarmSessionWithWait(
    tenantId: string,
    targetAppId: string,
    ownerUserId: string | null,
    residential = false,
  ): Promise<SessionEntity | null> {
    const immediate = await this.claimWarmSession(tenantId, targetAppId, ownerUserId, residential);
    if (immediate) return immediate;
    if (CLAIM_WAIT_MS <= 0) return null;
    // Nothing warming → nothing to wait for; let the caller cold-start now.
    if ((await this.countWarmingSpares(tenantId, residential)) === 0) return null;
    const deadline = Date.now() + CLAIM_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
      const claimed = await this.claimWarmSession(tenantId, targetAppId, ownerUserId, residential);
      if (claimed) return claimed;
    }
    return null;
  }

  /**
   * How many spares for this tenant+flavor are still warming (WARM pool_state but
   * not yet HEALTHY). >0 means a refill is in flight and worth waiting a moment
   * for; 0 means the pool is genuinely empty and the caller should cold-start.
   */
  private async countWarmingSpares(tenantId: string, residential: boolean): Promise<number> {
    const poolApp = await this.appRepo.findOne({
      where: { tenant_id: tenantId, name: this.appNameFor(residential) },
    });
    if (!poolApp) return 0;
    return this.sessionRepo.count({
      where: {
        app_id: poolApp.id,
        tenant_id: tenantId,
        pool_state: RECORDING_POOL.WARM,
        state: In(['STARTING', 'UNHEALTHY']),
      },
    });
  }

  private buildPoolAppInput(residential = false) {
    // HTTPS placeholder: app validation requires https target_urls / goto steps,
    // and about:blank fails it. The value is inert — recording mode runs
    // unrestricted egress (resolveEgressOptions allowAll), so a claimed spare can
    // navigate to ANY target on bind with no per-target egress sync. The spare
    // warms on this page and bind re-navigates it to the real target.
    const PLACEHOLDER_URL = process.env.RECORDING_POOL_WARM_URL || 'https://example.com';
    return {
      name: this.appNameFor(residential),
      target_urls: [PLACEHOLDER_URL],
      // Residential pool spares warm with residential egress active (the session
      // rows also carry an explicit residential flag — see reconcile.createSession
      // — so it survives reassignment to the target shell app on claim).
      residential_proxy_enabled: residential,
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
      desired_session_count: this.sizeFor(residential),
    };
  }
}
