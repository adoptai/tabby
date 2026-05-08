import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { IdentityProviderEntity } from '../../entities/identity-provider.entity';
import { TenantEntity } from '../../entities/tenant.entity';
import { UserIdentityEntity } from '../../entities/user-identity.entity';
import { UserEntity } from '../../entities/user.entity';
import { ExternalJwksService } from './external-jwks.service';
import { JwtPayload } from './auth.service';
import { AuditService } from '../audit/audit.service';

interface TokenExchangeParams {
  subject_token: string;
  subject_token_type: 'oidc_jwt' | 'agent_assertion';
  idp_id?: string;
  target_user_id?: string;
  requested_ttl_seconds?: number;
  // For agent_assertion: the calling agent's JWT payload (already validated by guard)
  agent_payload?: JwtPayload;
}

interface TokenExchangeResult {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  owner_user_id: string;
}

@Injectable()
export class TokenExchangeService {
  private readonly logger = new Logger(TokenExchangeService.name);

  constructor(
    @InjectRepository(IdentityProviderEntity)
    private readonly idpRepo: Repository<IdentityProviderEntity>,
    @InjectRepository(TenantEntity)
    private readonly tenantRepo: Repository<TenantEntity>,
    @InjectRepository(UserIdentityEntity)
    private readonly identityRepo: Repository<UserIdentityEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly jwksService: ExternalJwksService,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
  ) {}

  async exchange(params: TokenExchangeParams, tenantId?: string): Promise<TokenExchangeResult> {
    if (params.subject_token_type === 'oidc_jwt') {
      return this.exchangeOidcJwt(params, tenantId);
    }
    if (params.subject_token_type === 'agent_assertion') {
      return this.exchangeAgentAssertion(params);
    }
    throw new UnauthorizedException(`Unsupported subject_token_type: ${params.subject_token_type}`);
  }

  private async exchangeOidcJwt(params: TokenExchangeParams, tenantId?: string): Promise<TokenExchangeResult> {
    // 1. Decode JWT header (unverified) to get iss and kid
    const parts = params.subject_token.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Invalid JWT format');
    }

    let header: { kid?: string; alg?: string };
    let unverifiedPayload: { iss?: string; sub?: string; exp?: number; nbf?: number; aud?: string | string[]; [k: string]: unknown };
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      unverifiedPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch {
      throw new UnauthorizedException('Failed to decode JWT');
    }

    const issuer = unverifiedPayload.iss;
    const kid = header.kid;
    if (!issuer) {
      throw new UnauthorizedException('JWT missing iss claim');
    }

    // 2. Find matching IdP
    let idp: IdentityProviderEntity | null;
    if (params.idp_id) {
      idp = await this.idpRepo.findOne({
        where: { id: params.idp_id, enabled: true, ...(tenantId ? { tenant_id: tenantId } : {}) },
      });
    } else {
      idp = await this.idpRepo.findOne({
        where: { issuer_url: issuer, enabled: true, ...(tenantId ? { tenant_id: tenantId } : {}) },
      });
    }

    if (!idp) {
      throw new UnauthorizedException(`No registered IdP for issuer: ${issuer}`);
    }

    // 3. Verify JWT signature
    let verifiedPayload: typeof unverifiedPayload;
    try {
      const publicKey = kid
        ? await this.jwksService.getPublicKey(idp.issuer_url || issuer, kid)
        : await this.getFirstKey(idp.issuer_url || issuer);

      // Use jsonwebtoken directly to verify with external JWKS public key
      verifiedPayload = jwt.verify(params.subject_token, publicKey, {
        algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
        issuer: idp.issuer_url || undefined,
        audience: idp.audience || undefined,
      }) as typeof unverifiedPayload;
    } catch (err) {
      // On signature failure, try force refresh JWKS once
      if (kid && (err as Error).message?.includes('signature')) {
        this.logger.warn(`Signature failed for ${issuer}, refreshing JWKS`);
        await this.jwksService.forceRefresh(idp.issuer_url || issuer);
        try {
          const refreshedKey = await this.jwksService.getPublicKey(idp.issuer_url || issuer, kid);
          verifiedPayload = jwt.verify(params.subject_token, refreshedKey, {
            algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
            issuer: idp.issuer_url || undefined,
            audience: idp.audience || undefined,
          }) as typeof unverifiedPayload;
        } catch {
          throw new UnauthorizedException('JWT signature verification failed after JWKS refresh');
        }
      } else {
        this.logger.error(`JWT verification failed for issuer ${issuer}: ${(err as Error).message}`);
        throw new UnauthorizedException(`JWT verification failed: ${(err as Error).message}`);
      }
    }

    // 4. JWT expiry is already validated by jsonwebtoken.verify() (checks exp claim)
    // No additional age check needed — Frontegg JWTs have 24h TTL and users stay logged in

    // 5. Extract owner_user_id from configured claim
    const ownerUserId = String(verifiedPayload[idp.user_id_claim] || verifiedPayload.sub || '');
    if (!ownerUserId) {
      throw new UnauthorizedException('JWT missing user identifier claim');
    }

    // 6. Resolve tenant — dynamic from JWT claim or static from IdP registration
    let resolvedTenantId = idp.tenant_id;
    if (idp.tenant_id_claim) {
      const claimValue = String(verifiedPayload[idp.tenant_id_claim] || '');
      if (!claimValue) {
        throw new UnauthorizedException(`JWT missing tenant claim: ${idp.tenant_id_claim}`);
      }
      const tenant = await this.tenantRepo.findOne({ where: { id: claimValue } });
      if (!tenant) {
        if (idp.allow_auto_provision) {
          // Auto-provision tenant using claim value as ID
          const created = this.tenantRepo.create({ id: claimValue, name: claimValue });
          const saved = await this.tenantRepo.save(created);
          this.logger.log(`Auto-provisioned tenant: ${saved.id}`);
          resolvedTenantId = saved.id;
        } else {
          throw new UnauthorizedException(`Tenant not found: ${claimValue}`);
        }
      } else {
        resolvedTenantId = tenant.id;
      }
    }

    // 7. Issue Tabby JWT
    const ttl = params.requested_ttl_seconds || 3600;
    const jti = crypto.randomUUID();
    const email = String(verifiedPayload[idp.email_claim] || verifiedPayload.email || '');
    const emailDomain = email.split('@')[1] || '';
    const role = (idp.admin_domains?.length && emailDomain && idp.admin_domains.includes(emailDomain))
      ? 'Admin'
      : (idp.default_role || 'Operator');
    const payload: JwtPayload = {
      sub: `federated:${ownerUserId}`,
      tenant_id: resolvedTenantId,
      role,
      jti,
      kid: process.env.JWT_SIGNING_KEY_ID || 'v1',
      token_type: 'federated',
      owner_user_id: ownerUserId,
      idp_id: idp.id,
    };

    const token = this.jwtService.sign(payload, { expiresIn: ttl });

    await this.auditService.log({
      tenant_id: resolvedTenantId,
      actor_type: 'system',
      actor_id: `federated:${ownerUserId}`,
      event_type: 'auth.token_exchange.issued',
      payload: { idp_id: idp.id, owner_user_id: ownerUserId, mode: 'oidc_jwt', resolved_tenant: resolvedTenantId },
    });

    // Auto-provision federated user in users table (for email gate + audit trail)
    if (email && idp.allow_auto_provision) {
      try {
        const existing = await this.userRepo.findOne({ where: { id: ownerUserId } });
        if (!existing) {
          const newUser = this.userRepo.create({
            id: ownerUserId,
            tenant_id: resolvedTenantId,
            email,
            password_hash: null,
            role,
            status: 'ACTIVE',
          });
          await this.userRepo.save(newUser);
          this.logger.log(`Auto-provisioned federated user: ${ownerUserId} (${email})`);
        } else if (existing.email !== email) {
          existing.email = email;
          await this.userRepo.save(existing);
        }
      } catch (err) {
        this.logger.warn(`Failed to auto-provision user ${ownerUserId}: ${(err as Error).message}`);
      }
    }

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: ttl,
      owner_user_id: ownerUserId,
    };
  }

  private async exchangeAgentAssertion(params: TokenExchangeParams): Promise<TokenExchangeResult> {
    if (!params.agent_payload) {
      throw new UnauthorizedException('agent_assertion requires a valid agent token in Authorization header');
    }
    if (params.agent_payload.token_type !== 'agent') {
      throw new UnauthorizedException('agent_assertion requires token_type=agent');
    }
    if (!params.target_user_id) {
      throw new UnauthorizedException('agent_assertion requires target_user_id');
    }

    const ttl = params.requested_ttl_seconds || 3600;
    const jti = crypto.randomUUID();
    const payload: JwtPayload = {
      sub: `federated:${params.target_user_id}`,
      tenant_id: params.agent_payload.tenant_id,
      role: params.agent_payload.role || 'Operator',
      jti,
      kid: process.env.JWT_SIGNING_KEY_ID || 'v1',
      token_type: 'federated',
      owner_user_id: params.target_user_id,
      allowed_profiles: params.agent_payload.allowed_profiles,
    };

    const token = this.jwtService.sign(payload, { expiresIn: ttl });

    await this.auditService.log({
      tenant_id: params.agent_payload.tenant_id,
      actor_type: 'system',
      actor_id: `agent:${params.agent_payload.agent_client_id}`,
      event_type: 'auth.token_exchange.issued',
      payload: { owner_user_id: params.target_user_id, mode: 'agent_assertion' },
    });

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: ttl,
      owner_user_id: params.target_user_id,
    };
  }

  private async getFirstKey(issuerUrl: string): Promise<string> {
    // When no kid is provided, use the first key from JWKS
    const keys = await this.jwksService['getJwks'](issuerUrl);
    if (!keys.length) {
      throw new UnauthorizedException(`No keys in JWKS for ${issuerUrl}`);
    }
    return this.jwksService['jwkToPem'](keys[0]);
  }
}
