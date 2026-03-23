import {
  Controller, Post, Get, Put, Delete, Body, Param, Query, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { AppsService } from './apps.service';
import { CreateAppDto, UpdateAppDto, ListAppsQueryDto } from './apps.dto';

@ApiTags('Applications')
@ApiBearerAuth()
@Controller('apps')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AppsController {
  constructor(private readonly appsService: AppsService) {}

  @Post()
  @Roles('Admin', 'Operator')
  @ApiOperation({ summary: 'Create application', description: 'Creates a new application with login DSL config, health checks, export policy, and notification channels. A worker session starts automatically if desired_session_count > 0.' })
  @ApiResponse({ status: 201, description: 'App created', schema: { example: { app_id: 'ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj' } } })
  @ApiResponse({ status: 400, description: 'Invalid config (login_config, keepalive_config, export_policy, or notification_config validation failed)' })
  @HttpCode(201)
  async create(@Body() dto: CreateAppDto, @Req() req: any) {
    return this.appsService.create(dto, req.user.tenant_id, req.user.user_id);
  }

  @Get()
  @Roles('Admin', 'Operator', 'Viewer')
  @ApiOperation({ summary: 'List applications' })
  @ApiResponse({ status: 200, description: 'Paginated app list' })
  @ApiResponse({ status: 400, description: 'Invalid field name in fields param' })
  async findAll(
    @Query() query: ListAppsQueryDto,
    @Req() req: any,
  ) {
    return this.appsService.findAll(req.user.tenant_id, query.limit, query.offset, query.fields);
  }

  @Get(':id')
  @Roles('Admin', 'Operator', 'Viewer')
  @ApiOperation({ summary: 'Get application details' })
  @ApiParam({ name: 'id', description: 'Application UUID' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'App not found' })
  async findOne(@Param('id') id: string, @Req() req: any) {
    return this.appsService.findOne(id, req.user.tenant_id);
  }

  @Put(':id')
  @Roles('Admin', 'Operator')
  @ApiOperation({ summary: 'Update application', description: 'Partial update — only provided fields are changed. Re-validates all config objects.' })
  @ApiParam({ name: 'id', description: 'Application UUID' })
  @ApiResponse({ status: 200, description: 'Updated app' })
  async update(@Param('id') id: string, @Body() dto: UpdateAppDto, @Req() req: any) {
    return this.appsService.update(id, dto, req.user.tenant_id, req.user.user_id);
  }

  @Delete(':id')
  @Roles('Admin')
  @ApiOperation({ summary: 'Deactivate application', description: 'Sets desired_session_count to 0. Controller terminates all sessions within 15s. Does NOT delete the app.' })
  @ApiParam({ name: 'id', description: 'Application UUID' })
  @ApiResponse({ status: 200, description: 'App deactivated', schema: { example: { app_id: 'ffffffff-...', desired_session_count: 0 } } })
  @HttpCode(200)
  async deactivate(@Param('id') id: string, @Req() req: any) {
    return this.appsService.deactivate(id, req.user.tenant_id, req.user.user_id);
  }
}
