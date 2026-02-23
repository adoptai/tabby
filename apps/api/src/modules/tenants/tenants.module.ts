import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantEntity } from '../../entities';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { MinioProvisionerService } from './minio-provisioner.service';

@Module({
  imports: [TypeOrmModule.forFeature([TenantEntity])],
  controllers: [TenantsController],
  providers: [TenantsService, MinioProvisionerService],
  exports: [TenantsService, MinioProvisionerService],
})
export class TenantsModule {}
