import {
  Controller, Post, Get, Body, Param, Query, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { SessionsService } from './sessions.service';

class ScaleSessionsDto {
  @IsInt()
  @Min(0)
  @Type(() => Number)
  desired_sessions: number;
}

@ApiTags('Sessions')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post('apps/:id/sessions/scale')
  @Roles('Admin', 'Operator')
  @HttpCode(200)
  async scale(
    @Param('id') appId: string,
    @Body() dto: ScaleSessionsDto,
    @Req() req: any,
  ) {
    return this.sessionsService.scale(
      appId,
      dto.desired_sessions,
      req.user.tenant_id,
      req.user.user_id,
    );
  }

  @Get('sessions')
  @Roles('Admin', 'Operator', 'Viewer')
  async findAll(
    @Query() query: PaginationQueryDto,
    @Req() req: any,
  ) {
    return this.sessionsService.findAll(req.user.tenant_id, query.limit, query.offset);
  }

  @Get('sessions/:id')
  @Roles('Admin', 'Operator', 'Viewer')
  async findOne(@Param('id') id: string, @Req() req: any) {
    return this.sessionsService.findOne(id, req.user.tenant_id);
  }

  @Get('sessions/:id/interventions')
  @Roles('Admin', 'Operator', 'Viewer')
  async findInterventions(
    @Param('id') sessionId: string,
    @Query() query: PaginationQueryDto,
    @Req() req: any,
  ) {
    return this.sessionsService.findInterventions(
      sessionId,
      req.user.tenant_id,
      query.limit,
      query.offset,
    );
  }
}
