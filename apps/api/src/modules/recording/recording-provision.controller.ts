import {
  BadRequestException,
  Body,
  Controller,
  GatewayTimeoutException,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import type { RecordingMode } from '@browser-hitl/shared';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { SessionEntity, ApplicationEntity } from '../../entities';
import { AppsService } from '../apps/apps.service';
import { SessionsService } from '../sessions/sessions.service';
import { VncStreamProvider } from '../streaming/vnc-stream.provider';
import { RecordingStore } from './recording.store';
import { RecordingPoolService } from './recording-pool.service';

interface CreateRecordingSessionBody {
  recording_mode?: RecordingMode;
  start_url?: string;
  /**
   * Session reuse: seed this recording browser with the cookies captured by a
   * prior login recording (that session's id), so the human starts already
   * authenticated — no stored credentials. Typically a workflow recording
   * `--from` a login recording.
   */
  source_session_id?: string;
  /**
   * Per-session override for residential-proxy egress. When set, this recording
   * session routes (or does not route) through the residential proxy regardless
   * of the recording-shell app default. Omit to inherit the app default.
   */
  residential_proxy?: boolean;
}

/**
 * Provisions a "recording-shell" app + session and returns an authenticated
 * VNC URL (with ?mode=recording so the viewer shows the Finish & export panel).
 *
 * This is the "agent generates a URL" entrypoint. Lives in its own module to
 * avoid a cycle (StreamingModule already imports RecordingModule for the
 * RecordingStore used by the stop endpoint).
 */
@ApiTags('Recording')
@ApiBearerAuth()
@Controller('recording')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RecordingProvisionController {
  private readonly logger = new Logger(RecordingProvisionController.name);

  constructor(
    private readonly appsService: AppsService,
    private readonly sessionsService: SessionsService,
    private readonly vncStreamProvider: VncStreamProvider,
    private readonly recordingStore: RecordingStore,
    private readonly recordingPool: RecordingPoolService,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
  ) {}

  @Post('sessions')
  @Roles('Admin', 'Editor', 'Operator', 'Agent')
  async createRecordingSession(@Body() body: CreateRecordingSessionBody, @Req() req: any) {
    const mode: RecordingMode = body?.recording_mode === 'workflow' ? 'workflow' : 'login';
    const startUrl = (body?.start_url || '').trim() || 'about:blank';
    const tenantId: string = req.user.tenant_id;
    const ownerUserId: string | null = req.user.owner_user_id ?? null;
    const actorId: string = req.user.user_id || 'system';

    if (startUrl !== 'about:blank') {
      try {
        const scheme = new URL(startUrl).protocol;
        if (scheme !== 'http:' && scheme !== 'https:') {
          throw new BadRequestException('start_url must be http(s)');
        }
      } catch {
        throw new BadRequestException('start_url is not a valid URL');
      }
    }

    // Session reuse: pull cookies captured by a prior login recording so the
    // worker can seed this browser (the human starts already authenticated).
    let seedCookies: unknown[] = [];
    const sourceSessionId = (body?.source_session_id || '').trim();
    if (sourceSessionId) {
      try {
        const sourceBundle = await this.recordingStore.retrieve(tenantId, sourceSessionId);
        const cookies = sourceBundle?.cookies ?? [];
        if (cookies.length === 0) {
          throw new BadRequestException(
            `Source recording ${sourceSessionId} has no captured cookies. Re-record the ` +
              `login (cookie capture is newer than that recording) and retry.`,
          );
        }
        seedCookies = cookies;
        this.logger.log(`Seeding ${cookies.length} cookie(s) from source recording ${sourceSessionId}`);
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException(
          `Could not load source recording ${sourceSessionId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Warm pool is used only when enabled for this tenant AND the request isn't
    // asking for residential egress (a warm spare booted with the pool's proxy
    // config; honoring a per-request residential override needs a cold pod).
    const poolEligible =
      this.recordingPool.isEnabledForTenant(tenantId) && body?.residential_proxy !== true;

    // 1. Create the recording-shell app (no login, manual creds, recording mode).
    // desired=1 when pool-eligible so a claimed spare (or a reconcile-created
    // cold session on pool miss) is retained; desired=0 otherwise so the cold
    // path's scale() creates the session row inline (fast) in the request path.
    const shortId = randomUUID().slice(0, 8);
    const { app_id } = await this.appsService.create(
      {
        name: `recording-${mode}-${shortId}`,
        target_urls: [startUrl],
        // The worker SKIPS login DSL + keepalive actions in recording mode
        // (main.ts), so these are never executed — but the app DTO requires
        // non-empty arrays, so we provide minimal valid placeholders.
        // seed_cookies (if any) is read by the worker and injected via
        // context.addCookies() before the human drives the session.
        login_config: {
          login_url: startUrl,
          credential_ref: 'manual:',
          steps: [{ action: 'goto', url: startUrl }],
          ...(seedCookies.length > 0 ? { seed_cookies: seedCookies } : {}),
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
          recording_mode: mode,
        },
        notification_config: {},
        desired_session_count: poolEligible ? 1 : 0,
      },
      tenantId,
      actorId,
    );

    // 2. Scope the session to the requesting user (if federated) so the VNC
    //    OAuth gate matches.
    if (ownerUserId) {
      await this.appRepo.update(app_id, { owner_user_id: ownerUserId });
    }

    // 3. Warm-pool fast path: claim a pre-warmed spare and bind it to this
    //    target (seed cookies + navigate) instead of cold-starting a pod.
    if (poolEligible) {
      // Keep the tenant's pool warm / topped up (best-effort, off the hot path).
      this.recordingPool.ensurePoolApp(tenantId).catch((err) =>
        this.logger.warn(`ensurePoolApp failed for tenant ${tenantId}: ${err}`),
      );

      const claimed = await this.recordingPool.claimWarmSession(tenantId, app_id, ownerUserId);
      if (claimed?.pod_name) {
        await this.bindClaimedSession(claimed.pod_name, startUrl, seedCookies);
        const stream = await this.vncStreamProvider.getStreamUrl(claimed.id, ownerUserId || actorId);
        const vncUrl = stream.url.replace('#', '?mode=recording#');
        this.logger.log(
          `Provisioned recording session ${claimed.id} from warm pool (app ${app_id}, mode ${mode})`,
        );
        return {
          session_id: claimed.id,
          app_id,
          recording_mode: mode,
          vnc_url: vncUrl,
          expires_at: stream.expires_at,
          warm: true,
        };
      }
      this.logger.log(`Warm pool empty for tenant ${tenantId}; falling back to cold provisioning`);
      // Pool miss: the shell app already has desired=1, so the controller
      // reconcile will create a cold session; waitForSession picks it up below.
    } else {
      // Cold path: bump desired 0 -> 1, which creates the session row inline in
      // this request (fast) rather than waiting a reconcile tick.
      await this.sessionsService.scale(app_id, 1, tenantId, actorId, undefined, {
        residentialProxy: body?.residential_proxy,
      });
    }

    // 4. Wait for the session row, then mint the URL.
    const session = await this.waitForSession(app_id, tenantId);
    if (!session) {
      throw new GatewayTimeoutException(
        'Recording session did not start in time; retry shortly (app provisioned).',
      );
    }

    const stream = await this.vncStreamProvider.getStreamUrl(session.id, ownerUserId || actorId);
    const vncUrl = stream.url.replace('#', '?mode=recording#');
    this.logger.log(`Provisioned recording session ${session.id} (app ${app_id}, mode ${mode})`);

    return {
      session_id: session.id,
      app_id,
      recording_mode: mode,
      vnc_url: vncUrl,
      expires_at: stream.expires_at,
    };
  }

  /**
   * Bind a claimed warm spare to the recording target. Best-effort with one
   * retry: the pod is already HEALTHY (browser up on about:blank), so if the
   * bind navigation fails we still return the working VNC URL — the human sees
   * a live browser and can navigate manually — rather than failing the request.
   */
  private async bindClaimedSession(
    podName: string,
    startUrl: string,
    seedCookies: unknown[],
  ): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.recordingStore.bindWorker(podName, {
          start_url: startUrl,
          seed_cookies: seedCookies,
        });
        return;
      } catch (err) {
        if (attempt === 2) {
          this.logger.warn(
            `Bind failed for pod ${podName} after ${attempt} attempts (returning URL anyway): ${err}`,
          );
          return;
        }
      }
    }
  }

  private async waitForSession(
    appId: string,
    tenantId: string,
    timeoutMs = 45_000,
    intervalMs = 1_500,
  ): Promise<SessionEntity | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = await this.sessionRepo.findOne({
        where: { app_id: appId, tenant_id: tenantId },
        order: { started_at: 'DESC' },
      });
      if (session) return session;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }
}
