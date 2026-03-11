import {
  Controller, Post, Get, Delete, Body, Param, HttpCode,
  UseGuards, Req, ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiProperty } from '@nestjs/swagger';
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
  @IsString()
  @MinLength(1)
  client_id: string;

  @IsString()
  @MinLength(1)
  client_secret: string;

  @IsUUID()
  tenant_id: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  role?: string;
}

class AgentTokenDto {
  @IsString()
  @MinLength(1)
  client_id: string;

  @IsString()
  @MinLength(1)
  client_secret: string;

  @IsString()
  @Matches(/^client_credentials$/, { message: 'grant_type must be "client_credentials"' })
  grant_type: string;
}

class RegisterAgentClientDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsUUID()
  tenant_id: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  allowed_profiles: string[];

  @IsOptional()
  @IsInt()
  @Min(DEFAULTS.AGENT_TOKEN_MIN_TTL_SECONDS)
  @Max(DEFAULTS.AGENT_TOKEN_MAX_TTL_SECONDS)
  token_ttl_seconds?: number;

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
