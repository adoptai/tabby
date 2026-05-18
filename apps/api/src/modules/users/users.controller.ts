import {
  Controller, Post, Get, Delete, Param, Body, Query, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength, IsIn, IsUUID, Matches } from 'class-validator';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { UsersService } from './users.service';
import { DEFAULTS, PASSWORD_RULES } from '@browser-hitl/shared';

class CreateUserDto {
  @ApiProperty({ example: 'operator@acme.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'SecureP@ss123!' })
  @IsString()
  @MinLength(DEFAULTS.MIN_PASSWORD_LENGTH)
  @Matches(PASSWORD_RULES.PATTERN, { message: PASSWORD_RULES.DESCRIPTION })
  password: string;

  @ApiProperty({ example: 'Operator', enum: ['Admin', 'Operator', 'Viewer'] })
  @IsIn(['Admin', 'Operator', 'Viewer'])
  role: string;

  @ApiProperty()
  @IsUUID()
  tenant_id: string;
}

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @Roles('Admin')
  @ApiOperation({ summary: 'Create user', description: 'Creates a new user. Password must be ≥12 chars with uppercase, lowercase, digit, and special character.' })
  @ApiResponse({ status: 201, description: 'User created', schema: { example: { user_id: 'uuid' } } })
  @HttpCode(201)
  async create(@Body() dto: CreateUserDto, @Req() req: any) {
    return this.usersService.create(
      dto.email,
      dto.password,
      dto.role,
      dto.tenant_id,
      req.user.user_id,
    );
  }

  @Get()
  @Roles('Admin', 'Operator')
  @ApiOperation({ summary: 'List users' })
  @ApiResponse({ status: 200, description: 'Paginated user list (no password hashes)' })
  async findAll(
    @Query() query: PaginationQueryDto,
    @Req() req: any,
  ) {
    return this.usersService.findAll(req.user.tenant_id, query.limit, query.offset);
  }

  @Delete(':id')
  @Roles('Admin')
  @ApiOperation({ summary: 'Delete user and all owned resources', description: 'Deletes a user and cascades to all their sessions, apps, profiles, and artifacts. Admin role required.' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'User deleted with summary of cleaned resources' })
  async remove(@Param('id') id: string, @Req() req: any) {
    return this.usersService.remove(id, req.user.user_id);
  }
}
