import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApplicationEntity, TenantEntity } from '../../entities';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';

@Module({
  imports: [TypeOrmModule.forFeature([ApplicationEntity, TenantEntity])],
  controllers: [AppsController],
  providers: [AppsService],
  exports: [AppsService],
})
export class AppsModule {}
