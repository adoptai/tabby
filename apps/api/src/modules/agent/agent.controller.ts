import {
  Body, Controller, Headers, HttpCode, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url: string;

  @IsOptional()
  @IsString()
  app_name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^k8s:secret\/.+$/, { message: 'credential_ref must use k8s:secret/{name} format' })
  credential_ref?: string;

  @IsOptional()
  @IsArray()
  notification_channels?: string[];

  @IsOptional()
  @IsString()
  slack_channel?: string;

  @IsOptional()
  @IsArray()
  login_steps?: Record<string, unknown>[];

  @IsOptional()
  @IsArray()
  keepalive_actions?: Record<string, unknown>[];

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(3600)
  keepalive_interval_seconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  desired_sessions?: number;

  @IsOptional()
  @IsEnum(SessionState)
  wait_for_state?: SessionState;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(900)
  wait_timeout_seconds?: number;

  @IsOptional()
  @IsBoolean()
  include_stream_url?: boolean;
}

@ApiTags('Agent')
@Controller('agent')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

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
}
