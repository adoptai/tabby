import {
  Controller, Post, Get, Body, Param, Query, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { SessionsService } from './sessions.service';

class ScaleSessionsDto {
  @ApiProperty({ description: 'Target number of sessions for this app', example: 1, minimum: 0 })
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
  @ApiOperation({ summary: 'Scale session count', description: 'Set the desired number of worker sessions for an app. The controller reconcile loop (every 15s) will create or terminate sessions to match.' })
  @ApiParam({ name: 'id', description: 'Application UUID', example: 'ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj' })
  @ApiResponse({ status: 200, description: 'Desired count updated', schema: { example: { desired_sessions: 1, app_id: 'ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj' } } })
  @ApiResponse({ status: 400, description: 'Exceeds tenant max_sessions or invalid value' })
  @ApiResponse({ status: 404, description: 'App not found' })
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
  @ApiOperation({ summary: 'List sessions', description: 'Returns paginated list of sessions for the authenticated tenant.' })
  @ApiResponse({ status: 200, description: 'Paginated session list', schema: { example: { data: [{ id: 'cccccccc-...', state: 'HEALTHY', health_result_type: 'PASS', pod_name: 'worker-cccccccc-...' }], total: 1, limit: 50, offset: 0 } } })
  async findAll(
    @Query() query: PaginationQueryDto,
    @Req() req: any,
  ) {
    return this.sessionsService.findAll(req.user.tenant_id, query.limit, query.offset);
  }

  @Get('sessions/:id')
  @Roles('Admin', 'Operator', 'Viewer', 'Agent')
  @ApiOperation({ summary: 'Get session details', description: 'Returns full session entity including state, health result, intervention counts, and timestamps.' })
  @ApiParam({ name: 'id', description: 'Session UUID' })
  @ApiResponse({ status: 200, description: 'Session details' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async findOne(@Param('id') id: string, @Req() req: any) {
    return this.sessionsService.findOne(id, req.user.tenant_id);
  }

  @Get('sessions/:id/interventions')
  @Roles('Admin', 'Operator', 'Viewer')
  @ApiOperation({ summary: 'List interventions for session', description: 'Returns paginated list of HITL interventions (OTP, CAPTCHA, MANUAL) for a session.' })
  @ApiParam({ name: 'id', description: 'Session UUID' })
  @ApiResponse({ status: 200, description: 'Paginated intervention list' })
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
