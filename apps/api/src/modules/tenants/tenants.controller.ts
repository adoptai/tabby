import {
  Controller, Post, Get, Body, Query, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { TenantsService } from './tenants.service';

class CreateTenantDto {
  @IsString()
  @MinLength(1)
  name: string;
}

@ApiTags('Tenants')
@ApiBearerAuth()
@Controller('tenants')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post()
  @Roles('Admin')
  @HttpCode(201)
  async create(@Body() dto: CreateTenantDto, @Req() req: any) {
    return this.tenantsService.create(dto.name, req.user.user_id);
  }

  @Get()
  @Roles('Admin')
  async findAll(
    @Query() query: PaginationQueryDto,
  ) {
    return this.tenantsService.findAll(query.limit, query.offset);
  }
}
