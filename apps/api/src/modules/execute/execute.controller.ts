import {
  Controller, Post, Body, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, Min, Max, IsObject } from 'class-validator';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { ExecuteService } from './execute.service';
import { EXECUTE_LIMITS } from '@browser-hitl/shared';

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
  constructor(private readonly executeService: ExecuteService) {}

  @Post('fetch')
  @Roles('Admin', 'Operator', 'Agent')
  @ApiOperation({
    summary: 'Execute fetch inside browser',
    description: 'Runs fetch() inside the authenticated Tabby browser session via page.evaluate(). Inherits the browser TLS fingerprint, cookies, and session state.',
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
      ownerUserId: req.user.owner_user_id ?? null,
    });
  }

  @Post('browser')
  @Roles('Admin', 'Operator', 'Agent')
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
      ownerUserId: req.user.owner_user_id ?? null,
    });
  }
}
