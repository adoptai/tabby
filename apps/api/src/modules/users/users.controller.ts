import {
  Controller, Post, Get, Body, Query, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength, IsIn, IsUUID, Matches } from 'class-validator';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { UsersService } from './users.service';
import { DEFAULTS, PASSWORD_RULES } from '@browser-hitl/shared';

class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(DEFAULTS.MIN_PASSWORD_LENGTH)
  @Matches(PASSWORD_RULES.PATTERN, { message: PASSWORD_RULES.DESCRIPTION })
  password: string;

  @IsIn(['Admin', 'Operator', 'Viewer'])
  role: string;

  @IsUUID()
  tenant_id: string;
}

@ApiTags('Users')
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @Roles('Admin')
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
  async findAll(
    @Query() query: PaginationQueryDto,
    @Req() req: any,
  ) {
    return this.usersService.findAll(req.user.tenant_id, query.limit, query.offset);
  }
}
