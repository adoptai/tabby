import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/**
 * Guard for the /metrics endpoint.
 *
 * If METRICS_AUTH_TOKEN is set, requires `Authorization: Bearer <token>`.
 * If not set, the endpoint is open (suitable for local dev where
 * Prometheus scrapes localhost).
 *
 * Production: set METRICS_AUTH_TOKEN to a strong random value and configure
 * Prometheus with `bearer_token` or `bearer_token_file` in scrape config.
 */
@Injectable()
export class MetricsAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expectedToken = (process.env.METRICS_AUTH_TOKEN || '').trim();
    if (!expectedToken) {
      return true; // No token configured — open access (local dev)
    }

    const req = context.switchToHttp().getRequest();
    const authHeader = req.headers?.authorization || '';
    const parts = authHeader.split(' ');

    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const actualToken = parts[1];
    if (!this.constantTimeEqual(actualToken, expectedToken)) {
      throw new UnauthorizedException('Invalid metrics auth token');
    }

    return true;
  }

  private constantTimeEqual(actual: string, expected: string): boolean {
    const actualBuf = Buffer.from(actual);
    const expectedBuf = Buffer.from(expected);
    if (actualBuf.length !== expectedBuf.length) {
      return false;
    }
    return timingSafeEqual(actualBuf, expectedBuf);
  }
}
