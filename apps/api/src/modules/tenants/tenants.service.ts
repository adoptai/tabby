import { Injectable, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as crypto from 'crypto';
import * as Sentry from '@sentry/node';
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
    private readonly dataSource: DataSource,
  ) {}

  async create(name: string, actorId: string, id?: string, maxSessions?: number): Promise<{ tenant_id: string }> {
    const existing = await this.tenantRepo.findOne({ where: { name } });
    if (existing) {
      throw new ConflictException('Tenant name already exists');
    }

    const tenantId = id || crypto.randomUUID();
    if (id) {
      const existingId = await this.tenantRepo.findOne({ where: { id } });
      if (existingId) {
        throw new ConflictException('Tenant ID already exists');
      }
    }

    const tenantData: Partial<TenantEntity> = { id: tenantId, name };
    if (maxSessions !== undefined) {
      tenantData.max_sessions = maxSessions;
    }
    const tenant = this.tenantRepo.create(tenantData);
    const saved = await this.tenantRepo.save(tenant);

    // Provision a MinIO bucket for the new tenant's artifact storage
    try {
      await this.minioProvisioner.provisionBucket(saved.id);
    } catch (err) {
      this.logger.error(
        `Failed to provision MinIO bucket for tenant ${saved.id}: ${(err as Error).message}`,
      );
      Sentry.withScope((scope) => {
        scope.setTag('tenant_id', saved.id);
        scope.setTag('warn_context', 'minio_provision_failed');
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
      });
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

  async findOne(id: string): Promise<TenantEntity> {
    const tenant = await this.tenantRepo.findOne({ where: { id } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  async update(
    id: string,
    dto: { max_sessions?: number },
    actorId: string,
  ): Promise<TenantEntity> {
    const tenant = await this.findOne(id);

    if (dto.max_sessions !== undefined) {
      tenant.max_sessions = dto.max_sessions;
    }

    const saved = await this.tenantRepo.save(tenant);

    await this.auditService.log({
      tenant_id: id,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'tenant.updated',
      payload: { tenant_id: id, ...dto },
    });

    return saved;
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

  async remove(id: string, actorId: string): Promise<{ deleted: Record<string, number> }> {
    const tenant = await this.findOne(id);
    const deleted: Record<string, number> = {};

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // Delete in FK-dependency order (leaves before roots).
      const tables = [
        'login_queue',       // → auth_requests
        'auth_requests',     // → sessions, applications, tenants
        'artifact_bundles',  // → sessions, applications, tenants
        'interventions',     // → sessions, applications, tenants
        'session_batons',    // → sessions (no tenant_id, FK to sessions.id)
        'sessions',          // → applications, tenants
        'service_profiles',  // → applications, tenants
        'user_identities',   // → users, tenants
        'agent_clients',     // → tenants
        'users',             // → tenants
        'audit_events',      // → tenants
        'app_templates',     // → tenants
        'applications',      // → tenants
      ];

      for (const table of tables) {
        let result;
        if (table === 'login_queue') {
          result = await qr.query(
            `DELETE FROM login_queue WHERE auth_request_id IN (SELECT id FROM auth_requests WHERE tenant_id = $1)`,
            [id],
          );
        } else if (table === 'session_batons') {
          result = await qr.query(
            `DELETE FROM session_batons WHERE session_id IN (SELECT id FROM sessions WHERE tenant_id = $1)`,
            [id],
          );
        } else {
          result = await qr.query(
            `DELETE FROM ${table} WHERE tenant_id = $1`,
            [id],
          );
        }
        const count = result[1] ?? result?.rowCount ?? 0;
        if (count > 0) {
          deleted[table] = count;
          this.logger.log(`Deleted ${count} rows from ${table} for tenant ${id}`);
        }
      }

      await qr.query(`DELETE FROM tenants WHERE id = $1`, [id]);
      deleted['tenants'] = 1;

      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      this.logger.error(`Tenant deletion rolled back for ${id}: ${(err as Error).message}`);
      throw err;
    } finally {
      await qr.release();
    }

    return { deleted };
  }
}
