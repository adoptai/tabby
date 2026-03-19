import {
  Controller, Post, Get, Body, Param, Query, Req, UseGuards, HttpCode,
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
}

@ApiTags('Profiles')
@ApiBearerAuth()
@Controller('admin/profiles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Post()
  @Roles('Admin')
  @ApiOperation({ summary: 'Create service profile', description: 'Creates a new profile version in STAGING state. Profiles define what credentials to extract and how to validate them.' })
  @ApiResponse({ status: 201, description: 'Profile created' })
  async create(@Body() dto: CreateProfileDto, @Req() req: any) {
    return this.profilesService.create(dto, req.user.tenant_id, req.user.user_id);
  }

  @Get()
  @Roles('Admin', 'Operator', 'Viewer')
  @ApiOperation({ summary: 'List profiles' })
  @ApiResponse({ status: 200 })
  async findAll(@Query() query: PaginationQueryDto, @Req() req: any) {
    return this.profilesService.findAll(req.user.tenant_id, query.limit, query.offset);
  }

  @Get(':id')
  @Roles('Admin', 'Operator', 'Viewer')
  @ApiOperation({ summary: 'Get profile details' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  async findOne(@Param('id') id: string, @Req() req: any) {
    return this.profilesService.findOne(id, req.user.tenant_id);
  }

  @Post(':id/promote')
  @Roles('Admin')
  @ApiOperation({ summary: 'Promote profile version', description: 'STAGING → CANARY (direct). CANARY → ACTIVE (requires canary_request_count ≥ 5 and error rate ≤ 20%).' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Profile promoted' })
  @ApiResponse({ status: 409, description: 'Canary criteria not met' })
  @HttpCode(200)
  async promote(@Param('id') id: string, @Req() req: any) {
    return this.profilesService.promote(id, req.user.tenant_id, req.user.user_id);
  }

  @Post(':id/rollback')
  @Roles('Admin')
  @ApiOperation({ summary: 'Rollback profile version', description: 'CANARY → STAGING (resets counters). ACTIVE → RETIRED (reactivates parent).' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200 })
  @HttpCode(200)
  async rollback(@Param('id') id: string, @Req() req: any) {
    return this.profilesService.rollback(id, req.user.tenant_id, req.user.user_id);
  }
}
