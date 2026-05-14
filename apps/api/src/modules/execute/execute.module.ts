import { Module } from '@nestjs/common';
import { ExecuteService } from './execute.service';
import { ExecuteController } from './execute.controller';
import { CredentialsModule } from '../credentials/credentials.module';

@Module({
  imports: [
    CredentialsModule,
  ],
  providers: [ExecuteService],
  controllers: [ExecuteController],
  exports: [ExecuteService],
})
export class ExecuteModule {}
