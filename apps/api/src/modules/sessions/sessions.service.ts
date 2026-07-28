import {
  Injectable, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import {
  SessionEntity, ApplicationEntity, TenantEntity, InterventionEntity, SessionBatonEntity,
} from '../../entities';
import { AuditService } from '../audit/audit.service';

/**
 * Capture the active New Relic transaction's W3C `traceparent`, or null when NR
 * is disabled / no active transaction. Used to park the scale request's trace
 * context on the app so the controller can continue it on the worker it spawns.
 */
/** Validate a W3C traceparent: `00-<32hex>-<16hex>-<2hex>`. Returns it (lower-
 *  cased) if well-formed and not the all-zero trace, else null. */
function normalizeTraceparent(tp: unknown): string | null {
  if (typeof tp !== 'string') {
    return null;
  }
  const v = tp.trim().toLowerCase();
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(v);
  if (!m || m[1] === '0'.repeat(32) || m[2] === '0'.repeat(16)) {
    return null;
  }
  return v;
}

function captureTraceparent(): string | null {
  try {
    if (process.env.NEWRELIC_ENABLED !== 'true') {
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const newrelic = require('newrelic');
    const txn = newrelic.getTransaction();
    if (!txn) {
      return null;
    }
    const headers: Record<string, string> = {};
    txn.insertDistributedTraceHeaders(headers);
    return headers.traceparent ?? null;
  } catch {
    return null;
  }
}

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
    @InjectRepository(SessionBatonEntity)
    private readonly batonRepo: Repository<SessionBatonEntity>,
    private readonly auditService: AuditService,
  ) {}

  async scale(
    appId: string,
    desiredSessions: number,
    tenantId: string | undefined,
    actorId: string,
    inboundTraceparent?: string,
    options?: { residentialProxy?: boolean },
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

    const previousDesired = app.desired_session_count;
    // Capture THIS request's W3C trace context on scale-up. Prefer the RAW
    // inbound `traceparent` header (deterministic — exactly what the caller
    // propagated) over newrelic.getTransaction(), which depends on the NR agent
    // having accepted the inbound distributed trace and can otherwise mint a
    // fresh trace, fragmenting the graph. We both (a) bind it to each session we
    // create below, and (b) park it on the app as a fallback for the
    // controller's own createSession path.
    const traceparent = desiredSessions > previousDesired
      ? (normalizeTraceparent(inboundTraceparent) || captureTraceparent())
      : null;
    if (traceparent) {
      app.pending_traceparent = traceparent;
    }
    app.desired_session_count = desiredSessions;
    await this.appRepo.save(app);

    // Scale-up: create the new session rows HERE, in the request path, each
    // stamped with THIS request's traceparent + a baton. The controller then
    // only provisions a pod for them (it won't double-create — they already
    // count toward its `actual`). Binding the trace per-session at creation
    // keeps the api -> controller -> worker trace connected, instead of routing
    // it through a single shared pending_traceparent slot, which races under
    // concurrent scale-ups and fragments the distributed trace.
    if (desiredSessions > previousDesired) {
      const activeCount = await this.sessionRepo.count({
        where: { app_id: appId, state: Not('TERMINATED' as any) },
      });
      const toCreate = Math.max(0, desiredSessions - activeCount);
      for (let i = 0; i < toCreate; i++) {
        const created = await this.sessionRepo.save(this.sessionRepo.create({
          app_id: appId,
          tenant_id: tenantId,
          state: 'STARTING' as any,
          state_version: 0,
          retry_count: 0,
          intervention_count: 0,
          hitl_attempt_count: 0,
          owner_user_id: app.owner_user_id ?? null,
          traceparent,
          // Per-session override; unset → null → inherit the app-level default.
          residential_proxy_enabled: options?.residentialProxy ?? null,
        }));
        await this.batonRepo.save(this.batonRepo.create({
          session_id: created.id,
          baton_state: 'AUTOMATION_CONTROL',
          version: 0,
        }));
      }
    }

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
