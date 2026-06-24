import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { SessionEntity } from '../../entities';
import { RecordingStore } from './recording.store';

/**
 * Agent-facing retrieval of a drained recording bundle. NoUI's orchestrator
 * pulls the bundle here (agent bearer token) after the human clicks
 * "Finish & export" in the VNC viewer (which hits the stream-token-authed
 * POST /vnc/:sessionId/recording-stop in the streaming controller).
 */
@ApiTags('Recording')
@ApiBearerAuth()
@Controller('recording')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RecordingController {
  constructor(
    private readonly store: RecordingStore,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
  ) {}

  @Get('sessions/:sessionId/bundle')
  @Roles('Admin', 'Editor', 'Operator', 'Agent')
  async getBundle(@Param('sessionId') sessionId: string, @Req() req: any) {
    const tenantId: string = req.user.tenant_id;
    const ownerUserId: string | null = req.user.owner_user_id ?? null;

    const session = await this.sessionRepo.findOne({ where: { id: sessionId, tenant_id: tenantId } });
    if (!session) throw new NotFoundException('Session not found');
    // Per-user scoping: a federated caller may only read their own session's bundle.
    if (ownerUserId && session.owner_user_id && session.owner_user_id !== ownerUserId) {
      throw new NotFoundException('Session not found');
    }

    const bundle = await this.store.retrieve(tenantId, sessionId);
    if (!bundle) throw new NotFoundException('No recording bundle for this session');
    return bundle;
  }
}
