import { Injectable, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppTemplateEntity, ApplicationEntity } from '../../entities';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class AppTemplatesService {
  private readonly logger = new Logger(AppTemplatesService.name);

  constructor(
    @InjectRepository(AppTemplateEntity)
    private readonly templateRepo: Repository<AppTemplateEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
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

    return saved;
  }

  async findAll(tenantId?: string) {
    const where = tenantId ? { tenant_id: tenantId } : {};
    return this.templateRepo.find({
      where,
      order: { created_at: 'DESC' },
    });
  }

  async findOne(tenantId: string | undefined, id: string) {
    const where: Record<string, string> = { id };
    if (tenantId) where.tenant_id = tenantId;
    const template = await this.templateRepo.findOne({ where });
    if (!template) throw new NotFoundException('App template not found');
    return template;
  }

  async findByPattern(tenantId: string, profileNamePattern: string) {
    return this.templateRepo.findOne({
      where: { tenant_id: tenantId, profile_name_pattern: profileNamePattern },
    });
  }

  async update(tenantId: string, id: string, data: Partial<AppTemplateEntity>, actorId: string) {
    const template = await this.findOne(tenantId, id);
    Object.assign(template, data);
    const saved = await this.templateRepo.save(template);

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'app_template.updated',
      payload: { template_id: id },
    });

    const propagated = await this.propagateToLinkedApps(saved);
    if (propagated > 0) {
      this.logger.log(`Propagated template "${saved.name}" changes to ${propagated} linked app(s)`);
    }

    return saved;
  }

  private static readonly PROPAGATED_FIELDS = [
    'browser_policy', 'login_config', 'keepalive_config',
    'export_policy', 'notification_config', 'execute_enabled',
  ] as const;

  private async propagateToLinkedApps(template: AppTemplateEntity): Promise<number> {
    const CHUNK_SIZE = 50;
    let offset = 0;
    let total = 0;

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
        total++;
      }

      offset += apps.length;
      if (apps.length < CHUNK_SIZE) break;
    }
    return total;
  }

  async remove(tenantId: string, id: string, actorId: string) {
    const template = await this.findOne(tenantId, id);
    await this.templateRepo.remove(template);

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'app_template.deleted',
      payload: { template_id: id, name: template.name },
    });
  }
}
