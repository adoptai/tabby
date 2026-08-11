import { Module } from '@nestjs/common';
import { ExecuteService } from './execute.service';
import { ExecuteController } from './execute.controller';
import { CredentialsModule } from '../credentials/credentials.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
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
