import {
  Controller, Post, Get, Body, Query, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { TenantsService } from './tenants.service';

class CreateTenantDto {
  @ApiProperty({ example: 'acme-corp' })
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
  @ApiOperation({ summary: 'Create tenant', description: 'Creates a new tenant and provisions a MinIO bucket. Admin role required.' })
  @ApiResponse({ status: 201, description: 'Tenant created', schema: { example: { tenant_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } } })
  @ApiResponse({ status: 409, description: 'Tenant name already exists' })
  @HttpCode(201)
  async create(@Body() dto: CreateTenantDto, @Req() req: any) {
    return this.tenantsService.create(dto.name, req.user.user_id);
  }

  @Get()
  @Roles('Admin')
  @ApiOperation({ summary: 'List tenants' })
  @ApiResponse({ status: 200, description: 'Paginated tenant list' })
  async findAll(
    @Query() query: PaginationQueryDto,
  ) {
    return this.tenantsService.findAll(query.limit, query.offset);
  }
}
