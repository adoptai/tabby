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

interface CreateRecordingSessionBody {
  recording_mode?: RecordingMode;
  start_url?: string;
  /** Reserved: bind a workflow recording to an existing authenticated profile. */
  profile_id?: string;
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
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
  ) {}

  @Post('sessions')
  @Roles('Admin', 'Operator', 'Agent')
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

    // 1. Create the recording-shell app (no login, manual creds, recording mode).
    const shortId = randomUUID().slice(0, 8);
    const { app_id } = await this.appsService.create(
      {
        name: `recording-${mode}-${shortId}`,
        target_urls: [startUrl],
        // The worker SKIPS login DSL + keepalive actions in recording mode
        // (main.ts), so these are never executed — but the app DTO requires
        // non-empty arrays, so we provide minimal valid placeholders.
        login_config: {
          login_url: startUrl,
          credential_ref: 'manual:',
          steps: [{ action: 'goto', url: startUrl }],
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
        desired_session_count: 0,
      },
      tenantId,
      actorId,
    );

    // 2. Scope the session to the requesting user (if federated) so the VNC
    //    OAuth gate matches, then scale up a single session.
    if (ownerUserId) {
      await this.appRepo.update(app_id, { owner_user_id: ownerUserId });
    }
    await this.sessionsService.scale(app_id, 1, tenantId, actorId);

    // 3. Wait for the controller to create the session row, then mint the URL.
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
