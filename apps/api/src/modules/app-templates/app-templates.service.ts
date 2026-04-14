import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppTemplateEntity } from '../../entities';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class AppTemplatesService {
  constructor(
    @InjectRepository(AppTemplateEntity)
    private readonly templateRepo: Repository<AppTemplateEntity>,
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

  async findAll(tenantId: string) {
    return this.templateRepo.find({
      where: { tenant_id: tenantId },
      order: { created_at: 'DESC' },
    });
  }

  async findOne(tenantId: string, id: string) {
    const template = await this.templateRepo.findOne({
      where: { id, tenant_id: tenantId },
    });
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

    return saved;
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
