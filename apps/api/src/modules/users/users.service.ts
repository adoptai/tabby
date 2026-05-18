import {
  Injectable, BadRequestException, ConflictException, NotFoundException, Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { UserEntity } from '../../entities';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { DEFAULTS, PASSWORD_RULES } from '@browser-hitl/shared';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  async create(
    email: string,
    password: string,
    role: string,
    tenantId: string,
    actorId: string,
  ): Promise<{ user_id: string }> {
    if (!PASSWORD_RULES.PATTERN.test(password)) {
      throw new BadRequestException(PASSWORD_RULES.DESCRIPTION);
    }

    const existing = await this.userRepo.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await this.authService.hashPassword(password);

    const user = this.userRepo.create({
      email,
      password_hash: passwordHash,
      role,
      tenant_id: tenantId,
    });
    const saved = await this.userRepo.save(user);

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'user.created',
      payload: { user_id: saved.id, email, role, tenant_id: tenantId },
    });

    return { user_id: saved.id };
  }

  async findAll(
    tenantId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: UserEntity[]; total: number; limit: number; offset: number }> {
    const [data, total] = await this.userRepo.findAndCount({
      where: { tenant_id: tenantId },
      select: ['id', 'email', 'role', 'status', 'tenant_id', 'created_at', 'updated_at'],
      take: limit,
      skip: offset,
      order: { created_at: 'DESC' },
    });

    return { data, total, limit, offset };
  }

  async remove(id: string, actorId: string): Promise<{ deleted: Record<string, number> }> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const deleted: Record<string, number> = {};
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const tables = [
        'session_batons',
        'interventions',
        'artifact_bundles',
        'sessions',
        'service_profiles',
        'applications',
      ];

      for (const table of tables) {
        let result;
        if (table === 'session_batons') {
          result = await qr.query(
            `DELETE FROM session_batons WHERE session_id IN (SELECT id FROM sessions WHERE owner_user_id = $1)`,
            [id],
          );
        } else if (table === 'interventions' || table === 'artifact_bundles') {
          result = await qr.query(
            `DELETE FROM ${table} WHERE session_id IN (SELECT id FROM sessions WHERE owner_user_id = $1)`,
            [id],
          );
        } else {
          result = await qr.query(`DELETE FROM ${table} WHERE owner_user_id = $1`, [id]);
        }
        const count = result[1] ?? result?.rowCount ?? 0;
        if (count > 0) {
          deleted[table] = count;
          this.logger.log(`Deleted ${count} rows from ${table} for user ${id}`);
        }
      }

      await qr.query(`DELETE FROM user_identities WHERE user_id = $1`, [id]);
      await qr.query(`DELETE FROM users WHERE id = $1`, [id]);
      deleted['users'] = 1;

      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      this.logger.error(`User deletion rolled back for ${id}: ${(err as Error).message}`);
      throw err;
    } finally {
      await qr.release();
    }

    await this.auditService.log({
      tenant_id: user.tenant_id,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'user.deleted',
      payload: { user_id: id, email: user.email, deleted },
    });

    return { deleted };
  }
}
