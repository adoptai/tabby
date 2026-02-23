import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantEntity, UserEntity } from '../../entities';
import { AuthService } from './auth.service';

/**
 * Bootstrap flow per spec section 11.3:
 * On first startup with empty database, creates:
 * 1. A tenant with name BOOTSTRAP_TENANT_NAME
 * 2. An admin user with ADMIN_BOOTSTRAP_EMAIL/PASSWORD
 * 3. (MinIO bucket + encryption key provisioned separately)
 * Idempotent: skips if any tenant exists.
 */
@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    @InjectRepository(TenantEntity)
    private readonly tenantRepo: Repository<TenantEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly authService: AuthService,
  ) {}

  async onModuleInit() {
    const tenantCount = await this.tenantRepo.count();
    if (tenantCount > 0) {
      this.logger.log('Tenants exist, skipping bootstrap');
      return;
    }

    const tenantName = process.env.BOOTSTRAP_TENANT_NAME || 'default';
    const adminEmail = process.env.ADMIN_BOOTSTRAP_EMAIL || 'admin@localhost';
    const adminPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;

    if (!adminPassword) {
      this.logger.warn('ADMIN_BOOTSTRAP_PASSWORD not set, skipping bootstrap');
      return;
    }

    this.logger.log(`Bootstrapping tenant: ${tenantName}, admin: ${adminEmail}`);

    const tenant = this.tenantRepo.create({ name: tenantName });
    const savedTenant = await this.tenantRepo.save(tenant);

    const passwordHash = await this.authService.hashPassword(adminPassword);
    const user = this.userRepo.create({
      tenant_id: savedTenant.id,
      email: adminEmail,
      password_hash: passwordHash,
      role: 'Admin',
      status: 'ACTIVE',
    });
    await this.userRepo.save(user);

    this.logger.log(`Bootstrap complete: tenant=${savedTenant.id}, admin=${user.id}`);
  }
}
