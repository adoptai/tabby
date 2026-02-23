import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { EventsGateway } from './events.gateway';

@Module({
  imports: [AuthModule, AuditModule],
  providers: [EventsGateway],
})
export class EventsModule {}
