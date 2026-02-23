import {
  Injectable, BadRequestException, ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../../entities';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { DEFAULTS, PASSWORD_RULES } from '@browser-hitl/shared';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
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
}
