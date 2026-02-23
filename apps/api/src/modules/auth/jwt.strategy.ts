import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from './auth.service';
import { resolveJwtSigningKey } from './jwt-config';
import { TokenBlacklistService } from './token-blacklist.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly tokenBlacklist: TokenBlacklistService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: resolveJwtSigningKey(),
    });
  }

  async validate(payload: JwtPayload) {
    // Check token revocation (C1 remediation)
    if (payload.jti) {
      const revoked = await this.tokenBlacklist.isRevoked(payload.jti);
      if (revoked) {
        throw new UnauthorizedException('Token has been revoked');
      }
    }

    return {
      user_id: payload.sub,
      tenant_id: payload.tenant_id,
      role: payload.role,
      jti: payload.jti,
      exp: payload.exp,
    };
  }
}
