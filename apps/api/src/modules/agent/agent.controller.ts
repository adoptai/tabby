import {
  Body, Controller, Get, Headers, HttpCode, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiHeader, ApiParam, ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { SessionState } from '@browser-hitl/shared';
import { JwtAuthGuard, Roles, RolesGuard } from '../../common/guards/roles.guard';
import { AgentService } from './agent.service';

export class RunUrlDto {
  @ApiProperty({ description: 'Target URL to automate login for (HTTPS only)', example: 'https://app.hubspot.com' })
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url: string;

  @ApiProperty({ description: 'Display name for the created app', example: 'HubSpot via Agent', required: false })
  @IsOptional()
  @IsString()
  app_name?: string;

  @ApiProperty({ description: 'K8s secret reference for login credentials', example: 'k8s:secret/hubspot-creds', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^k8s:secret\/.+$/, { message: 'credential_ref must use k8s:secret/{name} format' })
  credential_ref?: string;

  @ApiProperty({ description: 'Notification channels', example: ['slack:#tabby-experiments'], required: false })
  @IsOptional()
  @IsArray()
  notification_channels?: string[];

  @ApiProperty({ description: 'Slack channel shorthand', example: '#tabby-experiments', required: false })
  @IsOptional()
  @IsString()
  slack_channel?: string;

  @ApiProperty({ description: 'Override login DSL steps', required: false })
  @IsOptional()
  @IsArray()
  login_steps?: Record<string, unknown>[];

  @ApiProperty({ description: 'Override keepalive DSL actions', required: false })
  @IsOptional()
  @IsArray()
  keepalive_actions?: Record<string, unknown>[];

  @ApiProperty({ description: 'Keepalive interval (60-3600)', example: 300, required: false })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(3600)
  keepalive_interval_seconds?: number;

  @ApiProperty({ description: 'Number of sessions (1-10)', example: 1, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  desired_sessions?: number;

  @ApiProperty({ description: 'Wait for session to reach this state before returning', example: 'HEALTHY', required: false, enum: ['STARTING', 'HEALTHY', 'UNHEALTHY', 'LOGIN_NEEDED', 'LOGIN_IN_PROGRESS', 'FAILED', 'TERMINATED'] })
  @IsOptional()
  @IsEnum(SessionState)
  wait_for_state?: SessionState;

  @ApiProperty({ description: 'Max seconds to wait for target state (10-900)', example: 120, required: false })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(900)
  wait_timeout_seconds?: number;

  @ApiProperty({ description: 'Include VNC stream URL in response', example: true, required: false })
  @IsOptional()
  @IsBoolean()
  include_stream_url?: boolean;
}

@ApiTags('Agent')
@ApiBearerAuth()
@Controller('agent')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @ApiOperation({ summary: 'One-shot URL login', description: 'High-level endpoint that creates an app, scales a session, optionally waits for a target state, and returns the result. Designed for ABCD agent integration.' })
  @ApiHeader({ name: 'idempotency-key', required: false, description: 'Idempotency key for the operation' })
  @ApiResponse({ status: 201, description: 'Login session initiated' })
  @ApiResponse({ status: 400, description: 'Invalid URL or configuration' })
  @Post('run-url')
  @Roles('Admin', 'Operator')
  @HttpCode(201)
  async runUrl(
    @Body() dto: RunUrlDto,
    @Req() req: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.agentService.runUrl(
      dto,
      req.user.tenant_id,
      req.user.user_id,
      idempotencyKey,
    );
  }

  @Get('session-status/:profileId')
  @Roles('Admin', 'Editor', 'Operator', 'Agent')
  @ApiOperation({ summary: 'Get session status for a profile', description: 'Returns the most recent session status for a service profile, including HITL state and VNC stream URL when applicable.' })
  @ApiParam({ name: 'profileId', description: 'Service profile semantic name (e.g., "salesforce-main")' })
  @ApiResponse({ status: 200, description: 'Session status' })
  @ApiResponse({ status: 403, description: 'Agent not authorized for this profile' })
  @ApiResponse({ status: 404, description: 'No session or profile found' })
  async getSessionStatus(
    @Param('profileId') profileId: string,
    @Req() req: any,
  ) {
    return this.agentService.getSessionStatus(
      profileId,
      req.user.tenant_id,
      req.user.allowed_profiles || [],
      req.user.role,
      req.user.owner_user_id,
      req.user.unrestricted_profiles,
    );
  }
}
