import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthRequestEntity, SessionEntity } from '../../entities';
import { LoginSerializationService } from './login-serialization.service';

@Module({
  imports: [TypeOrmModule.forFeature([AuthRequestEntity, SessionEntity])],
  providers: [LoginSerializationService],
  exports: [LoginSerializationService],
})
export class LoginSerializationModule {}
