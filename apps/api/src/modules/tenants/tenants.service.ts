import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { TenantEntity } from '../../entities';
import { AuditService } from '../audit/audit.service';
import { MinioProvisionerService } from './minio-provisioner.service';

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    @InjectRepository(TenantEntity)
    private readonly tenantRepo: Repository<TenantEntity>,
    private readonly auditService: AuditService,
    private readonly minioProvisioner: MinioProvisionerService,
  ) {}

  async create(name: string, actorId: string, id?: string): Promise<{ tenant_id: string }> {
    const existing = await this.tenantRepo.findOne({ where: { name } });
    if (existing) {
      throw new ConflictException('Tenant name already exists');
    }

    if (id) {
      const existingId = await this.tenantRepo.findOne({ where: { id } });
      if (existingId) {
        throw new ConflictException('Tenant ID already exists');
      }
    }

    const tenant = this.tenantRepo.create({ id: id || crypto.randomUUID(), name });
    const saved = await this.tenantRepo.save(tenant);

    // Provision a MinIO bucket for the new tenant's artifact storage
    try {
      await this.minioProvisioner.provisionBucket(saved.id);
    } catch (err) {
      this.logger.error(
        `Failed to provision MinIO bucket for tenant ${saved.id}: ${(err as Error).message}`,
      );
      // Non-fatal: tenant is created, bucket can be provisioned later
    }

    await this.auditService.log({
      tenant_id: saved.id,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'tenant.created',
      payload: { tenant_id: saved.id, name },
    });

    return { tenant_id: saved.id };
  }

  async findAll(
    limit: number,
    offset: number,
  ): Promise<{ data: TenantEntity[]; total: number; limit: number; offset: number }> {
    const [data, total] = await this.tenantRepo.findAndCount({
      take: limit,
      skip: offset,
      order: { created_at: 'DESC' },
    });

    return { data, total, limit, offset };
  }
}
