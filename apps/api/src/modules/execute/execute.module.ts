import { Module } from '@nestjs/common';
import { ExecuteService } from './execute.service';
import { ExecuteController } from './execute.controller';
import { CredentialsModule } from '../credentials/credentials.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    CredentialsModule,
    AuthModule,
  ],
  providers: [ExecuteService],
  controllers: [ExecuteController],
  exports: [ExecuteService],
})
export class ExecuteModule {}
