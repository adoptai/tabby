import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { dataSourceOptions } from './data-source';
import { AuthModule } from './modules/auth/auth.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { AppsModule } from './modules/apps/apps.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { ArtifactsModule } from './modules/artifacts/artifacts.module';
import { HitlModule } from './modules/hitl/hitl.module';
import { AuditModule } from './modules/audit/audit.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { NatsAclModule } from './modules/nats/nats-acl.module';
import { BootstrapModule } from './modules/auth/bootstrap.module';
import { APP_GUARD } from '@nestjs/core';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import { EventsModule } from './modules/events/events.module';
import { AgentModule } from './modules/agent/agent.module';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module';
import { HealthModule } from './modules/health/health.module';
import { RedisModule } from './modules/redis/redis.module';
import { LoginSerializationModule } from './modules/login/login-serialization.module';
import { LoginCoordinatorModule } from './modules/login/login-coordinator.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { CredentialsModule } from './modules/credentials/credentials.module';
import { IdentityProvidersModule } from './modules/identity-providers/identity-providers.module';
import { AppTemplatesModule } from './modules/app-templates/app-templates.module';

@Module({
  imports: [
    TypeOrmModule.forRoot(dataSourceOptions),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60000, limit: 60 },
    ]),
    ScheduleModule.forRoot(),
    RedisModule,
    AuthModule,
    BootstrapModule,
    TenantsModule,
    UsersModule,
    AppsModule,
    SessionsModule,
    ArtifactsModule,
    HitlModule,
    AuditModule,
    StreamingModule,
    ObservabilityModule,
    NatsAclModule,
    EventsModule,
    AgentModule,
    LifecycleModule,
    LoginSerializationModule,
    LoginCoordinatorModule,
    ProfilesModule,
    CredentialsModule,
    IdentityProvidersModule,
    AppTemplatesModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: UserThrottlerGuard,
    },
  ],
})
export class AppModule {}
