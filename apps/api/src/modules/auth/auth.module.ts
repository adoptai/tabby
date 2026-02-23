import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity, AgentClientEntity } from '../../entities';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { TokenBlacklistService } from './token-blacklist.service';
import { AuditModule } from '../audit/audit.module';
import { resolveJwtSigningKey } from './jwt-config';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, AgentClientEntity]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: resolveJwtSigningKey(),
      signOptions: { expiresIn: '24h' },
    }),
    AuditModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, TokenBlacklistService],
  exports: [AuthService, JwtModule, TokenBlacklistService],
})
export class AuthModule {}
