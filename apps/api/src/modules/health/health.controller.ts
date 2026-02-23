import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
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
