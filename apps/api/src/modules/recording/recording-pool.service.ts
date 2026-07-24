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
 * Maintains a single GLOBAL "pool app" (per flavor) — owned by the sentinel
 * system tenant — whose sessions are pre-warmed recording pods sitting on
 * about:blank (browser up, noVNC serving, health PASS). A recording request
 * atomically CLAIMS one of these spares, reassigns it to a per-target
 * recording-shell app AND rebinds its tenant_id to the requesting tenant, then
 * binds it (navigate + seed cookies) — turning a ~1-2min cold pod bring-up into
 * a sub-second claim, for EVERY tenant, with no per-tenant/per-flavor lazy-warm
 * gap (the shared pool is warmed once at boot).
 *
 * Cross-tenant reuse is safe: the bundle encryption key is process-wide (not
 * per-tenant), the MinIO bucket is derived from the session's tenant_id at
 * persist time (which the claim rebinds to the requesting tenant), and a spare
 * is single-use — claimed → becomes a real recording → terminated, never
 * re-pooled. The feature is opt-in via RECORDING_POOL_TENANTS (empty = off);
 * that list now gates only WHICH tenants may claim from the shared pool.
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

  /**
   * Is the pool feature on for this flavor at all — i.e. size>0 AND at least one
   * tenant (or '*') may claim? The tenant-agnostic counterpart of
   * isEnabledForTenant, used to decide whether to warm the shared pool at boot.
   */
  private featureEnabled(residential: boolean): boolean {
    return this.sizeFor(residential) > 0 && (this.allTenants || this.poolTenants.size > 0);
  }

  async onModuleInit(): Promise<void> {
    if (this.poolSize <= 0 && this.residentialPoolSize <= 0) return;
    // Warm the GLOBAL pool once at boot. Unlike the old per-tenant pool this no
    // longer depends on enumerating tenants (the shared pool serves every enabled
    // tenant), so a '*' wildcard is pre-warmed too — eliminating the first-request
    // cold start. Each enabled flavor gets its own global pool app.
    for (const residential of [false, true]) {
      if (!this.featureEnabled(residential)) continue;
      try {
        await this.ensurePoolApp(residential);
      } catch (err) {
        this.logger.warn(
          `Failed to ensure ${residential ? 'residential ' : ''}global pool app: ${err}`,
        );
      }
    }
  }

  /**
   * Find-or-create the GLOBAL pool app for the given flavor (owned by the system
   * tenant) and keep its desired_session_count in sync with the flavor's
   * configured size. Idempotent + safe under concurrent API replicas (re-reads on
   * create race). Returns the pool app id.
   */
  async ensurePoolApp(residential = false): Promise<string> {
    const appName = this.appNameFor(residential);
    const size = this.sizeFor(residential);
    const tenantId = RECORDING_POOL.SYSTEM_TENANT_ID;
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
        `Created global ${residential ? 'residential ' : ''}recording pool app ${app_id} (size ${size})`,
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
      where: { tenant_id: RECORDING_POOL.SYSTEM_TENANT_ID, name: this.appNameFor(residential) },
    });
    if (!poolApp) return null;

    // Select-then-update inside one transaction. FOR UPDATE SKIP LOCKED locks
    // the picked spare for the txn so concurrent API replicas grab distinct
    // rows. (We don't use UPDATE ... RETURNING here: TypeORM's query() does not
    // reliably surface RETURNING rows for an UPDATE, which would make the claim
    // look empty even though it committed.) app_id alone scopes the pick to the
    // global pool app — no tenant predicate, since spares are tenant-agnostic
    // until claimed.
    return this.dataSource.transaction(async (manager) => {
      const picked = await manager.query(
        `SELECT id FROM sessions
          WHERE app_id = $1 AND pool_state = $2
            AND state = 'HEALTHY' AND pod_name IS NOT NULL
          ORDER BY started_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [poolApp.id, RECORDING_POOL.WARM],
      );
      if (!picked || picked.length === 0) return null;
      const claimedId = picked[0].id;
      // Rebind the spare to the requesting tenant AS PART OF the claim. This is
      // load-bearing: persist() derives the per-tenant MinIO bucket from
      // session.tenant_id, so the exported bundle lands in the CLAIMING tenant's
      // bucket, not the system pool's. (The worker pod's baked TENANT_ID env goes
      // stale here but is unused on the recording path — drain is raw, encrypt +
      // persist are API-side off this DB row.)
      //
      // Stamp last_activity_at = NOW() so the idle reaper measures idleness from
      // the CLAIM, not the spare's (older) started_at. A warm spare may have sat
      // warm for a while; without this the claimed session would look
      // pre-aged/idle the instant it's handed over and get reaped mid-login.
      await manager.query(
        `UPDATE sessions SET app_id = $1, owner_user_id = $2, pool_state = $3, tenant_id = $4, last_activity_at = NOW() WHERE id = $5`,
        [targetAppId, ownerUserId, RECORDING_POOL.CLAIMED, tenantId, claimedId],
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
    if ((await this.countWarmingSpares(residential)) === 0) return null;
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
  private async countWarmingSpares(residential: boolean): Promise<number> {
    const poolApp = await this.appRepo.findOne({
      where: { tenant_id: RECORDING_POOL.SYSTEM_TENANT_ID, name: this.appNameFor(residential) },
    });
    if (!poolApp) return 0;
    return this.sessionRepo.count({
      where: {
        app_id: poolApp.id,
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
