import {
  Injectable, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SessionEntity, ApplicationEntity, TenantEntity, InterventionEntity,
} from '../../entities';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class SessionsService {
  constructor(
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(TenantEntity)
    private readonly tenantRepo: Repository<TenantEntity>,
    @InjectRepository(InterventionEntity)
    private readonly interventionRepo: Repository<InterventionEntity>,
    private readonly auditService: AuditService,
  ) {}

  async scale(
    appId: string,
    desiredSessions: number,
    tenantId: string,
    actorId: string,
  ): Promise<{ desired_sessions: number; app_id: string }> {
    const app = await this.appRepo.findOne({ where: { id: appId, tenant_id: tenantId } });
    if (!app) {
      throw new NotFoundException('Application not found');
    }

    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (desiredSessions < 0) {
      throw new BadRequestException('desired_sessions must be >= 0');
    }

    if (desiredSessions > tenant.max_sessions) {
      throw new BadRequestException(
        `desired_sessions (${desiredSessions}) exceeds tenant max_sessions (${tenant.max_sessions})`,
      );
    }

    app.desired_session_count = desiredSessions;
    await this.appRepo.save(app);

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'sessions.scaled',
      payload: { app_id: appId, desired_sessions: desiredSessions },
    });

    return { desired_sessions: desiredSessions, app_id: appId };
  }

  async findAll(
    tenantId: string,
    limit: number,
    offset: number,
    ownerUserId?: string | null,
  ): Promise<{ data: SessionEntity[]; total: number; limit: number; offset: number }> {
    // Admins see all sessions in the tenant; non-Admins see only their own
    const where: any = ownerUserId
      ? { tenant_id: tenantId, owner_user_id: ownerUserId }
      : { tenant_id: tenantId };

    const [data, total] = await this.sessionRepo.findAndCount({
      where,
      relations: ['application'],
      take: limit,
      skip: offset,
      order: { started_at: 'DESC' },
    });

    return { data, total, limit, offset };
  }

  async findOne(id: string, tenantId: string): Promise<SessionEntity> {
    const session = await this.sessionRepo.findOne({
      where: { id, tenant_id: tenantId },
    });
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    return session;
  }

  async findInterventions(
    sessionId: string,
    tenantId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: InterventionEntity[]; total: number; limit: number; offset: number }> {
    // Verify session belongs to tenant
    await this.findOne(sessionId, tenantId);

    const [data, total] = await this.interventionRepo.findAndCount({
      where: { session_id: sessionId, tenant_id: tenantId },
      take: limit,
      skip: offset,
      order: { started_at: 'DESC' },
    });

    return { data, total, limit, offset };
  }
}
