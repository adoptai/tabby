import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionEntity } from '../../entities';
import { RedisHealthMonitor } from '../redis/redis-health-monitor';

/**
 * Health check endpoints (H1 remediation + ADR-011 Redis resilience).
 *
 * /health/live  — Liveness: is the process up?
 * /health/ready — Readiness: can the process serve traffic? (checks DB + Redis)
 *
 * Per ADR-011 amendment RT-02: health endpoints MUST bypass emergency mode.
 * Per ADR-011 amendment RT-03: readiness returns 200 with degraded status, never 503.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    private readonly redisHealth: RedisHealthMonitor,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe', description: 'Returns chart version and commit SHA. No auth required. Used by K8s liveness probe.' })
  @ApiResponse({ status: 200, description: 'Service is alive', schema: { example: { status: 'ok', version: '0.1.7', commit: '0676ad0' } } })
  liveness(): { status: string; version: string; commit: string } {
    return {
      status: 'ok',
      version: process.env.CHART_VERSION || 'unknown',
      commit: process.env.COMMIT_SHA || 'unknown',
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe', description: 'Checks database and Redis connectivity. Returns degraded (not 503) if a dependency is down. No auth required.' })
  @ApiResponse({ status: 200, description: 'Readiness status', schema: { example: { status: 'ok', checks: { database: 'ok', redis: 'ok' } } } })
  async readiness(): Promise<{ status: string; checks: Record<string, string> }> {
    const checks: Record<string, string> = {};

    // Database check
    try {
      await this.sessionRepo.query('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'fail';
    }

    // Redis check (ADR-011)
    const redisState = this.redisHealth.getState();
    checks.redis = redisState === 'HEALTHY' ? 'ok'
                 : redisState === 'DEGRADED' ? 'degraded'
                 : 'down';

    const allOk = Object.values(checks).every((v) => v === 'ok');
    return {
      status: allOk ? 'ok' : 'degraded',
      checks,
    };
  }

}
