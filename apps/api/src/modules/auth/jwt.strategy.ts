import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as jwt from 'jsonwebtoken';
import { JwtPayload } from './auth.service';
import { resolveJwtSigningKey } from './jwt-config';
import { TokenBlacklistService } from './token-blacklist.service';
import { ExternalJwksService } from './external-jwks.service';
import { IdentityProviderEntity } from '../../entities/identity-provider.entity';
import { TenantEntity } from '../../entities/tenant.entity';
import { OAuthProviderService } from './oauth-provider.service';
import { resolveRoleFromIdp } from '../../common/helpers/role-resolver.helper';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly tokenBlacklist: TokenBlacklistService,
    private readonly jwksService: ExternalJwksService,
    private readonly oauthProvider: OAuthProviderService,
    @InjectRepository(IdentityProviderEntity)
    private readonly idpRepo: Repository<IdentityProviderEntity>,
    @InjectRepository(TenantEntity)
    private readonly tenantRepo: Repository<TenantEntity>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      passReqToCallback: true,
      secretOrKeyProvider: async (request: any, rawJwtToken: string, done: Function) => {
        try {
          // Decode header + payload (unverified) to read iss
          const parts = rawJwtToken.split('.');
          if (parts.length !== 3) {
            return done(null, resolveJwtSigningKey());
          }

          let header: { kid?: string };
          let unverified: { iss?: string };
          try {
            header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
            unverified = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          } catch {
            return done(null, resolveJwtSigningKey());
          }

          const iss = unverified?.iss;
          if (iss) {
            // Check if this is a JWT from a registered external IdP
            const idp = await this.idpRepo.findOne({ where: { issuer_url: iss, enabled: true } });
            if (idp) {
              // Tag the request so validate() knows this is an external JWT
              request._tabbyExternalIdp = idp;
              try {
                const kid = header?.kid;
                const publicKey = kid
                  ? await this.jwksService.getPublicKey(iss, kid)
                  : await this.getFirstPublicKey(iss);
                return done(null, publicKey);
              } catch (err) {
                return done(new UnauthorizedException('JWKS fetch failed for issuer: ' + iss));
              }
            }
          }

          // Fall back to Tabby-issued JWT (signed with JWT_SIGNING_KEY)
          return done(null, resolveJwtSigningKey());
        } catch (err) {
          return done(null, resolveJwtSigningKey());
        }
      },
      // Support both HS256 (Tabby-issued) and RS/ES (external IdP)
      algorithms: ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
    } as any);
  }

  async validate(req: any, payload: any): Promise<Record<string, unknown>> {
    const idp: IdentityProviderEntity | undefined = req?._tabbyExternalIdp;

    if (idp) {
      // ── External IdP JWT ───────────────────────────────────────────────
      const ownerUserId = String(payload[idp.user_id_claim] || payload.sub || '');
      if (!ownerUserId) throw new UnauthorizedException('JWT missing user identifier claim');

      const email = String(payload[idp.email_claim] || payload.email || '');
      const role = resolveRoleFromIdp(idp, payload as Record<string, unknown>, email);

      // Resolve tenant from claim
      let resolvedTenantId: string;
      if (idp.tenant_id_claim) {
        const claimValue = String(payload[idp.tenant_id_claim] || '');
        if (!claimValue) throw new UnauthorizedException(`JWT missing tenant claim: ${idp.tenant_id_claim}`);
        const tenant = await this.tenantRepo.findOne({ where: { id: claimValue } });
        if (!tenant) {
          if (idp.allow_auto_provision) {
            // Auto-provision tenant using claim value as ID
            const created = this.tenantRepo.create({ id: claimValue, name: claimValue });
            const saved = await this.tenantRepo.save(created);
            resolvedTenantId = saved.id;
          } else {
            throw new UnauthorizedException(`Tenant not found: ${claimValue}`);
          }
        } else {
          resolvedTenantId = tenant.id;
        }
      } else {
        resolvedTenantId = '';
      }

      return {
        user_id: `federated:${ownerUserId}`,
        tenant_id: resolvedTenantId,
        role,
        token_type: 'federated',
        owner_user_id: ownerUserId,
        idp_id: idp.id,
        allowed_profiles: [],
        jti: null,
      };
    }

    // ── Tabby-issued JWT ────────────────────────────────────────────────
    if (payload.jti) {
      const revoked = await this.tokenBlacklist.isRevoked(payload.jti);
      if (revoked) throw new UnauthorizedException('Token has been revoked');
    }

    return {
      user_id: payload.sub,
      tenant_id: payload.tenant_id,
      role: payload.role,
      jti: payload.jti,
      exp: payload.exp,
      token_type: payload.token_type,
      allowed_profiles: payload.allowed_profiles ?? [],
      owner_user_id: payload.owner_user_id ?? null,
      idp_id: payload.idp_id ?? null,
    };
  }

  private async getFirstPublicKey(issuerUrl: string): Promise<string> {
    const keys = await this.jwksService['getJwks'](issuerUrl);
    if (!keys.length) throw new Error(`No keys in JWKS for ${issuerUrl}`);
    return this.jwksService['jwkToPem'](keys[0]);
  }
}
