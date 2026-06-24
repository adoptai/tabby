import {
  Controller, Post, Body, Param, Req, UseGuards, HttpCode, Headers,
} from '@nestjs/common';
import { StreamTokenService } from '../streaming/stream-token.service';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiHeader, ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { HitlService } from './hitl.service';
import { Throttle } from '@nestjs/throttler';

class AcknowledgeDto {
  @ApiProperty({ description: 'Operator note explaining the failure or retry reason', example: 'Retrying with updated credentials', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

class ShortLinkDto {
  @ApiProperty({ description: 'Viewer mode injected into the short URL. Omit for default MCP resolve panel.', example: 'recording', required: false })
  @IsOptional()
  @IsString()
  @IsIn(['recording'])
  mode?: 'recording';
}

class InputDto {
  @ApiProperty({ description: 'Type of input being submitted', example: 'otp' })
  @IsString()
  input_type: string;

  @ApiProperty({ description: 'The input value', example: '123456' })
  @IsString()
  value: string;

  @ApiProperty({ description: 'Step index that requested this input', example: 5 })
  @IsInt()
  @Min(0)
  step_index: number;
}

@ApiTags('HITL')
@ApiBearerAuth()
@Controller('sessions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class HitlController {
  constructor(
    private readonly hitlService: HitlService,
    private readonly streamTokenService: StreamTokenService,
  ) {}

  @Post(':id/stream')
  @Roles('Admin', 'Editor', 'Operator', 'Viewer', 'Agent')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiOperation({ summary: 'Generate VNC/CDP stream URL', description: 'Returns a signed, short-lived URL to view the browser session via VNC or CDP. The URL contains an embedded auth token valid for 10 minutes.' })
  @ApiParam({ name: 'id', description: 'Session UUID' })
  @ApiResponse({ status: 200, description: 'Stream URL generated', schema: { example: { url: 'https://api.example.com/vnc/cccccccc-...?token=eyJ...', expires_at: '2026-03-18T10:12:00.000Z' } } })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async stream(@Param('id') sessionId: string, @Req() req: any) {
    return this.hitlService.generateStreamUrl(
      sessionId,
      req.user.tenant_id,
      req.user.user_id,
    );
  }

  @Post(':id/short-link')
  @Roles('Admin', 'Editor', 'Operator', 'Viewer', 'Agent')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate a short VNC URL', description: 'Creates a short redirect URL for the VNC viewer (10 min TTL). Use for display in space-constrained UIs.' })
  @ApiParam({ name: 'id', description: 'Session UUID' })
  @ApiResponse({ status: 200, description: 'Short URL generated', schema: { example: { short_url: 'https://api.example.com/s/abc12345' } } })
  async shortLink(
    @Param('id') sessionId: string,
    @Body() body: ShortLinkDto,
    @Req() req: any,
  ): Promise<{ short_url: string }> {
    const streamResult = await this.hitlService.generateStreamUrl(
      sessionId,
      req.user.tenant_id,
      req.user.user_id,
    );
    // Insert the appropriate query param BEFORE the URL fragment (#token=...).
    // Default: ?from=mcp (MCP resolve panel). With mode=recording: ?mode=recording (export panel).
    const queryParam = body.mode === 'recording' ? 'mode=recording' : 'from=mcp';
    const [urlBase, fragment] = streamResult.url.split('#', 2);
    const sep = urlBase.includes('?') ? '&' : '?';
    const urlWithParam = fragment !== undefined
      ? `${urlBase}${sep}${queryParam}#${fragment}`
      : `${urlBase}${sep}${queryParam}`;
    const shortId = await this.streamTokenService.createShortLink(urlWithParam);
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    return { short_url: `${base}/s/${shortId}` };
  }

  @Post(':id/takeover')
  @Roles('Admin', 'Editor', 'Operator')
  @HttpCode(200)
  @ApiOperation({ summary: 'Acquire baton (take browser control)', description: 'Transitions the baton from HUMAN_REQUESTED or HUMAN_RELEASED to HUMAN_CONTROL. The baton expires after 15 minutes of inactivity.' })
  @ApiParam({ name: 'id', description: 'Session UUID' })
  @ApiHeader({ name: 'idempotency-key', description: 'Optional idempotency key to prevent duplicate operations', required: false })
  @ApiResponse({ status: 200, description: 'Baton acquired', schema: { example: { baton_state: 'HUMAN_CONTROL', expires_at: '2026-03-18T10:17:00.000Z' } } })
  @ApiResponse({ status: 409, description: 'Baton not in takeover-ready state or owned by another user' })
  async takeover(
    @Param('id') sessionId: string,
    @Req() req: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.hitlService.takeover(
      sessionId,
      req.user.tenant_id,
      req.user.user_id,
      idempotencyKey,
    );
  }

  @Post(':id/release')
  @Roles('Admin', 'Editor', 'Operator')
  @HttpCode(200)
  @ApiOperation({ summary: 'Release baton (return control to automation)', description: 'Transitions baton from HUMAN_CONTROL to HUMAN_RELEASED. Only the baton owner (or Admin) can release.' })
  @ApiParam({ name: 'id', description: 'Session UUID' })
  @ApiHeader({ name: 'idempotency-key', required: false })
  @ApiResponse({ status: 200, description: 'Baton released', schema: { example: { baton_state: 'HUMAN_RELEASED' } } })
  async release(
    @Param('id') sessionId: string,
    @Req() req: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.hitlService.release(
      sessionId,
      req.user.tenant_id,
      req.user.user_id,
      req.user.role,
      idempotencyKey,
    );
  }

  @Post(':id/input')
  @Roles('Admin', 'Editor', 'Operator', 'Agent')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit human input', description: 'Stores a generic human input value in Redis (key: human_input:{sessionId}:{stepIndex}, TTL: 300s). Supports OTP, passwords, URLs, confirmations, etc.' })
  @ApiParam({ name: 'id', description: 'Session UUID' })
  @ApiHeader({ name: 'idempotency-key', required: false })
  @ApiResponse({ status: 200, description: 'Input delivered to Redis', schema: { example: { status: 'delivered' } } })
  async input(
    @Param('id') sessionId: string,
    @Body() dto: InputDto,
    @Req() req: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.hitlService.submitInput(
      sessionId,
      dto.input_type,
      dto.value,
      dto.step_index,
      req.user.tenant_id,
      req.user.user_id,
      idempotencyKey,
    );
  }

  @Post(':id/acknowledge')
  @Roles('Admin', 'Editor', 'Operator')
  @HttpCode(200)
  @ApiOperation({ summary: 'Acknowledge failure and retry', description: 'Transitions a FAILED session back to STARTING for retry. Increments retry_count. Rejects if session is in HITL pause (returns retry_after_seconds).' })
  @ApiParam({ name: 'id', description: 'Session UUID' })
  @ApiHeader({ name: 'idempotency-key', required: false })
  @ApiResponse({ status: 200, description: 'Session restarted', schema: { example: { state: 'STARTING' } } })
  @ApiResponse({ status: 409, description: 'Session in HITL pause', schema: { example: { error: { code: 'CONFLICT', message: 'Session is in HITL pause', details: { retry_after_seconds: 1200 } } } } })
  async acknowledge(
    @Param('id') sessionId: string,
    @Body() dto: AcknowledgeDto,
    @Req() req: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.hitlService.acknowledge(
      sessionId,
      req.user.tenant_id,
      req.user.user_id,
      dto.note,
      idempotencyKey,
    );
  }
}
