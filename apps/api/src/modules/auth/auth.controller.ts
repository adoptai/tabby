import {
  Controller, Post, Get, Delete, Body, Param, HttpCode,
  UseGuards, Req, ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiProperty, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { TokenBlacklistService } from './token-blacklist.service';
import {
  IsEmail, IsString, MinLength, IsUUID, IsOptional,
  IsArray, ArrayMinSize, IsInt, Min, Max, Matches,
} from 'class-validator';
import { DEFAULTS } from '@browser-hitl/shared';
import { AuditService } from '../audit/audit.service';
import { Throttle } from '@nestjs/throttler';
import { Roles, RolesGuard, JwtAuthGuard } from '../../common/guards/roles.guard';

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

// =====================================================================
// Controller
// =====================================================================

@ApiTags('Authentication')
@ApiBearerAuth()
@Controller()
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
    private readonly tokenBlacklist: TokenBlacklistService,
  ) {}

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
  async listAgentClients(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
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
}
