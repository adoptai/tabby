import {
  Controller, Post, Get, Put, Delete, Body, Param, Req,
  UseGuards, HttpCode, ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiProperty, ApiOperation } from '@nestjs/swagger';
import { IsString, MinLength, IsOptional, IsObject, IsInt, Min } from 'class-validator';
import { Roles, RolesGuard, JwtAuthGuard } from '../../common/guards/roles.guard';
import { AppTemplatesService } from './app-templates.service';

class CreateAppTemplateDto {
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

  @ApiProperty({ required: false, description: 'Auto-shutdown session after N seconds idle' })
  @IsOptional() @IsInt() @Min(60)
  idle_shutdown_seconds?: number;
}

@ApiTags('App Templates')
@ApiBearerAuth()
@Controller('admin/app-templates')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AppTemplatesController {
  constructor(private readonly templateService: AppTemplatesService) {}

  @Post()
  @Roles('Admin')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create app template', description: 'Create a reusable app config template for auto-provisioning per-user sessions.' })
  async create(@Body() dto: CreateAppTemplateDto, @Req() req: any) {
    return this.templateService.create(req.user.tenant_id, dto, req.user.user_id);
  }

  @Get()
  @Roles('Admin')
  @ApiOperation({ summary: 'List app templates' })
  async findAll(@Req() req: any) {
    return this.templateService.findAll(req.user.tenant_id);
  }

  @Get(':id')
  @Roles('Admin')
  @ApiOperation({ summary: 'Get app template details' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.templateService.findOne(req.user.tenant_id, id);
  }

  @Put(':id')
  @Roles('Admin')
  @ApiOperation({ summary: 'Update app template' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateAppTemplateDto, @Req() req: any) {
    return this.templateService.update(req.user.tenant_id, id, dto, req.user.user_id);
  }

  @Delete(':id')
  @Roles('Admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete app template' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.templateService.remove(req.user.tenant_id, id, req.user.user_id);
  }
}
