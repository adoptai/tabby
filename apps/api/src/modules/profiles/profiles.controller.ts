import {
  Controller, Post, Get, Delete, Body, Param, Query, Req, UseGuards, HttpCode, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiProperty } from '@nestjs/swagger';
import {
  IsString, IsObject, IsArray, IsOptional, IsInt, IsUUID, Min, Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ProfilesService } from './profiles.service';

class CreateProfileDto {
  @ApiProperty({ example: 'hubspot-standard' })
  @IsString()
  profile_id: string;

  @ApiProperty()
  @IsUUID()
  app_id: string;

  @ApiProperty({ example: '1.0.0' })
  @IsString()
  @Matches(/^\d+\.\d+\.\d+$/, { message: 'version must be semver (e.g., "1.0.0")' })
  version: string;

  @ApiProperty()
  @IsObject()
  login_config: Record<string, unknown>;

  @ApiProperty()
  @IsObject()
  credential_types: Record<string, unknown>;

  @ApiProperty({ example: ['app.hubspot.com'] })
  @IsArray()
  @IsString({ each: true })
  target_domains: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  login_concurrency_limit?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  extra_config?: Record<string, unknown>;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  parent_version_id?: string;

  @ApiProperty({ description: 'Target tenant UUID. Admin only — defaults to caller tenant if omitted.', required: false })
  @IsOptional()
  @IsUUID()
  tenant_id?: string;
}

@ApiTags('Profiles')
@ApiBearerAuth()
@Controller('admin/profiles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  private resolveTenantId(req: any, overrideTenantId?: string): string {
    if (overrideTenantId) {
      if (req.user.role !== 'Admin') {
        throw new ForbiddenException('Only Admin can specify tenant_id');
      }
      return overrideTenantId;
    }
    return req.user.tenant_id;
  }

  @Post()
  @Roles('Admin', 'Editor')
  @ApiOperation({ summary: 'Create service profile', description: 'Creates a new profile version in STAGING state. Profiles define what credentials to extract and how to validate them.' })
  @ApiResponse({ status: 201, description: 'Profile created' })
  async create(@Body() dto: CreateProfileDto, @Req() req: any) {
    const tenantId = this.resolveTenantId(req, dto.tenant_id);
    return this.profilesService.create(dto, tenantId, req.user.user_id);
  }

  @Get()
  @Roles('Admin', 'Editor', 'Operator', 'Viewer')
  @ApiOperation({ summary: 'List profiles' })
  @ApiResponse({ status: 200 })
  async findAll(@Query() query: PaginationQueryDto, @Req() req: any) {
    // Admin with no tenant_id filter sees all profiles across tenants
    const queryTenantId = (query as any).tenant_id;
    let tenantId: string | undefined;
    if (req.user.role === 'Admin') {
      tenantId = queryTenantId; // may be undefined (all tenants) or a specific tenant
    } else {
      tenantId = req.user.tenant_id;
    }
    return this.profilesService.findAll(tenantId, query.limit, query.offset);
  }

  @Get(':id')
  @Roles('Admin', 'Editor', 'Operator', 'Viewer')
  @ApiOperation({ summary: 'Get profile details' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  async findOne(@Param('id') id: string, @Req() req: any) {
    const tenantId = req.user.role === 'Admin' ? undefined : req.user.tenant_id;
    return this.profilesService.findOne(id, tenantId);
  }

  @Post(':id/promote')
  @Roles('Admin', 'Editor')
  @ApiOperation({ summary: 'Promote profile version', description: 'STAGING → CANARY (direct). CANARY → ACTIVE (requires canary_request_count ≥ 5 and error rate ≤ 20%).' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Profile promoted' })
  @ApiResponse({ status: 409, description: 'Canary criteria not met' })
  @HttpCode(200)
  async promote(@Param('id') id: string, @Req() req: any) {
    const tenantId = req.user.role === 'Admin' ? undefined : req.user.tenant_id;
    return this.profilesService.promote(id, tenantId, req.user.user_id);
  }

  @Post(':id/rollback')
  @Roles('Admin', 'Editor')
  @ApiOperation({ summary: 'Rollback profile version', description: 'CANARY → STAGING (resets counters). ACTIVE → RETIRED (reactivates parent).' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200 })
  @HttpCode(200)
  async rollback(@Param('id') id: string, @Req() req: any) {
    const tenantId = req.user.role === 'Admin' ? undefined : req.user.tenant_id;
    return this.profilesService.rollback(id, tenantId, req.user.user_id);
  }

  @Delete(':id')
  @Roles('Admin', 'Editor')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete service profile', description: 'Permanently deletes a profile version. Child versions that reference this profile as parent are detached (parent_version_id set to null). Admin or Editor role required.' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiResponse({ status: 204, description: 'Profile deleted' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async remove(@Param('id') id: string, @Req() req: any) {
    const tenantId = req.user.role === 'Admin' ? undefined : req.user.tenant_id;
    await this.profilesService.remove(id, tenantId, req.user.user_id);
  }
}
