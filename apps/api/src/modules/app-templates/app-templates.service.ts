import { Injectable, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createHash } from 'crypto';
import { ProfileVersionState } from '@browser-hitl/shared';
import { AppTemplateEntity, ApplicationEntity, ServiceProfileEntity } from '../../entities';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class AppTemplatesService {
  private readonly logger = new Logger(AppTemplatesService.name);

  constructor(
    @InjectRepository(AppTemplateEntity)
    private readonly templateRepo: Repository<AppTemplateEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ServiceProfileEntity)
    private readonly profileRepo: Repository<ServiceProfileEntity>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
  ) {}

  async create(tenantId: string, data: Partial<AppTemplateEntity>, actorId: string) {
    const existing = await this.templateRepo.findOne({
      where: { tenant_id: tenantId, name: data.name },
    });
    if (existing) {
      throw new ConflictException(`Template "${data.name}" already exists`);
    }

    const template = this.templateRepo.create({ ...data, tenant_id: tenantId });
    const saved = await this.templateRepo.save(template);

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'app_template.created',
      payload: { template_id: saved.id, name: saved.name },
    });

    return this.withHash(saved);
  }

  async findAll(tenantId?: string) {
    const where = tenantId ? { tenant_id: tenantId } : {};
    const templates = await this.templateRepo.find({
      where,
      order: { created_at: 'DESC' },
    });
    return templates.map(t => this.withHash(t));
  }

  async findOne(tenantId: string | undefined, id: string) {
    const where: Record<string, string> = { id };
    if (tenantId) where.tenant_id = tenantId;
    const template = await this.templateRepo.findOne({ where });
    if (!template) throw new NotFoundException('App template not found');
    return this.withHash(template);
  }

  async findByPattern(tenantId: string, profileNamePattern: string) {
    return this.templateRepo.findOne({
      where: { tenant_id: tenantId, profile_name_pattern: profileNamePattern },
    });
  }

  async update(tenantId: string | undefined, id: string, data: Partial<AppTemplateEntity>, actorId: string) {
    const template = await this.findOne(tenantId, id);
    Object.assign(template, data);
    const saved = await this.templateRepo.save(template);

    await this.auditService.log({
      tenant_id: template.tenant_id,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'app_template.updated',
      payload: { template_id: id },
    });

    const { apps: propagatedApps, profiles: propagatedProfiles } = await this.propagateToLinkedApps(saved);
    if (propagatedApps > 0 || propagatedProfiles > 0) {
      this.logger.log(
        `Propagated template "${saved.name}" changes to ${propagatedApps} linked app(s), ${propagatedProfiles} profile(s)`,
      );
    }

    return this.withHash(saved);
  }

  private static readonly PROPAGATED_FIELDS = [
    'browser_policy', 'login_config', 'keepalive_config',
    'export_policy', 'notification_config', 'execute_enabled',
  ] as const;

  /** Bump minor version, reset patch. e.g. "1.0.0" → "1.1.0", "2.5.3" → "2.6.0" */
  private bumpMinorVersion(version: string): string {
    const parts = version.split('.');
    const major = parseInt(parts[0] ?? '1', 10);
    const minor = parseInt(parts[1] ?? '0', 10);
    return `${major}.${minor + 1}.0`;
  }

  static computeContentHash(template: AppTemplateEntity): string {
    const fields = {
      name: template.name,
      profile_name_pattern: template.profile_name_pattern,
      login_config: template.login_config,
      keepalive_config: template.keepalive_config,
      export_policy: template.export_policy,
      browser_policy: template.browser_policy,
      notification_config: template.notification_config,
      credential_ref_default: template.credential_ref_default,
      execute_enabled: template.execute_enabled,
      idle_shutdown_seconds: template.idle_shutdown_seconds,
    };
    return createHash('sha256')
      .update(AppTemplatesService.stableStringify(fields))
      .digest('hex');
  }

  private withHash<T extends AppTemplateEntity>(template: T): T & { content_hash: string } {
    return { ...template, content_hash: AppTemplatesService.computeContentHash(template) };
  }

  /** Deterministic JSON.stringify that sorts object keys recursively (JSONB key order is not stable across round-trips). */
  private static stableStringify(value: unknown): string {
    if (value === null || value === undefined) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(v => AppTemplatesService.stableStringify(v)).join(',')}]`;
    if (typeof value === 'object') {
      const sorted = Object.keys(value as Record<string, unknown>).sort()
        .map(k => `${JSON.stringify(k)}:${AppTemplatesService.stableStringify((value as Record<string, unknown>)[k])}`);
      return `{${sorted.join(',')}}`;
    }
    return JSON.stringify(value);
  }

  /** Returns true if the profile's template-derived fields differ from what the template would produce. */
  private profileNeedsUpdate(profile: ServiceProfileEntity, template: AppTemplateEntity): boolean {
    const exportPolicy = (template.export_policy as any) ?? {};
    const templateCredentialTypes = exportPolicy.credential_types ?? {};
    const templateTargetDomains = exportPolicy.target_domains ?? [];
    const s = AppTemplatesService.stableStringify;

    return (
      s(profile.login_config) !== s(template.login_config) ||
      s(profile.credential_types) !== s(templateCredentialTypes) ||
      s(profile.target_domains) !== s(templateTargetDomains)
    );
  }

  private async propagateToLinkedApps(template: AppTemplateEntity): Promise<{ apps: number; profiles: number }> {
    const CHUNK_SIZE = 50;
    let offset = 0;
    let totalApps = 0;
    let totalProfiles = 0;

    while (true) {
      const apps = await this.appRepo.find({
        where: { template_id: template.id },
        select: ['id'],
        take: CHUNK_SIZE,
        skip: offset,
      });
      if (apps.length === 0) break;

      const payload: Record<string, unknown> = {};
      for (const field of AppTemplatesService.PROPAGATED_FIELDS) {
        payload[field] = template[field];
      }

      for (const app of apps) {
        await this.appRepo.update(app.id, payload);
        totalApps++;

        const activeProfiles = await this.profileRepo.find({
          where: { app_id: app.id, version_state: ProfileVersionState.ACTIVE },
        });

        for (const profile of activeProfiles) {
          if (!this.profileNeedsUpdate(profile, template)) {
            continue;
          }

          const exportPolicy = (template.export_policy as any) ?? {};
          const newVersion = this.bumpMinorVersion(profile.version);

          await this.dataSource.transaction(async (manager) => {
            await manager.update(ServiceProfileEntity, { id: profile.id }, {
              version_state: ProfileVersionState.RETIRED,
            });

            await manager.save(ServiceProfileEntity, {
              tenant_id: profile.tenant_id,
              app_id: profile.app_id,
              profile_id: profile.profile_id,
              version: newVersion,
              version_state: ProfileVersionState.ACTIVE,
              parent_version_id: profile.id,
              login_config: template.login_config,
              credential_types: exportPolicy.credential_types ?? {},
              target_domains: exportPolicy.target_domains ?? [],
              owner_user_id: profile.owner_user_id,
              login_concurrency_limit: profile.login_concurrency_limit,
              extra_config: profile.extra_config,
              promoted_at: new Date(),
            });
          });

          this.logger.log(
            `Profile propagated: ${profile.profile_id} ${profile.version} → ${newVersion} (app ${app.id})`,
          );

          await this.auditService.log({
            tenant_id: profile.tenant_id,
            actor_type: 'system',
            actor_id: template.id,
            event_type: 'profile.propagated',
            payload: {
              entity_id: profile.id,
              app_id: app.id,
              profile_id: profile.profile_id,
              from_version: profile.version,
              to_version: newVersion,
              template_id: template.id,
            },
          });

          totalProfiles++;
        }
      }

      offset += apps.length;
      if (apps.length < CHUNK_SIZE) break;
    }
    return { apps: totalApps, profiles: totalProfiles };
  }

  async remove(tenantId: string | undefined, id: string, actorId: string) {
    const template = await this.findOne(tenantId, id);
    await this.templateRepo.remove(template);

    await this.auditService.log({
      tenant_id: template.tenant_id,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'app_template.deleted',
      payload: { template_id: id, name: template.name },
    });
  }
}
