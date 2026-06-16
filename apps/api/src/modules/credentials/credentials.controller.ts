import {
  Controller, Post, Body, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsInt, Min, Max } from 'class-validator';
import { randomUUID } from 'crypto';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CredentialsService } from './credentials.service';

class RequestCredentialsDto {
  @ApiProperty({ example: 'hubspot-standard' })
  @IsString()
  profile_id: string;

  @ApiProperty({ example: 'default', required: false })
  @IsOptional()
  @IsString()
  credential_set_id?: string;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  force_refresh?: boolean;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  include_volatile?: boolean;

  @ApiProperty({
    example: 15,
    required: false,
    description: 'When set with force_refresh, blocks up to this many seconds waiting for fresh extraction. 0 = fire-and-forget (default). Max 30.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  wait_seconds?: number;
}

@ApiTags('Credentials')
@ApiBearerAuth()
@Controller('credentials')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CredentialsController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Post('request')
  @Roles('Admin', 'Operator', 'Agent')
  @ApiOperation({ summary: 'Request credentials', description: 'Retrieves extracted credentials (cookies, headers, CSRF, localStorage) for an ACTIVE profile. Returns from cache (60s LRU), decrypted MinIO artifact, or triggers on-demand extraction. Agent tokens are scoped to allowed_profiles.' })
  @ApiResponse({ status: 200, description: 'Credential envelope', schema: { example: { freshness: 'CACHED', request_id: 'req-uuid', profile_id: 'hubspot-standard', session_id: 'cccccccc-...', credentials: { cookies: [{ name: 'hubspotutk', value: 'abc123', domain: '.hubspot.com', path: '/', secure: true, httpOnly: true, volatility: 'STABLE' }], headers: [{ name: 'x-hubspot-csrf', value: 'csrf-value', volatility: 'VOLATILE' }], csrf: { token: 'csrf-meta', header_name: 'X-CSRF-Token', volatility: 'VOLATILE' } }, usage: { ttl_seconds: 3600, refresh_before_seconds: 3300, volatile_fields: ['csrf'] }, metadata: { extracted_at: '2026-03-18T10:02:00.000Z', extraction_duration_ms: 450, profile_version: '1.0.0' } } } })
  @ApiResponse({ status: 404, description: 'No ACTIVE profile or no HEALTHY session found' })
  @ApiResponse({ status: 403, description: 'Agent token not allowed for this profile' })
  @HttpCode(200)
  async request(@Body() dto: RequestCredentialsDto, @Req() req: any) {
    return this.credentialsService.requestCredentials({
      tenantId: req.user.tenant_id,
      profileId: dto.profile_id,
      credentialSetId: dto.credential_set_id,
      forceRefresh: dto.force_refresh,
      includeVolatile: dto.include_volatile,
      waitSeconds: dto.wait_seconds,
      requestId: randomUUID(),
      role: req.user.role,
      allowedProfiles: req.user.allowed_profiles,
      unrestrictedProfiles: req.user.unrestricted_profiles,
      ownerUserId: req.user.owner_user_id ?? null,
    });
  }
}
