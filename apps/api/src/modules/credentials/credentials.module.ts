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
import { AppsModule } from '../apps/apps.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { SessionsModule } from '../sessions/sessions.module';

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
    AppsModule,
    ProfilesModule,
    SessionsModule,
  ],
  providers: [CredentialsService],
  controllers: [CredentialsController],
  exports: [CredentialsService],
})
export class CredentialsModule {}
