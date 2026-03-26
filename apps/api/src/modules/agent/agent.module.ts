import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionEntity } from '../../entities';
import { AppsModule } from '../apps/apps.module';
import { SessionsModule } from '../sessions/sessions.module';
import { HitlModule } from '../hitl/hitl.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([SessionEntity]),
    AppsModule,
    SessionsModule,
    HitlModule,
    CredentialsModule,
  ],
  controllers: [AgentController],
  providers: [AgentService],
})
export class AgentModule {}
