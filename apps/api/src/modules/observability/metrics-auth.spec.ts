import { UnauthorizedException } from '@nestjs/common';
import { MetricsAuthGuard } from '../../common/guards/metrics-auth.guard';

/**
 * Adversarial tests for /metrics endpoint auth (C4 remediation).
 */

function createMockContext(authHeader?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: authHeader !== undefined ? { authorization: authHeader } : {},
        ip: '127.0.0.1',
      }),
      getResponse: () => ({}),
    }),
  } as any;
}

describe('MetricsAuthGuard (C4)', () => {
  beforeEach(() => {
    delete process.env.METRICS_AUTH_TOKEN;
  });

  afterEach(() => {
    delete process.env.METRICS_AUTH_TOKEN;
  });

  it('allows access when METRICS_AUTH_TOKEN is not set (local dev)', () => {
    const guard = new MetricsAuthGuard();
    const result = guard.canActivate(createMockContext());
    expect(result).toBe(true);
  });

  it('allows access with correct bearer token', () => {
    process.env.METRICS_AUTH_TOKEN = 'my-secret-metrics-token';
    const guard = new MetricsAuthGuard();
    const result = guard.canActivate(
      createMockContext('Bearer my-secret-metrics-token'),
    );
    expect(result).toBe(true);
  });

  it('rejects request with wrong bearer token', () => {
    process.env.METRICS_AUTH_TOKEN = 'correct-token';
    const guard = new MetricsAuthGuard();
    expect(() =>
      guard.canActivate(createMockContext('Bearer wrong-token')),
    ).toThrow(UnauthorizedException);
  });

  it('rejects request with no Authorization header when token is required', () => {
    process.env.METRICS_AUTH_TOKEN = 'required-token';
    const guard = new MetricsAuthGuard();
    expect(() =>
      guard.canActivate(createMockContext()),
    ).toThrow(UnauthorizedException);
  });

  it('rejects request with Basic auth when Bearer is expected', () => {
    process.env.METRICS_AUTH_TOKEN = 'required-token';
    const guard = new MetricsAuthGuard();
    expect(() =>
      guard.canActivate(createMockContext('Basic dXNlcjpwYXNz')),
    ).toThrow(UnauthorizedException);
  });

  it('rejects malformed Authorization header (no space)', () => {
    process.env.METRICS_AUTH_TOKEN = 'required-token';
    const guard = new MetricsAuthGuard();
    expect(() =>
      guard.canActivate(createMockContext('Bearertoken')),
    ).toThrow(UnauthorizedException);
  });

  it('uses timing-safe comparison (constant time)', () => {
    // Verify the guard source uses timingSafeEqual
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'common', 'guards', 'metrics-auth.guard.ts'),
      'utf-8',
    );
    expect(source).toContain('timingSafeEqual');
  });
});

describe('MetricsController source verification (C4)', () => {
  it('metrics.controller.ts uses MetricsAuthGuard', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'metrics.controller.ts'),
      'utf-8',
    );
    expect(source).toContain('MetricsAuthGuard');
    expect(source).toContain('UseGuards');
  });

  it('metrics.controller.ts has rate limiting', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'metrics.controller.ts'),
      'utf-8',
    );
    expect(source).toContain('Throttle');
    expect(source).toContain('UserThrottlerGuard');
  });
});
