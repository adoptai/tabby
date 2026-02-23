import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ObservabilityService } from './observability.service';
import { MetricsAuthGuard } from '../../common/guards/metrics-auth.guard';
import { UserThrottlerGuard } from '../../common/guards/user-throttler.guard';

@ApiTags('Metrics')
@Controller('metrics')
@UseGuards(MetricsAuthGuard, UserThrottlerGuard)
export class MetricsController {
  constructor(private readonly observability: ObservabilityService) {}

  /**
   * GET /metrics
   * Prometheus-compatible metrics endpoint.
   * Protected by METRICS_AUTH_TOKEN (when configured) and rate-limited.
   */
  @Get()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    return this.observability.getPrometheusMetrics();
  }
}
