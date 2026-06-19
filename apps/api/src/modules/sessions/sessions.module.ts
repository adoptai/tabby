import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  SessionEntity, ApplicationEntity, TenantEntity, InterventionEntity, SessionBatonEntity,
} from '../../entities';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SessionEntity,
      ApplicationEntity,
      TenantEntity,
      InterventionEntity,
      SessionBatonEntity,
    ]),
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
