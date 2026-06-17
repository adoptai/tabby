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
    tenantId: string | undefined,
    actorId: string,
  ): Promise<{ desired_sessions: number; app_id: string }> {
    const where: any = tenantId ? { id: appId, tenant_id: tenantId } : { id: appId };
    const app = await this.appRepo.findOne({ where });
    if (!app) {
      throw new NotFoundException('Application not found');
    }

    const effectiveTenantId = tenantId ?? app.tenant_id;
    const tenant = await this.tenantRepo.findOne({ where: { id: effectiveTenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (desiredSessions < 0) {
      throw new BadRequestException('desired_sessions must be >= 0');
    }

    if (desiredSessions > tenant.max_sessions) {
      throw new BadRequestException(
        `desired_sessions (${desiredSessions}) exceeds tenant max_sessions (${tenant.max_sessions}). `
        + `To increase the limit, call PATCH /tenants/${effectiveTenantId} with { "max_sessions": <new_limit> }.`,
      );
    }

    app.desired_session_count = desiredSessions;
    await this.appRepo.save(app);

    await this.auditService.log({
      tenant_id: effectiveTenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'sessions.scaled',
      payload: { app_id: appId, desired_sessions: desiredSessions },
    });

    return { desired_sessions: desiredSessions, app_id: appId };
  }

  async findAll(
    tenantId: string | undefined,
    limit: number,
    offset: number,
    ownerUserId?: string | null,
  ): Promise<{ data: SessionEntity[]; total: number; limit: number; offset: number }> {
    const where: any = {};
    if (tenantId) where.tenant_id = tenantId;
    if (ownerUserId) where.owner_user_id = ownerUserId;

    const [data, total] = await this.sessionRepo.findAndCount({
      where,
      relations: ['application'],
      take: limit,
      skip: offset,
      order: { started_at: 'DESC' },
    });

    return { data, total, limit, offset };
  }

  async findOne(id: string, tenantId?: string): Promise<SessionEntity> {
    const where: any = { id };
    if (tenantId) where.tenant_id = tenantId;
    const session = await this.sessionRepo.findOne({ where });
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    return session;
  }

  async findInterventions(
    sessionId: string,
    tenantId: string | undefined,
    limit: number,
    offset: number,
  ): Promise<{ data: InterventionEntity[]; total: number; limit: number; offset: number }> {
    // Verify session exists (and belongs to tenant when scoped)
    await this.findOne(sessionId, tenantId);

    const interventionWhere: any = { session_id: sessionId };
    if (tenantId) interventionWhere.tenant_id = tenantId;

    const [data, total] = await this.interventionRepo.findAndCount({
      where: interventionWhere,
      take: limit,
      skip: offset,
      order: { started_at: 'DESC' },
    });

    return { data, total, limit, offset };
  }
}
