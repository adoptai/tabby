import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  DEFAULTS,
  ProfileVersionState,
  isValidProfileTransition,
} from '@browser-hitl/shared';
import { ServiceProfileEntity } from '../../entities/service-profile.entity';
import { ApplicationEntity } from '../../entities/application.entity';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    @InjectRepository(ServiceProfileEntity)
    private readonly profileRepo: Repository<ServiceProfileEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
  ) {}

  // ---------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------

  async create(
    dto: {
      profile_id: string;
      app_id: string;
      version: string;
      login_config: Record<string, unknown>;
      credential_types: Record<string, unknown>;
      target_domains: string[];
      login_concurrency_limit?: number;
      extra_config?: Record<string, unknown>;
      parent_version_id?: string;
    },
    tenantId: string,
    actorId: string,
  ): Promise<ServiceProfileEntity> {
    // Validate app_id exists and belongs to the same tenant
    const application = await this.appRepo.findOne({
      where: { id: dto.app_id },
    });
    if (!application) {
      throw new NotFoundException(`Application ${dto.app_id} not found`);
    }
    if (application.tenant_id !== tenantId) {
      throw new ForbiddenException('Application does not belong to your tenant');
    }

    const entity = this.profileRepo.create({
      tenant_id: tenantId,
      app_id: dto.app_id,
      profile_id: dto.profile_id,
      version: dto.version,
      version_state: ProfileVersionState.STAGING,
      parent_version_id: dto.parent_version_id || null,
      login_config: dto.login_config,
      credential_types: dto.credential_types,
      target_domains: dto.target_domains,
      login_concurrency_limit: dto.login_concurrency_limit || null,
      extra_config: dto.extra_config || null,
    });

    const saved = await this.profileRepo.save(entity);

    this.logger.log(
      `Profile created: id=${saved.id} profile_id=${dto.profile_id} ` +
      `version=${dto.version} tenant=${tenantId}`,
    );

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'profile.created',
      payload: {
        profile_id: dto.profile_id,
        version: dto.version,
        entity_id: saved.id,
      },
    });

    return saved;
  }

  async findAll(
    tenantId: string,
    limit: number = DEFAULTS.PAGINATION_LIMIT,
    offset: number = DEFAULTS.PAGINATION_OFFSET,
  ): Promise<ServiceProfileEntity[]> {
    return this.profileRepo.find({
      where: { tenant_id: tenantId },
      order: { created_at: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  async findOne(id: string, tenantId: string): Promise<ServiceProfileEntity> {
    const profile = await this.profileRepo.findOne({
      where: { id, tenant_id: tenantId },
    });
    if (!profile) {
      throw new NotFoundException(`Profile ${id} not found`);
    }
    return profile;
  }

  // ---------------------------------------------------------------
  // State Machine: Promote
  // ---------------------------------------------------------------

  async promote(id: string, tenantId: string, actorId: string): Promise<ServiceProfileEntity> {
    const profile = await this.findOne(id, tenantId);
    const currentState = profile.version_state as ProfileVersionState;

    if (currentState === ProfileVersionState.STAGING) {
      // STAGING → CANARY
      if (!isValidProfileTransition(ProfileVersionState.STAGING, ProfileVersionState.CANARY)) {
        throw new BadRequestException('Invalid transition: STAGING → CANARY');
      }

      profile.version_state = ProfileVersionState.CANARY;
      profile.promoted_at = new Date();
      const saved = await this.profileRepo.save(profile);

      this.logger.log(`Profile promoted: ${id} STAGING → CANARY`);
      await this.auditService.log({
        tenant_id: tenantId,
        actor_type: 'human',
        actor_id: actorId,
        event_type: 'profile.promoted',
        payload: { entity_id: id, from: 'STAGING', to: 'CANARY' },
      });

      return saved;
    }

    if (currentState === ProfileVersionState.CANARY) {
      // CANARY → ACTIVE: validate minimum traffic
      if (profile.canary_request_count < DEFAULTS.CANARY_MIN_REQUESTS) {
        throw new BadRequestException(
          `Canary requires at least ${DEFAULTS.CANARY_MIN_REQUESTS} requests ` +
          `before promotion (current: ${profile.canary_request_count})`,
        );
      }

      // Evaluate canary health before promotion
      const evaluation = this.evaluateCanary(profile);
      if (!evaluation.healthy) {
        throw new BadRequestException(
          `Canary error rate too high: ${(evaluation.errorRate * 100).toFixed(1)}% ` +
          `(threshold: ${DEFAULTS.CANARY_ERROR_RATE_THRESHOLD * 100}%)`,
        );
      }

      // Transaction: retire old ACTIVE, activate this one
      return this.dataSource.transaction(async (manager) => {
        // Retire current ACTIVE for this profile_id
        await manager.update(ServiceProfileEntity, {
          tenant_id: tenantId,
          profile_id: profile.profile_id,
          version_state: ProfileVersionState.ACTIVE,
        }, {
          version_state: ProfileVersionState.RETIRED,
        });

        profile.version_state = ProfileVersionState.ACTIVE;
        profile.promoted_at = new Date();
        const saved = await manager.save(profile);

        this.logger.log(`Profile promoted: ${id} CANARY → ACTIVE`);
        await this.auditService.log({
          tenant_id: tenantId,
          actor_type: 'human',
          actor_id: actorId,
          event_type: 'profile.promoted',
          payload: { entity_id: id, from: 'CANARY', to: 'ACTIVE' },
        });

        return saved;
      });
    }

    throw new BadRequestException(
      `Cannot promote from ${currentState} — only STAGING and CANARY can be promoted`,
    );
  }

  // ---------------------------------------------------------------
  // State Machine: Rollback
  // ---------------------------------------------------------------

  async rollback(id: string, tenantId: string, actorId: string): Promise<ServiceProfileEntity> {
    const profile = await this.findOne(id, tenantId);
    const currentState = profile.version_state as ProfileVersionState;

    if (currentState === ProfileVersionState.CANARY) {
      // CANARY → STAGING: reset counters
      profile.version_state = ProfileVersionState.STAGING;
      profile.canary_request_count = 0;
      profile.canary_error_count = 0;
      const saved = await this.profileRepo.save(profile);

      this.logger.log(`Profile rolled back: ${id} CANARY → STAGING`);
      await this.auditService.log({
        tenant_id: tenantId,
        actor_type: 'human',
        actor_id: actorId,
        event_type: 'profile.rolledback',
        payload: { entity_id: id, from: 'CANARY', to: 'STAGING' },
      });

      return saved;
    }

    if (currentState === ProfileVersionState.ACTIVE) {
      // ACTIVE → RETIRED: reactivate parent
      if (!profile.parent_version_id) {
        throw new BadRequestException('Cannot rollback ACTIVE profile without parent_version_id');
      }

      return this.dataSource.transaction(async (manager) => {
        // Retire this version
        profile.version_state = ProfileVersionState.RETIRED;
        await manager.save(profile);

        // Reactivate parent
        const parent = await manager.findOne(ServiceProfileEntity, {
          where: { id: profile.parent_version_id!, tenant_id: tenantId },
        });
        if (!parent) {
          throw new NotFoundException(`Parent profile ${profile.parent_version_id} not found`);
        }
        parent.version_state = ProfileVersionState.ACTIVE;
        parent.promoted_at = new Date();
        await manager.save(parent);

        this.logger.log(
          `Profile rolled back: ${id} ACTIVE → RETIRED, parent ${parent.id} reactivated`,
        );
        await this.auditService.log({
          tenant_id: tenantId,
          actor_type: 'human',
          actor_id: actorId,
          event_type: 'profile.rolledback',
          payload: {
            entity_id: id,
            from: 'ACTIVE',
            to: 'RETIRED',
            reactivated_parent: parent.id,
          },
        });

        return profile;
      });
    }

    throw new BadRequestException(
      `Cannot rollback from ${currentState} — only CANARY and ACTIVE can be rolled back`,
    );
  }

  // ---------------------------------------------------------------
  // Canary Metrics
  // ---------------------------------------------------------------

  async recordCanaryResult(id: string, isError: boolean): Promise<void> {
    if (isError) {
      await this.profileRepo.increment({ id }, 'canary_error_count', 1);
    }
    await this.profileRepo.increment({ id }, 'canary_request_count', 1);
  }

  evaluateCanary(profile: ServiceProfileEntity): { healthy: boolean; errorRate: number } {
    if (profile.canary_request_count < DEFAULTS.CANARY_MIN_SAMPLE_SIZE) {
      // Not enough data — treat as healthy (don't block promotion prematurely)
      return { healthy: true, errorRate: 0 };
    }

    const errorRate = profile.canary_error_count / profile.canary_request_count;
    return {
      healthy: errorRate <= DEFAULTS.CANARY_ERROR_RATE_THRESHOLD,
      errorRate,
    };
  }

  // ---------------------------------------------------------------
  // Active Profile Resolution
  // ---------------------------------------------------------------

  async getActiveProfile(tenantId: string, profileId: string): Promise<ServiceProfileEntity> {
    const profile = await this.profileRepo.findOne({
      where: {
        tenant_id: tenantId,
        profile_id: profileId,
        version_state: ProfileVersionState.ACTIVE,
      },
    });
    if (!profile) {
      throw new NotFoundException(`No active profile found for "${profileId}"`);
    }
    return profile;
  }
}
