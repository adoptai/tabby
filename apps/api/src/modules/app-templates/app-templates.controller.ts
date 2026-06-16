import {
  Controller, Post, Get, Put, Patch, Delete, Body, Param, Query, Req,
  UseGuards, HttpCode, ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiProperty, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { IsString, MinLength, IsOptional, IsObject, IsInt, IsBoolean, IsArray, Min } from 'class-validator';
import { Roles, RolesGuard, JwtAuthGuard } from '../../common/guards/roles.guard';
import { AppTemplatesService } from './app-templates.service';
import { resolveTenantScope } from '../../common/helpers/tenant-scope.helper';

class CreateAppTemplateDto {
  @ApiProperty({ required: false, description: 'Target tenant ID. Admin-only: override to create in another tenant. Non-admin callers always use their own tenant.' })
  @IsOptional() @IsString()
  tenant_id?: string;

  @ApiProperty({ example: 'Salesforce' })
  @IsString() @MinLength(1)
  name: string;

  @ApiProperty({ example: 'sfdc-standard', description: 'Matches profile_id in credential requests for auto-provisioning' })
  @IsString() @MinLength(1)
  profile_name_pattern: string;

  @ApiProperty()
  @IsObject()
  login_config: Record<string, unknown>;

  @ApiProperty()
  @IsObject()
  keepalive_config: Record<string, unknown>;

  @ApiProperty()
  @IsObject()
  export_policy: Record<string, unknown>;

  @ApiProperty({ required: false })
  @IsOptional() @IsObject()
  browser_policy?: Record<string, unknown>;

  @ApiProperty({ required: false })
  @IsOptional() @IsObject()
  notification_config?: Record<string, unknown>;

  @ApiProperty({ required: false, example: 'manual:', description: 'Default credential_ref for auto-provisioned apps' })
  @IsOptional() @IsString()
  credential_ref_default?: string;

  @ApiProperty({ required: false, default: false, description: 'Whether apps auto-provisioned from this template can run POST /execute/fetch | /execute/browser. Carried onto each cloned app so the controller provisions the worker Service + JWT_SIGNING_KEY.' })
  @IsOptional() @IsBoolean()
  execute_enabled?: boolean;

  @ApiProperty({ required: false, description: 'Auto-shutdown session after N seconds idle' })
  @IsOptional() @IsInt() @Min(60)
  idle_shutdown_seconds?: number;

  @ApiProperty({ required: false, description: 'Extra egress domains cloned onto every auto-provisioned app (suffix patterns like ".expedia.com" or exact hosts). Typically populated from recorded HAR.', example: ['.expedia.com', '.trvl-media.com'] })
  @IsOptional() @IsArray() @IsString({ each: true })
  extra_egress_allowlist?: string[];
}

class UpdateAppTemplateDto {
  @ApiProperty({ required: false })
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @ApiProperty({ required: false })
  @IsOptional() @IsString() @MinLength(1) profile_name_pattern?: string;
  @ApiProperty({ required: false })
  @IsOptional() @IsObject() login_config?: Record<string, unknown>;
  @ApiProperty({ required: false })
  @IsOptional() @IsObject() keepalive_config?: Record<string, unknown>;
  @ApiProperty({ required: false })
  @IsOptional() @IsObject() export_policy?: Record<string, unknown>;
  @ApiProperty({ required: false })
  @IsOptional() @IsObject() browser_policy?: Record<string, unknown>;
  @ApiProperty({ required: false })
  @IsOptional() @IsObject() notification_config?: Record<string, unknown>;
  @ApiProperty({ required: false })
  @IsOptional() @IsString() credential_ref_default?: string;
  @ApiProperty({ required: false })
  @IsOptional() @IsBoolean() execute_enabled?: boolean;
  @ApiProperty({ required: false })
  @IsOptional() @IsInt() @Min(60) idle_shutdown_seconds?: number;
}

@ApiTags('App Templates')
@ApiBearerAuth()
@Controller('admin/app-templates')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AppTemplatesController {
  constructor(private readonly templateService: AppTemplatesService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create app template', description: 'Create a reusable app config template for auto-provisioning. Any authenticated user can create templates in their own tenant. Admins can override tenant_id to create in another tenant.' })
  async create(@Body() dto: CreateAppTemplateDto, @Req() req: any) {
    const tenantId = (req.user.role === 'Admin' && dto.tenant_id) ? dto.tenant_id : req.user.tenant_id;
    return this.templateService.create(tenantId, dto, req.user.user_id);
  }

  @Get()
  @ApiOperation({ summary: 'List app templates', description: 'Returns templates for the caller\'s tenant. Admins can pass ?tenant_id= to query another tenant, or omit to see all.' })
  @ApiQuery({ name: 'tenant_id', required: false, description: 'Filter by tenant (Admin only). Non-admins always see their own tenant.' })
  async findAll(@Req() req: any, @Query('tenant_id') queryTenantId?: string) {
    const tenantScope = resolveTenantScope(req.user);
    return this.templateService.findAll(tenantScope ?? queryTenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get app template details' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.templateService.findOne(resolveTenantScope(req.user), id);
  }

  @Put(':id')
  @Roles('Admin', 'Editor')
  @ApiOperation({ summary: 'Update app template' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateAppTemplateDto, @Req() req: any) {
    return this.templateService.update(resolveTenantScope(req.user), id, dto, req.user.user_id);
  }

  @Patch(':id')
  @Roles('Admin', 'Editor')
  @ApiOperation({ summary: 'Partially update app template' })
  async patch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAppTemplateDto, @Req() req: any) {
    return this.templateService.update(resolveTenantScope(req.user), id, dto, req.user.user_id);
  }

  @Delete(':id')
  @Roles('Admin', 'Editor')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete app template' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.templateService.remove(resolveTenantScope(req.user), id, req.user.user_id);
  }
}
