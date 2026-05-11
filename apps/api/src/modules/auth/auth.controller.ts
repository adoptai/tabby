import {
  Controller, Post, Get, Delete, Body, Param, HttpCode,
  UseGuards, Req, Res, ParseUUIDPipe, UnauthorizedException, Query, BadRequestException,
  Logger, OnModuleDestroy,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiProperty, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { requireEnv } from '@browser-hitl/shared';
import { AuthService } from './auth.service';
import { TokenBlacklistService } from './token-blacklist.service';
import { TokenExchangeService } from './token-exchange.service';
import { OAuthProviderService } from './oauth-provider.service';
import {
  IsEmail, IsString, MinLength, IsUUID, IsOptional,
  IsArray, ArrayMinSize, IsInt, Min, Max, Matches,
} from 'class-validator';
import { DEFAULTS } from '@browser-hitl/shared';
import { AuditService } from '../audit/audit.service';
import { Throttle } from '@nestjs/throttler';
import { Roles, RolesGuard, JwtAuthGuard } from '../../common/guards/roles.guard';
import { IdentityProviderEntity } from '../../entities/identity-provider.entity';
import { TenantEntity } from '../../entities/tenant.entity';
import { UserEntity } from '../../entities/user.entity';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from './auth.service';

// =====================================================================
// DTOs
// =====================================================================

class LoginDto {
  @ApiProperty({ example: 'admin@browser-hitl.local' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'LocalDev123!@#' })
  @IsString()
  @MinLength(1)
  password: string;
}

class ServiceTokenDto {
  @ApiProperty({ example: 'phase4-bot' })
  @IsString()
  @MinLength(1)
  client_id: string;

  @ApiProperty({ example: 'phase4-secret' })
  @IsString()
  @MinLength(1)
  client_secret: string;

  @ApiProperty({ example: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
  @IsUUID()
  tenant_id: string;

  @ApiProperty({ example: 'Operator', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  role?: string;
}

class AgentTokenDto {
  @ApiProperty({ example: 'agent_cl_a1b2c3d4e5f6a1b2' })
  @IsString()
  @MinLength(1)
  client_id: string;

  @ApiProperty({ example: 'secret_sk_abcdef0123456789...' })
  @IsString()
  @MinLength(1)
  client_secret: string;

  @ApiProperty({ example: 'client_credentials' })
  @IsString()
  @Matches(/^client_credentials$/, { message: 'grant_type must be "client_credentials"' })
  grant_type: string;
}

class RegisterAgentClientDto {
  @ApiProperty({ example: 'abcd-hubspot-agent' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({ example: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
  @IsUUID()
  tenant_id: string;

  @ApiProperty({ example: ['hubspot-standard'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  allowed_profiles: string[];

  @ApiProperty({ example: 3600, required: false })
  @IsOptional()
  @IsInt()
  @Min(DEFAULTS.AGENT_TOKEN_MIN_TTL_SECONDS)
  @Max(DEFAULTS.AGENT_TOKEN_MAX_TTL_SECONDS)
  token_ttl_seconds?: number;

  @ApiProperty({ example: 30, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  rate_limit_per_minute?: number;
}

class TokenExchangeDto {
  @ApiProperty({ description: 'The external JWT or agent token to exchange' })
  @IsString()
  @MinLength(1)
  subject_token: string;

  @ApiProperty({ description: 'Token type: oidc_jwt or agent_assertion', example: 'oidc_jwt' })
  @IsString()
  @Matches(/^(oidc_jwt|agent_assertion)$/, { message: 'subject_token_type must be "oidc_jwt" or "agent_assertion"' })
  subject_token_type: 'oidc_jwt' | 'agent_assertion';

  @ApiProperty({ required: false, description: 'Hint which IdP to use (UUID)' })
  @IsOptional()
  @IsUUID()
  idp_id?: string;

  @ApiProperty({ required: false, description: 'Target user ID for agent_assertion mode' })
  @IsOptional()
  @IsString()
  target_user_id?: string;

  @ApiProperty({ required: false, description: 'Requested token TTL in seconds (300-3600)', example: 3600 })
  @IsOptional()
  @IsInt()
  @Min(300)
  @Max(3600)
  requested_ttl_seconds?: number;
}

// =====================================================================
// Controller
// =====================================================================

/** Module-level constant — avoids repeating the env-read inline everywhere. */
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:18080';

// OAuth state payload stored in Redis under oauth:state:{hex} (5-min TTL)
interface OAuthStatePayload {
  codeVerifier: string;
  idpId: string;
  postLoginRedirectUri: string;
  /** Stream token stored here so it never travels through the IdP redirect URI (M-4). */
  streamToken?: string;
}

@ApiTags('Authentication')
@ApiBearerAuth()
@Controller()
export class AuthController implements OnModuleDestroy {
  private readonly logger = new Logger(AuthController.name);
  private readonly redis: Redis;

  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
    private readonly tokenBlacklist: TokenBlacklistService,
    private readonly tokenExchangeService: TokenExchangeService,
    private readonly oauthProvider: OAuthProviderService,
    private readonly jwtService: JwtService,
    @InjectRepository(IdentityProviderEntity)
    private readonly idpRepo: Repository<IdentityProviderEntity>,
    @InjectRepository(TenantEntity)
    private readonly tenantRepo: Repository<TenantEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {
    // H-4: Redis client is instantiated directly (same pattern as StreamTokenService).
    // onModuleDestroy closes it to prevent connection leaks on hot-reload / test teardown.
    this.redis = new Redis(requireEnv('REDIS_URL', { testDefault: 'redis://localhost:6379' }), {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  // =================================================================
  // Human auth
  // =================================================================

  @ApiOperation({ summary: 'Login with email/password', description: 'Authenticate a human user and receive a JWT token. Rate limited to 5 requests per minute.' })
  @ApiResponse({ status: 200, description: 'JWT token issued', schema: { example: { token: 'eyJhbGciOi...', expires_at: '2026-03-19T14:30:00.000Z' } } })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: parseInt(process.env.LOGIN_THROTTLE_LIMIT || '5', 10), ttl: 60000 } })
  async login(@Body() dto: LoginDto) {
    const result = await this.authService.login(dto.email, dto.password);

    await this.auditService.log({
      actor_type: 'human',
      actor_id: dto.email,
      event_type: 'auth.login',
      payload: { email: dto.email },
    });

    return result;
  }

  @ApiOperation({ summary: 'Logout and revoke token', description: 'Revokes the current JWT token by adding its JTI to the blacklist.' })
  @ApiResponse({ status: 200, description: 'Token revoked', schema: { example: { message: 'Logged out successfully' } } })
  @Post('auth/logout')
  @HttpCode(200)
  @UseGuards(AuthGuard('jwt'))
  async logout(@Req() req: any) {
    const { jti, exp } = req.user;
    if (jti && exp) {
      await this.tokenBlacklist.revoke(jti, exp);
    }

    await this.auditService.log({
      actor_type: 'human',
      actor_id: req.user.user_id,
      event_type: 'auth.logout',
      payload: { user_id: req.user.user_id },
    });

    return { message: 'Logged out successfully' };
  }

  // =================================================================
  // Service token (existing — bots)
  // =================================================================

  @ApiOperation({ summary: 'Issue service token', description: 'OAuth-style service token for bots. Validates against SERVICE_AUTH_CLIENT_ID/SECRET env vars. Rate limited to 20/min.' })
  @ApiResponse({ status: 200, description: 'Service token issued', schema: { example: { token: 'eyJhbGciOi...', expires_at: '2026-03-19T14:30:00.000Z', token_type: 'Bearer' } } })
  @ApiResponse({ status: 401, description: 'Invalid client credentials or tenant not allowed' })
  @Post('auth/service-token')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async serviceToken(@Body() dto: ServiceTokenDto) {
    const result = await this.authService.issueServiceToken(
      dto.client_id,
      dto.client_secret,
      dto.tenant_id,
      dto.role,
    );

    await this.auditService.log({
      tenant_id: dto.tenant_id,
      actor_type: 'system',
      actor_id: `service:${dto.client_id}`,
      event_type: 'auth.service_token.issued',
      payload: {
        tenant_id: dto.tenant_id,
        role: dto.role || process.env.SERVICE_AUTH_DEFAULT_ROLE || 'Operator',
      },
    });

    return result;
  }

  // =================================================================
  // Agent token (ADR-010 — OAuth 2.0 Client Credentials)
  // =================================================================

  @ApiOperation({ summary: 'Issue agent token (OAuth 2.0 Client Credentials)', description: 'Issues a scoped JWT for AI agents. Token is scoped to allowed_profiles configured on the agent client. Rate limited to 60/min.' })
  @ApiResponse({ status: 200, description: 'Agent token issued', schema: { example: { access_token: 'eyJhbGciOi...', token_type: 'Bearer', expires_in: 3600, refresh_before: 3300, scope: 'auth:request profile:hubspot-standard' } } })
  @ApiResponse({ status: 401, description: 'Invalid client credentials, client revoked, or disabled' })
  @ApiResponse({ status: 400, description: 'grant_type must be "client_credentials"' })
  @Post('auth/agent-token')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async agentToken(@Body() dto: AgentTokenDto) {
    const result = await this.authService.issueAgentToken(
      dto.client_id,
      dto.client_secret,
    );

    await this.auditService.log({
      actor_type: 'system',
      actor_id: `agent:${dto.client_id}`,
      event_type: 'auth.agent_token.issued',
      payload: { client_id: dto.client_id },
    });

    return result;
  }

  // =================================================================
  // Agent client management (Admin-only, ADR-010)
  // =================================================================

  @ApiOperation({ summary: 'Register new agent client', description: 'Creates an agent client with dedicated client_id/secret scoped to specific profiles. The client_secret is returned ONLY in this response — store it securely.' })
  @ApiResponse({ status: 201, description: 'Agent client registered', schema: { example: { id: '11111111-2222-3333-4444-555555555555', client_id: 'agent_cl_a1b2c3d4...', client_secret: 'secret_sk_abcdef01...', name: 'abcd-hubspot-agent', tenant_id: 'aaaaaaaa-...', allowed_profiles: ['hubspot-standard'], created_at: '2026-03-18T10:00:00.000Z' } } })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  @Post('admin/agent-clients')
  @HttpCode(201)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  async registerAgentClient(@Body() dto: RegisterAgentClientDto, @Req() req: any) {
    const result = await this.authService.registerAgentClient({
      name: dto.name,
      tenant_id: dto.tenant_id,
      allowed_profiles: dto.allowed_profiles,
      token_ttl_seconds: dto.token_ttl_seconds,
      rate_limit_per_minute: dto.rate_limit_per_minute,
    });

    await this.auditService.log({
      tenant_id: dto.tenant_id,
      actor_type: 'human',
      actor_id: req.user.user_id,
      event_type: 'auth.agent_client.registered',
      payload: {
        client_id: result.client_id,
        name: dto.name,
        allowed_profiles: dto.allowed_profiles,
      },
    });

    return result;
  }

  @ApiOperation({ summary: 'List agent clients for tenant', description: 'Returns all agent clients for the given tenant. Secret hashes are never included.' })
  @ApiResponse({ status: 200, description: 'Agent client list (without secrets)' })
  @Get('admin/agent-clients/:tenantId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  async listAgentClients(@Param('tenantId') tenantId: string) {
    const clients = await this.authService.listAgentClients(tenantId);
    // Never return secret hashes
    return clients.map(c => ({
      id: c.id,
      client_id: c.client_id,
      name: c.name,
      tenant_id: c.tenant_id,
      allowed_profiles: c.allowed_profiles,
      token_ttl_seconds: c.token_ttl_seconds,
      rate_limit_per_minute: c.rate_limit_per_minute,
      enabled: c.enabled,
      last_used_at: c.last_used_at,
      revoked_at: c.revoked_at,
      created_at: c.created_at,
    }));
  }

  @ApiOperation({ summary: 'Revoke agent client', description: 'Disables the agent client. All existing tokens will fail on next validation.' })
  @ApiResponse({ status: 200, description: 'Client revoked', schema: { example: { message: 'Agent client revoked' } } })
  @Delete('admin/agent-clients/:id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  async revokeAgentClient(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.authService.revokeAgentClient(id, req.user.tenant_id);

    await this.auditService.log({
      tenant_id: req.user.tenant_id,
      actor_type: 'human',
      actor_id: req.user.user_id,
      event_type: 'auth.agent_client.revoked',
      payload: { agent_client_id: id },
    });

    return { message: 'Agent client revoked' };
  }

  @ApiOperation({ summary: 'Rotate agent client secret', description: 'Generates a new secret. Old secret immediately invalidated. New secret returned once — store securely.' })
  @ApiResponse({ status: 200, description: 'New credentials', schema: { example: { client_id: 'agent_cl_a1b2...', client_secret: 'secret_sk_newkey...' } } })
  @Post('admin/agent-clients/:id/rotate-secret')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  async rotateAgentSecret(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const result = await this.authService.rotateAgentSecret(id, req.user.tenant_id);

    await this.auditService.log({
      tenant_id: req.user.tenant_id,
      actor_type: 'human',
      actor_id: req.user.user_id,
      event_type: 'auth.agent_client.secret_rotated',
      payload: { client_id: result.client_id },
    });

    return result;
  }

  // =================================================================
  // Token Exchange (OIDC JWT / Agent Assertion)
  // =================================================================

  @ApiOperation({
    summary: 'Exchange external token for Tabby user-scoped token',
    description: 'RFC 8693-inspired token exchange. Accepts an external OIDC JWT or an agent assertion to issue a user-scoped Tabby JWT with owner_user_id for session isolation.',
  })
  @ApiResponse({ status: 200, description: 'Federated token issued' })
  @ApiResponse({ status: 401, description: 'Token validation failed' })
  @Post('auth/token-exchange')
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async tokenExchange(@Body() dto: TokenExchangeDto, @Req() req: any): Promise<{ access_token: string; token_type: string; expires_in: number; owner_user_id: string }> {
    // For agent_assertion, extract the agent's JWT from Authorization header
    let agentPayload = undefined;
    let tenantId: string | undefined;

    if (dto.subject_token_type === 'agent_assertion') {
      // The request must carry a valid agent JWT in Authorization header
      const authHeader = req.headers?.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        throw new UnauthorizedException('agent_assertion requires Bearer token in Authorization header');
      }
      try {
        agentPayload = this.authService.verifyToken(authHeader.slice(7));
        tenantId = agentPayload.tenant_id;
      } catch {
        throw new UnauthorizedException('Invalid agent token');
      }
    }

    return this.tokenExchangeService.exchange({
      subject_token: dto.subject_token,
      subject_token_type: dto.subject_token_type,
      idp_id: dto.idp_id,
      target_user_id: dto.target_user_id,
      requested_ttl_seconds: dto.requested_ttl_seconds,
      agent_payload: agentPayload,
    }, tenantId);
  }

  // =================================================================
  // Generic OAuth — browser login for admin-UI
  // =================================================================

  @ApiOperation({ summary: 'List OAuth-configured IdPs', description: 'Returns IdPs that have auth_url configured — these can be used for browser-based login.' })
  @Get('auth/oauth/providers')
  @ApiResponse({ status: 200, description: 'List of OAuth providers available for login' })
  async listOAuthProviders() {
    // Only return IdPs that have browser OAuth configured (have auth_url)
    const idps = await this.idpRepo.find({ where: { enabled: true } });
    return idps
      .filter(idp => idp.auth_url && idp.client_id)
      .map(idp => ({
        id: idp.id,
        name: idp.name,
        // Never expose client_secret
      }));
  }

  @ApiOperation({ summary: 'Start OAuth login flow', description: 'Redirects the browser to the IdP authorization endpoint. Used by the admin-UI login page.' })
  @Get('auth/oauth/:idpId/login')
  @ApiResponse({ status: 302, description: 'Redirects to IdP' })
  async oauthLogin(
    @Param('idpId', ParseUUIDPipe) idpId: string,
    @Query('redirect_uri') redirectUri: string,
    @Query('post_login') postLogin: string,
    @Query('stream_token') streamToken: string,
    @Res() res: any,
  ) {
    // Accept either redirect_uri (legacy admin-UI) or post_login (VNC gate)
    const postLoginRedirectUri = postLogin || redirectUri;
    if (!postLoginRedirectUri) throw new BadRequestException('redirect_uri or post_login is required');

    const idp = await this.idpRepo.findOne({ where: { id: idpId, enabled: true } });
    if (!idp || !idp.auth_url) throw new BadRequestException('IdP not found or not OAuth-configured');

    // H-1: Use randomBytes(32) instead of randomUUID() for 256-bit entropy.
    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = this.oauthProvider.generateCodeVerifier();
    const codeChallenge = this.oauthProvider.computeCodeChallenge(codeVerifier);

    // Store state in Redis with 5-min TTL (multi-replica safe).
    // M-4: streamToken is stored in Redis state — NOT in the redirect URI — so it
    // never appears in IdP server logs, browser Referer headers, or browser history.
    const statePayload: OAuthStatePayload = { codeVerifier, idpId, postLoginRedirectUri, streamToken: streamToken || undefined };
    await this.redis.set(`oauth:state:${state}`, JSON.stringify(statePayload), 'EX', 300);

    // Always use the generic callback URL so one redirect URI covers all IdPs
    const callbackUrl = `${PUBLIC_BASE_URL}/auth/oauth/callback`;

    const authUrl = this.oauthProvider.buildAuthorizationUrl(idp, callbackUrl, state, codeChallenge);
    return res.redirect(authUrl);
  }

  /**
   * Generic OAuth callback — no idpId in URL, recovered from Redis state.
   * Registered callback URL: {PUBLIC_BASE_URL}/auth/oauth/callback
   */
  @ApiOperation({ summary: 'Generic OAuth callback', description: 'Handles the IdP redirect after authentication. Exchanges code for tokens, issues Tabby JWT, sets tabby_vnc cookie, and redirects.' })
  @Get('auth/oauth/callback')
  @ApiResponse({ status: 302, description: 'Redirects to post-login destination' })
  async oauthCallbackGeneric(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: any,
  ) {
    return this.handleOauthCallback(undefined, code, state, error, res);
  }

  /**
   * Legacy per-IdP callback kept for backward compatibility.
   * Delegates to the generic handler. When idpIdHint is provided it is validated
   * against the idpId stored in Redis state — it does NOT gate state retrieval.
   * New integrations should register {PUBLIC_BASE_URL}/auth/oauth/callback instead.
   */
  @ApiOperation({ summary: 'OAuth callback (legacy per-IdP route)', description: 'Backward-compatible route. Prefer /auth/oauth/callback for new integrations.' })
  @Get('auth/oauth/:idpId/callback')
  @ApiResponse({ status: 302, description: 'Redirects to admin-UI with token' })
  async oauthCallback(
    @Param('idpId', ParseUUIDPipe) idpId: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: any,
  ) {
    return this.handleOauthCallback(idpId, code, state, error, res);
  }

  private async handleOauthCallback(
    idpIdHint: string | undefined,
    code: string,
    state: string,
    error: string,
    res: any,
  ) {
    // H-3: Whitelist the OAuth error param to prevent open reflection of IdP-controlled text.
    if (error) {
      const ALLOWED_OAUTH_ERRORS = [
        'access_denied', 'server_error', 'temporarily_unavailable',
        'invalid_request', 'unauthorized_client', 'unsupported_response_type', 'invalid_scope',
      ];
      const safeError = ALLOWED_OAUTH_ERRORS.includes(error) ? error : 'unknown_error';
      throw new UnauthorizedException(`OAuth error: ${safeError}`);
    }
    if (!code || !state) throw new BadRequestException('Missing code or state');

    // Retrieve and delete state atomically.
    // Note: getdel requires Redis 6.2+. For older deployments, replace with
    // a GET + DEL pipeline (non-atomic, but the PKCE verifier mitigates replay risk).
    const key = `oauth:state:${state}`;
    const raw = await this.redis.getdel(key);
    if (!raw) throw new UnauthorizedException('Invalid or expired OAuth state');

    const stored: OAuthStatePayload = JSON.parse(raw);

    // If a per-IdP route was used, verify the idpId matches state
    if (idpIdHint && stored.idpId !== idpIdHint) {
      throw new UnauthorizedException('OAuth state idpId mismatch');
    }

    const idp = await this.idpRepo.findOne({ where: { id: stored.idpId, enabled: true } });
    if (!idp) throw new UnauthorizedException('IdP not found');

    // Use the generic callback URL that was passed when initiating the flow
    const callbackUrl = `${PUBLIC_BASE_URL}/auth/oauth/callback`;

    // Exchange auth code for tokens
    const tokens = await this.oauthProvider.exchangeCode(idp, code, stored.codeVerifier, callbackUrl);

    // Fetch user info
    const claims = await this.oauthProvider.fetchUserInfo(idp, tokens.access_token);
    const { userId, email, name, tenantIdClaimValue } = this.oauthProvider.extractIdentity(idp, claims);

    if (!userId) throw new UnauthorizedException('Could not extract user identity from userinfo');

    // Resolve or auto-provision tenant
    let resolvedTenantId = '';
    if (tenantIdClaimValue && idp.tenant_id_claim) {
      const tenant = await this.tenantRepo.findOne({ where: { id: tenantIdClaimValue } });
      if (!tenant) {
        if (idp.allow_auto_provision) {
          const created = this.tenantRepo.create({ id: tenantIdClaimValue, name: tenantIdClaimValue });
          const saved = await this.tenantRepo.save(created);
          resolvedTenantId = saved.id;
        } else {
          throw new UnauthorizedException(`Tenant not found: ${tenantIdClaimValue}`);
        }
      } else {
        resolvedTenantId = tenant.id;
      }
    }

    // Determine role
    const role = this.oauthProvider.resolveRole(idp, email);

    // Issue Tabby JWT (24h, used for admin-UI and API calls)
    const jti = crypto.randomUUID();
    const payload: JwtPayload = {
      sub: `federated:${userId}`,
      tenant_id: resolvedTenantId,
      role,
      jti,
      kid: process.env.JWT_SIGNING_KEY_ID || 'v1',
      token_type: 'federated',
      owner_user_id: userId,
      idp_id: idp.id,
    };
    const token = this.jwtService.sign(payload, { expiresIn: 24 * 3600 });

    // Issue tabby_vnc cookie JWT (1h, scoped to VNC access)
    const vncJti = crypto.randomUUID();
    const vncPayload = {
      sub: userId,
      tenant_id: resolvedTenantId,
      type: 'vnc_access',
      owner_user_id: userId,
      jti: vncJti,
    };
    const vncToken = this.jwtService.sign(vncPayload, { expiresIn: 3600 });

    await this.auditService.log({
      tenant_id: resolvedTenantId,
      actor_type: 'human',
      actor_id: `federated:${userId}`,
      event_type: 'auth.oauth.login',
      payload: { idp_id: idp.id, owner_user_id: userId, email, role },
    });

    // Auto-provision federated user (for email gate + audit trail)
    if (email && idp.allow_auto_provision) {
      try {
        const existing = await this.userRepo.findOne({ where: { id: userId } });
        if (!existing) {
          await this.userRepo.save(this.userRepo.create({
            id: userId,
            tenant_id: resolvedTenantId,
            email,
            password_hash: null,
            role,
            status: 'ACTIVE',
          }));
        } else if (existing.email !== email) {
          existing.email = email;
          await this.userRepo.save(existing);
        }
      } catch (err: any) {
        // H-2: Only suppress Postgres duplicate-key races (code 23505).
        // All other errors are logged so they don't silently leave users without a local row.
        if (err?.code !== '23505') {
          this.logger.warn(`Auto-provision user failed: ${err?.message}`);
        }
      }
    }

    // Set HttpOnly VNC access cookie.
    // Cookie domain is intentionally omitted: scopes to the exact API host.
    const isHttps = PUBLIC_BASE_URL.startsWith('https://') || process.env.NODE_ENV === 'production';
    res.cookie('tabby_vnc', vncToken, {
      httpOnly: true,
      secure: isHttps,
      sameSite: 'lax',
      maxAge: 3600 * 1000,
      path: '/',
    });

    // Determine redirect destination
    let postLoginRedirectUri = stored.postLoginRedirectUri;

    // M-4: If a stream token was stored in Redis state (VNC flow), reconstruct
    // the final redirect with the token now — it was never in the OAuth redirect URI.
    if (stored.streamToken) {
      const sep = postLoginRedirectUri.includes('?') ? '&' : '?';
      postLoginRedirectUri = `${postLoginRedirectUri}${sep}token=${encodeURIComponent(stored.streamToken)}`;
    }

    // Only allow relative paths or same-origin URLs (prevent open redirect + JWT leak)
    const isRelative = postLoginRedirectUri.startsWith('/');
    if (!isRelative) {
      try {
        const parsed = new URL(postLoginRedirectUri);
        const allowed = new URL(PUBLIC_BASE_URL);
        if (parsed.origin !== allowed.origin) {
          throw new UnauthorizedException('post_login must be a relative path or same-origin URL');
        }
      } catch (e) {
        if (e instanceof UnauthorizedException) throw e;
        throw new UnauthorizedException('Invalid post_login URL');
      }
    }

    // M-2: Only suppress _token for known VNC paths. All other paths (relative or
    // absolute same-origin) receive _token so the admin-UI can authenticate.
    const isVncRedirect = postLoginRedirectUri.startsWith('/vnc/') || postLoginRedirectUri.startsWith('/s/');

    if (isVncRedirect) {
      return res.redirect(`${PUBLIC_BASE_URL}${postLoginRedirectUri}`);
    }

    // Relative or absolute same-origin non-VNC path — always include _token.
    const separator = postLoginRedirectUri.includes('?') ? '&' : '?';
    const dest = isRelative ? `${PUBLIC_BASE_URL}${postLoginRedirectUri}` : postLoginRedirectUri;
    return res.redirect(`${dest}${separator}_token=${encodeURIComponent(token)}`);
  }
}
