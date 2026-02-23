import {
  Controller, Post, Get, Body, Param, Query, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsString, IsObject, IsArray, IsOptional, IsInt, IsUUID, Min, Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ProfilesService } from './profiles.service';

class CreateProfileDto {
  @IsString()
  profile_id: string;

  @IsUUID()
  app_id: string;

  @IsString()
  @Matches(/^\d+\.\d+\.\d+$/, { message: 'version must be semver (e.g., "1.0.0")' })
  version: string;

  @IsObject()
  login_config: Record<string, unknown>;

  @IsObject()
  credential_types: Record<string, unknown>;

  @IsArray()
  @IsString({ each: true })
  target_domains: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  login_concurrency_limit?: number;

  @IsOptional()
  @IsObject()
  extra_config?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  parent_version_id?: string;
}

@ApiTags('Profiles')
@Controller('admin/profiles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Post()
  @Roles('Admin')
  async create(@Body() dto: CreateProfileDto, @Req() req: any) {
    return this.profilesService.create(dto, req.user.tenant_id, req.user.user_id);
  }

  @Get()
  @Roles('Admin', 'Operator', 'Viewer')
  async findAll(@Query() query: PaginationQueryDto, @Req() req: any) {
    return this.profilesService.findAll(req.user.tenant_id, query.limit, query.offset);
  }

  @Get(':id')
  @Roles('Admin', 'Operator', 'Viewer')
  async findOne(@Param('id') id: string, @Req() req: any) {
    return this.profilesService.findOne(id, req.user.tenant_id);
  }

  @Post(':id/promote')
  @Roles('Admin')
  @HttpCode(200)
  async promote(@Param('id') id: string, @Req() req: any) {
    return this.profilesService.promote(id, req.user.tenant_id, req.user.user_id);
  }

  @Post(':id/rollback')
  @Roles('Admin')
  @HttpCode(200)
  async rollback(@Param('id') id: string, @Req() req: any) {
    return this.profilesService.rollback(id, req.user.tenant_id, req.user.user_id);
  }
}
