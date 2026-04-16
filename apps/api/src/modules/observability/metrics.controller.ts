import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ObservabilityService } from './observability.service';
import { MetricsAuthGuard } from '../../common/guards/metrics-auth.guard';
import { UserThrottlerGuard } from '../../common/guards/user-throttler.guard';

@ApiTags('Metrics')
@ApiBearerAuth()
@Controller('metrics')
@UseGuards(MetricsAuthGuard, UserThrottlerGuard)
export class MetricsController {
  constructor(private readonly observability: ObservabilityService) {}

  /**
   * GET /metrics
   * Prometheus-compatible metrics endpoint.
   * Protected by METRICS_AUTH_TOKEN (when configured) and rate-limited.
   */
  @ApiOperation({ summary: 'Prometheus metrics', description: 'Returns Prometheus-compatible metrics. Protected by METRICS_AUTH_TOKEN bearer token. Rate limited to 10/min.' })
  @ApiResponse({ status: 200, description: 'Prometheus text format metrics' })
  @ApiResponse({ status: 401, description: 'Invalid or missing METRICS_AUTH_TOKEN' })
  @Get()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    return this.observability.getPrometheusMetrics();
  }
}
