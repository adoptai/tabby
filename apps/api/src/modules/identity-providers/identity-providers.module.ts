import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityProviderEntity } from '../../entities';
import { IdentityProvidersController } from './identity-providers.controller';
import { IdentityProvidersService } from './identity-providers.service';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([IdentityProviderEntity]),
    AuditModule,
    AuthModule,
  ],
  controllers: [IdentityProvidersController],
  providers: [IdentityProvidersService],
  exports: [IdentityProvidersService],
})
export class IdentityProvidersModule {}
