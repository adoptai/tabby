import {
  Controller, Post, Get, Patch, Delete, Body, Query, Req, Param, UseGuards, HttpCode, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiProperty, ApiParam } from '@nestjs/swagger';
import {
  IsString, MinLength, IsOptional, IsInt, Min, Max,
} from 'class-validator';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { TenantsService } from './tenants.service';

class CreateTenantDto {
  @ApiProperty({ example: 'acme-corp' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({ required: false, example: '2b8edae2-8c45-417f-92bc-d2cf748966c1', description: 'Custom tenant ID (e.g., Frontegg org ID). If omitted, a UUID is generated.' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ required: false, example: 10, description: 'Maximum concurrent sessions allowed for this tenant. Defaults to 10. Adjust via PATCH /tenants/:id to change later.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  max_sessions?: number;
}

class UpdateTenantDto {
  @ApiProperty({ required: false, example: 25, description: 'Maximum concurrent sessions allowed for this tenant. Controls the upper bound of desired_sessions across all applications. Must be between 1 and 1000.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  max_sessions?: number;
}

@ApiTags('Tenants')
@ApiBearerAuth()
@Controller('tenants')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post()
  @Roles('Admin', 'Editor')
  @ApiOperation({ summary: 'Create tenant', description: 'Creates a new tenant and provisions a MinIO bucket. Admin role required. Editor can only create their own tenant (id must match caller tenant_id).' })
  @ApiResponse({ status: 201, description: 'Tenant created', schema: { example: { tenant_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } } })
  @ApiResponse({ status: 409, description: 'Tenant name already exists' })
  @HttpCode(201)
  async create(@Body() dto: CreateTenantDto, @Req() req: any) {
    if (req.user.role === 'Editor') {
      const tenantId = dto.id ?? req.user.tenant_id;
      if (tenantId !== req.user.tenant_id) {
        throw new ForbiddenException('Editor can only create their own tenant');
      }
      return this.tenantsService.create(dto.name, req.user.user_id, req.user.tenant_id, dto.max_sessions);
    }
    return this.tenantsService.create(dto.name, req.user.user_id, dto.id, dto.max_sessions);
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

  @Get(':id')
  @ApiOperation({ summary: 'Get tenant by ID', description: 'Any authenticated user can check their own tenant. Admin can query any tenant.' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  @ApiResponse({ status: 200, description: 'Tenant details including current max_sessions' })
  @ApiResponse({ status: 403, description: 'Non-admin tried to read another tenant' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async findOne(@Param('id') id: string, @Req() req: any) {
    if (req.user.role !== 'Admin' && id !== req.user.tenant_id) {
      throw new ForbiddenException('You can only view your own tenant');
    }
    return this.tenantsService.findOne(id);
  }

  @Patch(':id')
  @Roles('Admin')
  @ApiOperation({ summary: 'Update tenant settings', description: 'Update configurable tenant settings such as max_sessions. Admin role required.' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  @ApiResponse({ status: 200, description: 'Tenant updated' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async update(@Param('id') id: string, @Body() dto: UpdateTenantDto, @Req() req: any) {
    return this.tenantsService.update(id, dto, req.user.user_id);
  }

  @Delete(':id')
  @Roles('Admin')
  @ApiOperation({ summary: 'Delete tenant', description: 'Permanently deletes a tenant and ALL associated data (sessions, apps, profiles, templates, users, artifacts, interventions) in a single transaction. If any step fails, everything is rolled back. Returns a summary of deleted rows per table.' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  @ApiResponse({ status: 200, description: 'Tenant deleted — returns { deleted: { table: count } }' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async remove(@Param('id') id: string, @Req() req: any) {
    return this.tenantsService.remove(id, req.user.user_id);
  }
}
