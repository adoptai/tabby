import {
  Controller, Post, Get, Put, Delete, Body, Param, Query, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { AppsService } from './apps.service';
import { CreateAppDto, UpdateAppDto } from './apps.dto';

@ApiTags('Applications')
@ApiBearerAuth()
@Controller('apps')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AppsController {
  constructor(private readonly appsService: AppsService) {}

  @Post()
  @Roles('Admin', 'Operator')
  @HttpCode(201)
  async create(@Body() dto: CreateAppDto, @Req() req: any) {
    return this.appsService.create(dto, req.user.tenant_id, req.user.user_id);
  }

  @Get()
  @Roles('Admin', 'Operator', 'Viewer')
  async findAll(
    @Query() query: PaginationQueryDto,
    @Req() req: any,
  ) {
    return this.appsService.findAll(req.user.tenant_id, query.limit, query.offset);
  }

  @Get(':id')
  @Roles('Admin', 'Operator', 'Viewer')
  async findOne(@Param('id') id: string, @Req() req: any) {
    return this.appsService.findOne(id, req.user.tenant_id);
  }

  @Put(':id')
  @Roles('Admin', 'Operator')
  async update(@Param('id') id: string, @Body() dto: UpdateAppDto, @Req() req: any) {
    return this.appsService.update(id, dto, req.user.tenant_id, req.user.user_id);
  }

  @Delete(':id')
  @Roles('Admin')
  @HttpCode(200)
  async deactivate(@Param('id') id: string, @Req() req: any) {
    return this.appsService.deactivate(id, req.user.tenant_id, req.user.user_id);
  }
}
