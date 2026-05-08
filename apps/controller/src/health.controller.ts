import { Controller, Get, Post, HttpCode } from '@nestjs/common';
import { testSentry } from '@browser-hitl/shared';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', service: 'session-controller' };
  }

  @Post('health/sentry-test')
  @HttpCode(200)
  sentryTest(): { sent: boolean; service: string } {
    return { sent: testSentry('controller'), service: 'controller' };
  }
}
