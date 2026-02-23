import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionEntity } from '../../entities';
import { HealthController } from './health.controller';

@Module({
  imports: [TypeOrmModule.forFeature([SessionEntity])],
  controllers: [HealthController],
})
export class HealthModule {}
