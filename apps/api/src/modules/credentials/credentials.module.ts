import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  SessionEntity,
  ServiceProfileEntity,
  ArtifactBundleEntity,
  ArtifactConsumptionEntity,
  ApplicationEntity,
  AppTemplateEntity,
} from '../../entities';
import { CredentialsService } from './credentials.service';
import { CredentialsController } from './credentials.controller';
import { TenantsModule } from '../tenants/tenants.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SessionEntity,
      ServiceProfileEntity,
      ArtifactBundleEntity,
      ArtifactConsumptionEntity,
      ApplicationEntity,
      AppTemplateEntity,
    ]),
    TenantsModule,
  ],
  providers: [CredentialsService],
  controllers: [CredentialsController],
  exports: [CredentialsService],
})
export class CredentialsModule {}
