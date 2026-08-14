import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionEntity } from '../../entities/session.entity';
import { ExecuteService } from './execute.service';
import { ExecuteController } from './execute.controller';
import { CredentialsModule } from '../credentials/credentials.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    // Read-only, and only on the failure path: when a command cannot reach its
    // worker, the session row carries why the worker died.
    TypeOrmModule.forFeature([SessionEntity]),
    CredentialsModule,
    AuthModule,
    // execute/browser can act inside a signed-in session; its caller is audited.
    AuditModule,
  ],
  providers: [ExecuteService],
  controllers: [ExecuteController],
  exports: [ExecuteService],
})
export class ExecuteModule {}
