import {
  Controller, Post, Get, Put, Delete, Body, Param, Req,
  UseGuards, HttpCode, ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiProperty, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { IsString, MinLength, IsOptional, IsBoolean, IsIn, IsArray } from 'class-validator';
import { Roles, RolesGuard, JwtAuthGuard } from '../../common/guards/roles.guard';
import { IdentityProvidersService } from './identity-providers.service';

class CreateIdpDto {
  @ApiProperty({ example: 'Frontegg' })
  @IsString() @MinLength(1)
  name: string;

  @ApiProperty({ example: 'oidc' })
  @IsString() @IsIn(['oidc', 'saml'])
  provider_type: 'oidc' | 'saml';

  @ApiProperty({ required: false, example: 'https://auth.adopt.ai' })
  @IsOptional() @IsString()
  issuer_url?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  jwks_uri?: string;

  @ApiProperty({ required: false, description: 'Platform\'s client_id registered at the IdP. Used as the expected aud claim value.' })
  @IsOptional() @IsString()
  audience?: string;

  // ── Browser OAuth fields (admin-UI Generic OAuth) ──────────────────
  // Note: client_id and client_secret are now read from IDP_CLIENT_ID / IDP_CLIENT_SECRET env vars.
  @ApiProperty({ required: false, example: 'https://auth.adopt.ai/oauth/authorize' })
  @IsOptional() @IsString()
  auth_url?: string;

  @ApiProperty({ required: false, example: 'https://auth.adopt.ai/oauth/token' })
  @IsOptional() @IsString()
  token_url?: string;

  @ApiProperty({ required: false, example: 'https://auth.adopt.ai/identity/resources/users/v2/me' })
  @IsOptional() @IsString()
  userinfo_url?: string;

  @ApiProperty({ required: false, example: 'https://auth.adopt.ai/oauth/account/logout' })
  @IsOptional() @IsString()
  sign_out_url?: string;

  @ApiProperty({ required: false, example: 'openid,email,profile', description: 'Comma-separated OAuth scopes.' })
  @IsOptional() @IsString()
  scopes?: string;

  @ApiProperty({ required: false, example: ['adopt.ai'], description: 'Email domains that are granted Admin role on auto-provision.' })
  @IsOptional() @IsArray() @IsString({ each: true })
  admin_domains?: string[];

  // ── Claim mappings ─────────────────────────────────────────────────
  @ApiProperty({ required: false, example: 'tenantId', description: 'JWT claim containing the tenant ID. Enables dynamic multi-tenant routing.' })
  @IsOptional() @IsString()
  tenant_id_claim?: string;

  @ApiProperty({ required: false, example: 'sub' })
  @IsOptional() @IsString()
  user_id_claim?: string;

  @ApiProperty({ required: false, example: 'email' })
  @IsOptional() @IsString()
  email_claim?: string;

  @ApiProperty({ required: false, example: 'name' })
  @IsOptional() @IsString()
  name_claim?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  claim_mappings?: Record<string, string>;

  // ── Behavior ───────────────────────────────────────────────────────
  @ApiProperty({ required: false })
  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional() @IsBoolean()
  allow_auto_provision?: boolean;

  @ApiProperty({ required: false, example: 'Operator' })
  @IsOptional() @IsString()
  default_role?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsBoolean()
  allow_shared_session_fallback?: boolean;

  // ── Role mapping ────────────────────────────────────────────────────
  @ApiProperty({ required: false, example: 'roles', description: 'JWT claim containing source roles array, e.g. "roles" for Frontegg.' })
  @IsOptional() @IsString()
  role_claim?: string;

  @ApiProperty({ required: false, example: ['SuperAdmin'], description: 'Source role values that map to Tabby Admin.' })
  @IsOptional() @IsArray() @IsString({ each: true })
  admin_role_values?: string[];

  @ApiProperty({ required: false, example: ['Admin'], description: 'Source role values that map to Tabby Editor.' })
  @IsOptional() @IsArray() @IsString({ each: true })
  editor_role_values?: string[];
}

@ApiTags('Identity Providers')
@ApiBearerAuth()
@Controller('admin/identity-providers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IdentityProvidersController {
  constructor(private readonly idpService: IdentityProvidersService) {}

  @Post()
  @Roles('Admin')
  @HttpCode(201)
  @ApiOperation({ summary: 'Register an identity provider', description: 'Register an OIDC or SAML identity provider. Supports both API-path (JWKS validation) and browser-path (Generic OAuth) fields.' })
  async create(@Body() dto: CreateIdpDto, @Req() req: any) {
    return this.idpService.create(req.user.tenant_id, dto as any, req.user.user_id);
  }

  @Get()
  @Roles('Admin')
  @ApiOperation({ summary: 'List identity providers' })
  async findAll(@Req() req: any) {
    return this.idpService.findAll(req.user.tenant_id);
  }

  @Get(':id')
  @Roles('Admin')
  @ApiOperation({ summary: 'Get identity provider details' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.idpService.findOne(req.user.tenant_id, id);
  }

  @Put(':id')
  @Roles('Admin')
  @ApiOperation({ summary: 'Update identity provider' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateIdpDto, @Req() req: any) {
    return this.idpService.update(req.user.tenant_id, id, dto as any, req.user.user_id);
  }

  @Delete(':id')
  @Roles('Admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete identity provider' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.idpService.remove(req.user.tenant_id, id, req.user.user_id);
  }

  @Get(':id/test')
  @Roles('Admin')
  @ApiOperation({ summary: 'Test JWKS reachability', description: 'Fetches the JWKS document from the IdP and returns key count + latency.' })
  async test(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.idpService.testJwks(req.user.tenant_id, id);
  }
}
