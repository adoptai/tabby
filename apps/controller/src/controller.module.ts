import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { requireEnv } from '@browser-hitl/shared';
import { ReconcileService } from './reconcile.service';
import { StateMachineService } from './state-machine.service';
import { PodManagerService } from './pod-manager.service';
import { NatsPublisherService } from './nats-publisher.service';
import { HealthController } from './health.controller';

// Import entities from the API package (shared schema)
import { SessionEntity } from './entities/session.entity';
import { SessionBatonEntity } from './entities/session-baton.entity';
import { ApplicationEntity } from './entities/application.entity';
import { TenantEntity } from './entities/tenant.entity';
import { InterventionEntity } from './entities/intervention.entity';
import { AuditEventEntity } from './entities/audit-event.entity';
import { CircuitBreakerStateEntity } from './entities/circuit-breaker-state.entity';

const dbUrl = requireEnv('DATABASE_URL', {
  testDefault: 'postgresql://postgres:postgres@localhost:5432/browser_hitl',
});

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: dbUrl,
      entities: [SessionEntity, SessionBatonEntity, ApplicationEntity, TenantEntity, InterventionEntity, AuditEventEntity, CircuitBreakerStateEntity],
      synchronize: false,
      logging: ['error'],
      extra: { max: Number(process.env.DB_POOL_SIZE) || 20 },
    }),
    TypeOrmModule.forFeature([SessionEntity, SessionBatonEntity, ApplicationEntity, TenantEntity, InterventionEntity, AuditEventEntity, CircuitBreakerStateEntity]),
    ScheduleModule.forRoot(),
  ],
  controllers: [HealthController],
  providers: [
    ReconcileService,
    StateMachineService,
    PodManagerService,
    NatsPublisherService,
  ],
})
export class ControllerModule {}
