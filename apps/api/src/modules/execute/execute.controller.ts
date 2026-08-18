import {
  Controller, Post, Body, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, Min, Max, IsObject, IsBoolean } from 'class-validator';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { ExecuteService } from './execute.service';
import { EXECUTE_LIMITS } from '@browser-hitl/shared';
import { AuditService } from '../audit/audit.service';

class ExecuteFetchDto {
  @ApiProperty({ example: 'hubspot-standard' })
  @IsString()
  profile_id: string;

  @ApiProperty({ example: 'https://api.hubspot.com/crm/v3/objects/contacts' })
  @IsString()
  url: string;

  @ApiProperty({ example: 'GET', required: false })
  @IsOptional()
  @IsString()
  method?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  headers?: Record<string, string>;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  body?: string | null;

  @ApiProperty({ example: 30000, required: false })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(EXECUTE_LIMITS.MAX_TIMEOUT_MS)
  timeout_ms?: number;

  @ApiProperty({
    required: false,
    description: 'Attach the profile\'s captured request headers (e.g. a client-minted bearer harvested via request_header_allowlist) to the fetch, server-side. The credential is pulled from the session the fetch runs in and never has to be supplied by the caller. Requires the profile to declare credential_types.headers (e.g. ["authorization"]) — otherwise captured headers are never surfaced and this is a no-op (the call returns 200 but the target may 401).',
  })
  @IsOptional()
  @IsBoolean()
  attach_captured_credentials?: boolean;

  @ApiProperty({
    required: false,
    description: 'When attaching captured credentials, force an immediate re-extraction first (for volatile silent-refresh bearers that rotate faster than refresh_interval_seconds).',
  })
  @IsOptional()
  @IsBoolean()
  refresh_credentials?: boolean;
}

class ExecuteBrowserDto {
  @ApiProperty({ example: 'hubspot-standard' })
  @IsString()
  profile_id: string;

  @ApiProperty({ example: 'navigate' })
  @IsString()
  command: string;

  @ApiProperty({ example: { url: 'https://example.com' }, required: false })
  @IsOptional()
  @IsObject()
  params?: Record<string, any>;

  @ApiProperty({ example: 30000, required: false })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(EXECUTE_LIMITS.MAX_TIMEOUT_MS)
  timeout_ms?: number;
}

@ApiTags('Execute')
@ApiBearerAuth()
@Controller('execute')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExecuteController {
  constructor(
    private readonly executeService: ExecuteService,
    private readonly auditService: AuditService,
  ) {}

  @Post('fetch')
  @Roles('Admin', 'Editor', 'Operator', 'Agent')
  @ApiOperation({
    summary: 'Execute fetch inside browser',
    description: 'Runs fetch() inside the authenticated Tabby browser session via page.evaluate(). Inherits the browser TLS fingerprint, cookies, and session state. Caller-supplied headers are forwarded as-is (including Cookie/Authorization overrides) — this is intentional since callers can only target sessions they own via profile authorization.',
  })
  @ApiResponse({ status: 200, description: 'Fetch response from the browser' })
  @ApiResponse({ status: 400, description: 'Invalid request (bad URL, scheme, body too large)' })
  @ApiResponse({ status: 403, description: 'Agent token not allowed for this profile' })
  @ApiResponse({ status: 404, description: 'No active profile or healthy session' })
  @ApiResponse({ status: 409, description: 'No healthy session available' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  @ApiResponse({ status: 502, description: 'Worker unreachable or fetch failed' })
  @ApiResponse({ status: 504, description: 'Worker request timed out' })
  @HttpCode(200)
  async fetch(@Body() dto: ExecuteFetchDto, @Req() req: any) {
    // Audited for the same reason as execute/browser: this runs fetch() inside
    // the authenticated session and inherits its cookies, so it can act on a
    // member's account. Method and URL are recorded; headers and body are not,
    // because they carry credentials and whatever was being sent with them.
    await this.auditService.log({
      tenant_id: req.user.tenant_id,
      actor_type: req.user.owner_user_id ? 'human' : 'system',
      actor_id: String(req.user.user_id ?? 'unknown'),
      event_type: 'execute.fetch.requested',
      payload: {
        profile_id: dto.profile_id,
        method: dto.method || 'GET',
        url: String(dto.url || '').split('?')[0],
        owner_user_id: req.user.owner_user_id ?? null,
        role: req.user.role,
      },
    });
    return this.executeService.executeFetch({
      tenantId: req.user.tenant_id,
      profileId: dto.profile_id,
      request: {
        url: dto.url,
        method: dto.method,
        headers: dto.headers,
        body: dto.body,
        timeout_ms: dto.timeout_ms,
      },
      role: req.user.role,
      allowedProfiles: req.user.allowed_profiles,
      unrestrictedProfiles: req.user.unrestricted_profiles,
      ownerUserId: req.user.owner_user_id ?? null,
      attachCaptured: dto.attach_captured_credentials,
      refreshCredentials: dto.refresh_credentials,
    });
  }

  @Post('browser')
  @Roles('Admin', 'Editor', 'Operator', 'Agent')
  @ApiOperation({
    summary: 'Execute browser command',
    description: 'Runs Playwright browser commands (navigate, click, type, screenshot, HAR capture, etc.) inside the authenticated Tabby browser session. One active consumer per session is enforced.',
  })
  @ApiResponse({ status: 200, description: 'Browser command result' })
  @ApiResponse({ status: 400, description: 'Invalid command or parameters' })
  @ApiResponse({ status: 403, description: 'Agent token not allowed for this profile' })
  @ApiResponse({ status: 404, description: 'No active profile or healthy session' })
  @ApiResponse({ status: 409, description: 'No healthy session or session occupied by another consumer' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  @ApiResponse({ status: 502, description: 'Worker unreachable' })
  @ApiResponse({ status: 504, description: 'Worker command timed out' })
  @HttpCode(200)
  async browser(@Body() dto: ExecuteBrowserDto, @Req() req: any) {
    // Audited BEFORE the command runs, and whatever it returns.
    //
    // This endpoint can hover, click and type inside a signed-in banking
    // session. When one lost its auth cookie mid-run, the worker log proved
    // WHAT ran and when, and nothing anywhere recorded WHO asked for it --
    // while merely opening the viewer was audited twice. A call that can act on
    // a member's account has to leave a trace of its caller.
    //
    // The command and its target are recorded; params are not, because they
    // carry typed values -- an OTP, an amount, a search term someone typed into
    // a bank.
    await this.auditService.log({
      tenant_id: req.user.tenant_id,
      actor_type: req.user.owner_user_id ? 'human' : 'system',
      actor_id: String(req.user.user_id ?? 'unknown'),
      event_type: 'execute.browser.requested',
      payload: {
        profile_id: dto.profile_id,
        command: dto.command,
        owner_user_id: req.user.owner_user_id ?? null,
        role: req.user.role,
      },
    });
    return this.executeService.executeBrowser({
      tenantId: req.user.tenant_id,
      profileId: dto.profile_id,
      request: {
        command: dto.command,
        params: dto.params || {},
        timeout_ms: dto.timeout_ms,
      },
      role: req.user.role,
      allowedProfiles: req.user.allowed_profiles,
      unrestrictedProfiles: req.user.unrestricted_profiles,
      ownerUserId: req.user.owner_user_id ?? null,
    });
  }
}
