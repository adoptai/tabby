import {
  Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ApplicationEntity, TenantEntity } from '../../entities';
import { AuditService } from '../audit/audit.service';
import {
  validateLoginConfig,
  validateKeepaliveConfig,
  validateExportPolicy,
  validateNotificationConfig,
  validateTargetUrls,
  LoginConfig,
  KeepaliveConfig,
  ExportPolicy,
  NotificationConfig,
} from '@browser-hitl/shared';
import { APP_SELECTABLE_FIELDS, AppSelectableField } from './apps.dto';

interface CreateAppInput {
  name: string;
  target_urls: string[];
  login_config: Record<string, unknown>;
  keepalive_config: Record<string, unknown>;
  export_policy: Record<string, unknown>;
  notification_config?: Record<string, unknown>;
  desired_session_count?: number;
  browser_policy?: Record<string, unknown>;
}

@Injectable()
export class AppsService {
  private readonly logger = new Logger(AppsService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(TenantEntity)
    private readonly tenantRepo: Repository<TenantEntity>,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  private validateConfigs(input: CreateAppInput): void {
    const errors: { field: string; issues: { path: string; message: string }[] }[] = [];

    const targetResult = validateTargetUrls(input.target_urls);
    if (!targetResult.valid) {
      errors.push({ field: 'target_urls', issues: targetResult.errors });
    }

    const loginResult = validateLoginConfig(input.login_config as unknown as LoginConfig);
    if (!loginResult.valid) {
      errors.push({ field: 'login_config', issues: loginResult.errors });
    }

    const keepaliveResult = validateKeepaliveConfig(input.keepalive_config as unknown as KeepaliveConfig);
    if (!keepaliveResult.valid) {
      errors.push({ field: 'keepalive_config', issues: keepaliveResult.errors });
    }

    const exportResult = validateExportPolicy(input.export_policy as unknown as ExportPolicy);
    if (!exportResult.valid) {
      errors.push({ field: 'export_policy', issues: exportResult.errors });
    }

    const notifResult = validateNotificationConfig(input.notification_config as unknown as NotificationConfig);
    if (!notifResult.valid) {
      errors.push({ field: 'notification_config', issues: notifResult.errors });
    }

    if (errors.length > 0) {
      throw new BadRequestException({ message: 'Validation failed', errors });
    }
  }

  async create(
    input: CreateAppInput,
    tenantId: string,
    actorId: string,
  ): Promise<{ app_id: string }> {
    this.validateConfigs(input);

    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const app = this.appRepo.create({
      tenant_id: tenantId,
      name: input.name,
      target_urls: input.target_urls,
      login_config: input.login_config,
      keepalive_config: input.keepalive_config,
      export_policy: input.export_policy,
      notification_config: input.notification_config ?? { channels: [] },
      desired_session_count: input.desired_session_count ?? 1,
      browser_policy: input.browser_policy ?? { downloads: false, clipboard: false, file_chooser: false },
    });
    const saved = await this.appRepo.save(app);

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'app.created',
      payload: { app_id: saved.id, name: input.name },
    });

    return { app_id: saved.id };
  }

  async findAll(
    tenantId: string,
    limit: number,
    offset: number,
    fields?: string,
  ): Promise<{ data: Partial<ApplicationEntity>[]; total: number; limit: number; offset: number }> {
    let select: AppSelectableField[] | undefined;

    if (fields) {
      const requested = fields.split(',').map(f => f.trim()).filter(Boolean) as AppSelectableField[];
      const invalid = requested.filter(f => !(APP_SELECTABLE_FIELDS as readonly string[]).includes(f));
      if (invalid.length > 0) {
        throw new BadRequestException(
          `Unknown field(s): ${invalid.join(', ')}. Allowed: ${APP_SELECTABLE_FIELDS.join(', ')}`,
        );
      }
      select = requested;
    }

    const [data, total] = await this.appRepo.findAndCount({
      where: { tenant_id: tenantId },
      select: select as any,
      take: limit,
      skip: offset,
      order: { created_at: 'DESC' },
    });

    return { data, total, limit, offset };
  }

  async findOne(id: string, tenantId?: string): Promise<ApplicationEntity> {
    const where: any = { id };
    if (tenantId) where.tenant_id = tenantId;
    const app = await this.appRepo.findOne({ where });
    if (!app) {
      throw new NotFoundException('Application not found');
    }
    return app;
  }

  async update(
    id: string,
    input: Partial<CreateAppInput>,
    tenantId: string | undefined,
    actorId: string,
  ): Promise<ApplicationEntity> {
    const app = await this.findOne(id, tenantId);

    // If any config fields are provided, validate them
    const toValidate: CreateAppInput = {
      name: input.name ?? app.name,
      target_urls: input.target_urls ?? app.target_urls,
      login_config: input.login_config ?? app.login_config,
      keepalive_config: input.keepalive_config ?? app.keepalive_config,
      export_policy: input.export_policy ?? app.export_policy,
      notification_config: input.notification_config ?? app.notification_config,
    };
    this.validateConfigs(toValidate);

    Object.assign(app, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.target_urls !== undefined && { target_urls: input.target_urls }),
      ...(input.login_config !== undefined && { login_config: input.login_config }),
      ...(input.keepalive_config !== undefined && { keepalive_config: input.keepalive_config }),
      ...(input.export_policy !== undefined && { export_policy: input.export_policy }),
      ...(input.notification_config !== undefined && { notification_config: input.notification_config }),
      ...(input.desired_session_count !== undefined && { desired_session_count: input.desired_session_count }),
      ...(input.browser_policy !== undefined && { browser_policy: input.browser_policy }),
    });

    const saved = await this.appRepo.save(app);

    await this.auditService.log({
      tenant_id: saved.tenant_id,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'app.updated',
      payload: { app_id: id, changes: Object.keys(input) },
    });

    return saved;
  }

  async deactivate(
    id: string,
    tenantId: string | undefined,
    actorId: string,
  ): Promise<{ app_id: string; desired_session_count: number }> {
    const app = await this.findOne(id, tenantId);

    app.desired_session_count = 0;
    await this.appRepo.save(app);

    await this.auditService.log({
      tenant_id: app.tenant_id,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'app.deactivated',
      payload: { app_id: id },
    });

    return { app_id: id, desired_session_count: 0 };
  }

  async destroy(id: string, actorId: string): Promise<{ deleted: Record<string, number> }> {
    const app = await this.findOne(id);
    const deleted: Record<string, number> = {};

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const tables = [
        'login_queue',
        'auth_requests',
        'artifact_bundles',
        'interventions',
        'sessions',
        'service_profiles',
      ];

      for (const table of tables) {
        let result;
        if (table === 'login_queue') {
          result = await qr.query(
            `DELETE FROM login_queue WHERE auth_request_id IN (SELECT id FROM auth_requests WHERE app_id = $1)`,
            [id],
          );
        } else {
          result = await qr.query(`DELETE FROM ${table} WHERE app_id = $1`, [id]);
        }
        const count = result[1] ?? result?.rowCount ?? 0;
        if (count > 0) {
          deleted[table] = count;
          this.logger.log(`Deleted ${count} rows from ${table} for app ${id}`);
        }
      }

      await qr.query(`DELETE FROM applications WHERE id = $1`, [id]);
      deleted['applications'] = 1;

      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      this.logger.error(`App destruction rolled back for ${id}: ${(err as Error).message}`);
      throw err;
    } finally {
      await qr.release();
    }

    await this.auditService.log({
      tenant_id: app.tenant_id,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'app.destroyed',
      payload: { app_id: id, name: app.name, deleted },
    });

    return { deleted };
  }
}
