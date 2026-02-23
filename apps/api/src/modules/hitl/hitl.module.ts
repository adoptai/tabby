import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionEntity, SessionBatonEntity, InterventionEntity } from '../../entities';
import { HitlController } from './hitl.controller';
import { HitlService } from './hitl.service';
import { StreamingModule } from '../streaming/streaming.module';

@Module({
  imports: [TypeOrmModule.forFeature([SessionEntity, SessionBatonEntity, InterventionEntity]), StreamingModule],
  controllers: [HitlController],
  providers: [HitlService],
  exports: [HitlService],
})
export class HitlModule {}
