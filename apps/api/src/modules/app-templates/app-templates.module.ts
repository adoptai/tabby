import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppTemplateEntity, ApplicationEntity, ServiceProfileEntity } from '../../entities';
import { AppTemplatesController } from './app-templates.controller';
import { AppTemplatesService } from './app-templates.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AppTemplateEntity, ApplicationEntity, ServiceProfileEntity]),
    AuditModule,
  ],
  controllers: [AppTemplatesController],
  providers: [AppTemplatesService],
  exports: [AppTemplatesService],
})
export class AppTemplatesModule {}
