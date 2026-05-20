import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactBundleEntity, ArtifactConsumptionEntity, TenantEntity } from '../../entities';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactsService } from './artifacts.service';
import { ArtifactTokenService } from './artifact-token.service';
import { ArtifactExpirationService } from './artifact-expiration.service';
import { MinioOrphanSweepService } from './minio-orphan-sweep.service';
import { TenantsModule } from '../tenants/tenants.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ArtifactBundleEntity, ArtifactConsumptionEntity, TenantEntity]),
    TenantsModule,
  ],
  controllers: [ArtifactsController],
  providers: [ArtifactsService, ArtifactTokenService, ArtifactExpirationService, MinioOrphanSweepService],
  exports: [ArtifactsService, ArtifactTokenService],
})
export class ArtifactsModule {}
