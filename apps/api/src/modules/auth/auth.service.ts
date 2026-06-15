import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { createHmac, timingSafeEqual, randomUUID, randomBytes } from 'crypto';
import { UserEntity, AgentClientEntity } from '../../entities';
import { DEFAULTS, PASSWORD_RULES } from '@browser-hitl/shared';

export interface JwtPayload {
  sub: string;        // user_id or agent client_id or federated:external_id
  tenant_id: string;
  role: string;
  jti?: string;       // unique token ID for revocation
  kid?: string;       // key ID for rotation
  token_type?: 'human' | 'service' | 'agent' | 'federated';
  service_client_id?: string;
  agent_client_id?: string;
  allowed_profiles?: string[];
  unrestricted_profiles?: boolean;
  owner_user_id?: string;   // external user ID for per-user session isolation
  idp_id?: string;          // identity provider that federated this token
  exp?: number;       // expiration timestamp (set by JWT library)
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(AgentClientEntity)
    private readonly agentClientRepo: Repository<AgentClientEntity>,
    private readonly jwtService: JwtService,
  ) {}

  async validateUser(email: string, password: string): Promise<UserEntity> {
    const user = await this.userRepo.findOne({ where: { email, status: 'ACTIVE' } });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check account lockout (C2 remediation)
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remainingMs = new Date(user.locked_until).getTime() - Date.now();
      const remainingMin = Math.ceil(remainingMs / 60000);
      throw new UnauthorizedException(
        `Account is locked. Try again in ${remainingMin} minute(s).`,
      );
    }

    if (!user.password_hash) {
      throw new UnauthorizedException('This account uses SSO login — password login is not available');
    }
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      // Increment failed count and potentially lock
      const newCount = (user.failed_login_count || 0) + 1;
      const updates: Partial<UserEntity> = { failed_login_count: newCount } as any;
      if (newCount >= DEFAULTS.ACCOUNT_LOCKOUT_THRESHOLD) {
        (updates as any).locked_until = new Date(
          Date.now() + DEFAULTS.ACCOUNT_LOCKOUT_DURATION_MINUTES * 60000,
        );
      }
      await this.userRepo.update(user.id, updates);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Reset failed count on successful login
    if (user.failed_login_count > 0) {
      await this.userRepo.update(user.id, { failed_login_count: 0, locked_until: null } as any);
    }

    return user;
  }

  async login(email: string, password: string): Promise<{ token: string; expires_at: string }> {
    const user = await this.validateUser(email, password);

    const jti = randomUUID();
    const payload: JwtPayload = {
      sub: user.id,
      tenant_id: user.tenant_id,
      role: user.role,
      jti,
      kid: process.env.JWT_SIGNING_KEY_ID || 'v1',
      token_type: 'human',
    };

    const token = this.jwtService.sign(payload);
    const expiresAt = new Date(Date.now() + DEFAULTS.JWT_TTL_HOURS * 60 * 60 * 1000);

    return {
      token,
      expires_at: expiresAt.toISOString(),
    };
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, DEFAULTS.BCRYPT_COST);
  }

  verifyToken(token: string): JwtPayload {
    return this.jwtService.verify(token);
  }

  // =====================================================================
  // Agent Client Credentials (ADR-010)
  // =====================================================================

  /**
   * Hash an agent client secret using HMAC-SHA256.
   * NOT bcrypt — agent secrets are high-entropy machine-generated strings.
   * HMAC-SHA256 is ~0.01ms vs bcrypt's ~250ms. See ADR-010 amendment RT-01.
   */
  hashAgentSecret(secret: string): string {
    const key = this.getAgentSecretKey();
    return createHmac('sha256', key).update(secret).digest('hex');
  }

  /**
   * Verify an agent client secret against its stored hash.
   * Uses constant-time comparison to prevent timing attacks.
   */
  verifyAgentSecret(secret: string, storedHash: string): boolean {
    const computed = this.hashAgentSecret(secret);
    const computedBuf = Buffer.from(computed);
    const storedBuf = Buffer.from(storedHash);
    if (computedBuf.length !== storedBuf.length) {
      return false;
    }
    return timingSafeEqual(computedBuf, storedBuf);
  }

  /**
   * Generate a new agent client_id and client_secret pair.
   */
  generateAgentCredentials(): { client_id: string; client_secret: string } {
    const clientId = `${DEFAULTS.AGENT_CLIENT_ID_PREFIX}${randomBytes(16).toString('hex')}`;
    const clientSecret = `${DEFAULTS.AGENT_SECRET_PREFIX}${randomBytes(32).toString('hex')}`;
    return { client_id: clientId, client_secret: clientSecret };
  }

  /**
   * Issue a JWT token for an agent client (OAuth 2.0 Client Credentials flow).
   * Validates client_id/secret against the agent_clients table.
   */
  async issueAgentToken(
    clientId: string,
    clientSecret: string,
  ): Promise<{
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
    refresh_before: number;
    scope: string;
  }> {
    const client = await this.agentClientRepo.findOne({
      where: { client_id: clientId.trim() },
    });

    if (!client) {
      throw new UnauthorizedException('Invalid agent client credentials');
    }

    if (!client.enabled || client.revoked_at) {
      throw new UnauthorizedException('Agent client has been revoked');
    }

    if (!this.verifyAgentSecret(clientSecret, client.client_secret_hash)) {
      throw new UnauthorizedException('Invalid agent client credentials');
    }

    // Update last_used_at
    await this.agentClientRepo.update(client.id, { last_used_at: new Date() });

    const ttl = Math.max(
      DEFAULTS.AGENT_TOKEN_MIN_TTL_SECONDS,
      Math.min(client.token_ttl_seconds, DEFAULTS.AGENT_TOKEN_MAX_TTL_SECONDS),
    );

    const jti = randomUUID();
    const scope = ['auth:request', ...client.allowed_profiles.map(p => `profile:${p}`)].join(' ');

    const payload: JwtPayload = {
      sub: `agent:${client.client_id}`,
      tenant_id: client.tenant_id,
      role: 'Agent',
      jti,
      kid: process.env.JWT_SIGNING_KEY_ID || 'v1',
      token_type: 'agent',
      agent_client_id: client.client_id,
      allowed_profiles: client.allowed_profiles,
      unrestricted_profiles: client.unrestricted_profiles || undefined,
    };

    const token = this.jwtService.sign(payload, { expiresIn: ttl });

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: ttl,
      refresh_before: ttl - 300, // 5 minutes before expiry (RT-08)
      scope,
    };
  }

  /**
   * Register a new agent client. Admin-only operation.
   */
  async registerAgentClient(params: {
    name: string;
    tenant_id: string;
    allowed_profiles?: string[];
    unrestricted_profiles?: boolean;
    token_ttl_seconds?: number;
    rate_limit_per_minute?: number;
  }): Promise<{
    id: string;
    client_id: string;
    client_secret: string;
    name: string;
    tenant_id: string;
    allowed_profiles: string[];
    unrestricted_profiles: boolean;
    created_at: Date;
  }> {
    const { client_id, client_secret } = this.generateAgentCredentials();
    const secretHash = this.hashAgentSecret(client_secret);

    const entity = this.agentClientRepo.create({
      client_id,
      client_secret_hash: secretHash,
      name: params.name,
      tenant_id: params.tenant_id,
      allowed_profiles: params.allowed_profiles ?? [],
      unrestricted_profiles: params.unrestricted_profiles ?? false,
      token_ttl_seconds: params.token_ttl_seconds ?? DEFAULTS.AGENT_TOKEN_TTL_SECONDS,
      rate_limit_per_minute: params.rate_limit_per_minute ?? DEFAULTS.AGENT_RATE_LIMIT_PER_MINUTE,
    });

    const saved = await this.agentClientRepo.save(entity);

    return {
      id: saved.id,
      client_id: saved.client_id,
      client_secret, // returned ONCE, never stored in plaintext
      name: saved.name,
      tenant_id: saved.tenant_id,
      allowed_profiles: saved.allowed_profiles,
      unrestricted_profiles: saved.unrestricted_profiles,
      created_at: saved.created_at,
    };
  }

  /**
   * List agent clients for a tenant. Secrets are never returned.
   */
  async listAgentClients(tenantId: string): Promise<AgentClientEntity[]> {
    return this.agentClientRepo.find({
      where: { tenant_id: tenantId },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Revoke an agent client. Sets revoked_at and enabled=false.
   */
  async revokeAgentClient(clientEntityId: string, tenantId: string): Promise<void> {
    const client = await this.agentClientRepo.findOne({
      where: { id: clientEntityId, tenant_id: tenantId },
    });
    if (!client) {
      throw new UnauthorizedException('Agent client not found');
    }
    await this.agentClientRepo.update(client.id, {
      revoked_at: new Date(),
      enabled: false,
    });
  }

  /**
   * Rotate an agent client's secret. Returns the new secret (shown once).
   */
  async rotateAgentSecret(clientEntityId: string, tenantId: string): Promise<{
    client_id: string;
    client_secret: string;
  }> {
    const client = await this.agentClientRepo.findOne({
      where: { id: clientEntityId, tenant_id: tenantId },
    });
    if (!client) {
      throw new UnauthorizedException('Agent client not found');
    }
    if (!client.enabled || client.revoked_at) {
      throw new ForbiddenException('Cannot rotate secret for a revoked agent client');
    }

    const newSecret = `${DEFAULTS.AGENT_SECRET_PREFIX}${randomBytes(32).toString('hex')}`;
    const newHash = this.hashAgentSecret(newSecret);

    await this.agentClientRepo.update(client.id, {
      client_secret_hash: newHash,
    });

    return {
      client_id: client.client_id,
      client_secret: newSecret,
    };
  }

  // =====================================================================
  // Service Token (existing)
  // =====================================================================

  async issueServiceToken(
    clientId: string,
    clientSecret: string,
    tenantId: string,
    requestedRole?: string,
  ): Promise<{ token: string; expires_at: string; token_type: 'Bearer' }> {
    const normalizedClientId = clientId.trim();
    const normalizedTenantId = tenantId.trim();
    const cfgClientId = (process.env.SERVICE_AUTH_CLIENT_ID || '').trim();
    const cfgClientSecret = process.env.SERVICE_AUTH_CLIENT_SECRET || '';

    if (!cfgClientId || !cfgClientSecret) {
      throw new UnauthorizedException('Service authentication is not configured');
    }

    if (
      !this.constantTimeEqual(normalizedClientId, cfgClientId)
      || !this.constantTimeEqual(clientSecret, cfgClientSecret)
    ) {
      throw new UnauthorizedException('Invalid service client credentials');
    }

    const tenantAllowlistRaw = (process.env.SERVICE_AUTH_ALLOWED_TENANT_IDS || '').trim();
    if (!tenantAllowlistRaw) {
      throw new UnauthorizedException('Service client tenant allowlist is not configured');
    }
    const allowedTenantIds = this.parseCsv(tenantAllowlistRaw);
    const allowWildcardTenantScope = (process.env.SERVICE_AUTH_ALLOW_WILDCARD_TENANT_SCOPE || '')
      .trim()
      .toLowerCase() === 'true';

    if (allowedTenantIds.includes('*') && !allowWildcardTenantScope) {
      throw new UnauthorizedException(
        'Wildcard tenant scope is disabled. Configure explicit tenant IDs or set SERVICE_AUTH_ALLOW_WILDCARD_TENANT_SCOPE=true',
      );
    }

    if (!allowedTenantIds.includes('*') && !allowedTenantIds.includes(normalizedTenantId)) {
      throw new UnauthorizedException('Service client is not authorized for this tenant');
    }

    const allowedRoles = this.parseCsv(process.env.SERVICE_AUTH_ALLOWED_ROLES || 'Operator');
    const defaultRole = (process.env.SERVICE_AUTH_DEFAULT_ROLE || 'Operator').trim();
    const role = (requestedRole || defaultRole).trim();
    if (!allowedRoles.includes(role)) {
      throw new UnauthorizedException(`Requested role is not allowed: ${role}`);
    }

    const ttlSeconds = this.parseTtlSeconds(process.env.SERVICE_AUTH_TOKEN_TTL_SECONDS);
    const payload: JwtPayload = {
      sub: `svc:${normalizedClientId}`,
      tenant_id: normalizedTenantId,
      role,
      jti: randomUUID(),
      kid: process.env.JWT_SIGNING_KEY_ID || 'v1',
      token_type: 'service',
      service_client_id: normalizedClientId,
    };

    const token = this.jwtService.sign(payload, { expiresIn: ttlSeconds });
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    return {
      token,
      expires_at: expiresAt.toISOString(),
      token_type: 'Bearer',
    };
  }

  // =====================================================================
  // Private helpers
  // =====================================================================

  private getAgentSecretKey(): string {
    const key = (process.env.AGENT_SECRET_HMAC_KEY || '').trim();
    if (!key) {
      // In test, fall back to a test-only key
      if ((process.env.NODE_ENV || '').trim() === 'test') {
        return 'test-agent-hmac-key-minimum-32-characters-long';
      }
      throw new Error('AGENT_SECRET_HMAC_KEY must be configured');
    }
    return key;
  }

  private constantTimeEqual(actual: string, expected: string): boolean {
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length) {
      return false;
    }
    return timingSafeEqual(actualBytes, expectedBytes);
  }

  private parseCsv(value: string): string[] {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  private parseTtlSeconds(raw?: string): number {
    const parsed = Number.parseInt(raw || '3600', 10);
    if (!Number.isFinite(parsed)) {
      return 3600;
    }
    return Math.max(60, Math.min(parsed, 24 * 60 * 60));
  }
}
