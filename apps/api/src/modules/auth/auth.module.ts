import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity, AgentClientEntity, IdentityProviderEntity, UserIdentityEntity, TenantEntity } from '../../entities';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { TokenBlacklistService } from './token-blacklist.service';
import { ExternalJwksService } from './external-jwks.service';
import { TokenExchangeService } from './token-exchange.service';
import { AuditModule } from '../audit/audit.module';
import { resolveJwtSigningKey } from './jwt-config';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, AgentClientEntity, IdentityProviderEntity, UserIdentityEntity, TenantEntity]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: resolveJwtSigningKey(),
      signOptions: { expiresIn: '24h' },
    }),
    AuditModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, TokenBlacklistService, ExternalJwksService, TokenExchangeService],
  exports: [AuthService, JwtModule, TokenBlacklistService, ExternalJwksService, TokenExchangeService],
})
export class AuthModule {}
