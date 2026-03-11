import {
  Controller, Post, Body, Param, Req, UseGuards, HttpCode, Headers,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { HitlService } from './hitl.service';
import { Throttle } from '@nestjs/throttler';

class OtpDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{4,10}$/, { message: 'otp_value must be alphanumeric (4-10 chars)' })
  otp_value?: string;

  /** Alias for otp_value - accepts either field name. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{4,10}$/, { message: 'code must be alphanumeric (4-10 chars)' })
  code?: string;
}

class AcknowledgeDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

@ApiTags('HITL')
@ApiBearerAuth()
@Controller('sessions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class HitlController {
  constructor(private readonly hitlService: HitlService) {}

  @Post(':id/stream')
  @Roles('Admin', 'Operator', 'Viewer')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async stream(@Param('id') sessionId: string, @Req() req: any) {
    return this.hitlService.generateStreamUrl(
      sessionId,
      req.user.tenant_id,
      req.user.user_id,
    );
  }

  @Post(':id/takeover')
  @Roles('Admin', 'Operator')
  @HttpCode(200)
  async takeover(
    @Param('id') sessionId: string,
    @Req() req: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.hitlService.takeover(
      sessionId,
      req.user.tenant_id,
      req.user.user_id,
      idempotencyKey,
    );
  }

  @Post(':id/release')
  @Roles('Admin', 'Operator')
  @HttpCode(200)
  async release(
    @Param('id') sessionId: string,
    @Req() req: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.hitlService.release(
      sessionId,
      req.user.tenant_id,
      req.user.user_id,
      req.user.role,
      idempotencyKey,
    );
  }

  @Post(':id/otp')
  @Roles('Admin', 'Operator')
  @HttpCode(200)
  async otp(
    @Param('id') sessionId: string,
    @Body() dto: OtpDto,
    @Req() req: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const otpValue = dto.otp_value ?? dto.code;
    if (!otpValue) {
      throw new BadRequestException('Either otp_value or code is required');
    }
    return this.hitlService.submitOtp(
      sessionId,
      otpValue,
      req.user.tenant_id,
      req.user.user_id,
      idempotencyKey,
    );
  }

  @Post(':id/acknowledge')
  @Roles('Admin', 'Operator')
  @HttpCode(200)
  async acknowledge(
    @Param('id') sessionId: string,
    @Body() dto: AcknowledgeDto,
    @Req() req: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.hitlService.acknowledge(
      sessionId,
      req.user.tenant_id,
      req.user.user_id,
      dto.note,
      idempotencyKey,
    );
  }
}
