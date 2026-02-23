import {
  Controller, Post, Body, Req, UseGuards, HttpCode,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { randomUUID } from 'crypto';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CredentialsService } from './credentials.service';

class RequestCredentialsDto {
  @IsString()
  profile_id: string;

  @IsOptional()
  @IsString()
  credential_set_id?: string;

  @IsOptional()
  @IsBoolean()
  force_refresh?: boolean;

  @IsOptional()
  @IsBoolean()
  include_volatile?: boolean;
}

@ApiTags('Credentials')
@Controller('credentials')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CredentialsController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Post('request')
  @Roles('Admin', 'Operator', 'Agent')
  @HttpCode(200)
  async request(@Body() dto: RequestCredentialsDto, @Req() req: any) {
    return this.credentialsService.requestCredentials({
      tenantId: req.user.tenant_id,
      profileId: dto.profile_id,
      credentialSetId: dto.credential_set_id,
      forceRefresh: dto.force_refresh,
      includeVolatile: dto.include_volatile,
      requestId: randomUUID(),
    });
  }
}
