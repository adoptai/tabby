import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthRequestEntity, LoginQueueEntity } from '../../entities';
import { LoginCoordinatorService } from './login-coordinator.service';

@Module({
  imports: [TypeOrmModule.forFeature([LoginQueueEntity, AuthRequestEntity])],
  providers: [LoginCoordinatorService],
  exports: [LoginCoordinatorService],
})
export class LoginCoordinatorModule {}
