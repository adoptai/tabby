import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppTemplateEntity } from '../../entities';
import { AppTemplatesController } from './app-templates.controller';
import { AppTemplatesService } from './app-templates.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AppTemplateEntity]),
    AuditModule,
  ],
  controllers: [AppTemplatesController],
  providers: [AppTemplatesService],
  exports: [AppTemplatesService],
})
export class AppTemplatesModule {}
