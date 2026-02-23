import * as fs from 'fs';
import * as path from 'path';

/**
 * Adversarial tests for Phase 4 reliability remediations.
 */

describe('Health Endpoints (H1)', () => {
  it('health.controller.ts has /health/live endpoint', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'health.controller.ts'),
      'utf-8',
    );
    expect(source).toContain("@Get('live')");
    expect(source).toContain("status: 'ok'");
  });

  it('health.controller.ts has /health/ready endpoint with DB check', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'health.controller.ts'),
      'utf-8',
    );
    expect(source).toContain("@Get('ready')");
    expect(source).toContain('SELECT 1');
    expect(source).toContain('database');
  });

  it('health.module.ts is registered in app.module', () => {
    const appModule = fs.readFileSync(
      path.join(__dirname, '..', '..', 'app.module.ts'),
      'utf-8',
    );
    expect(appModule).toContain('HealthModule');
  });
});

describe('Graceful Shutdown Timeout (M2)', () => {
  it('API main.ts has shutdown timeout', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'main.ts'),
      'utf-8',
    );
    expect(source).toContain('SHUTDOWN_TIMEOUT_MS');
    expect(source).toContain('Graceful shutdown');
    expect(source).toContain('SIGTERM');
    expect(source).toContain('SIGINT');
  });

  it('Controller main.ts has shutdown timeout', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'controller', 'src', 'main.ts'),
      'utf-8',
    );
    expect(source).toContain('SHUTDOWN_TIMEOUT_MS');
    expect(source).toContain('Graceful shutdown');
  });
});

describe('EventsGateway Error Boundary (L2)', () => {
  it('events.gateway.ts has try-catch around NATS message processing', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'events', 'events.gateway.ts'),
      'utf-8',
    );
    expect(source).toContain('Error processing NATS message');
    // Verify the for-await loop body is wrapped
    expect(source).toMatch(/for await.*\{[\s\S]*?try \{[\s\S]*?catch.*\{[\s\S]*?Error processing NATS/);
  });
});

describe('Deployment Strategy (M8)', () => {
  it('api-deployment.yaml has RollingUpdate strategy', () => {
    const template = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', '..', 'charts', 'browser-hitl', 'templates', 'api-deployment.yaml'),
      'utf-8',
    );
    expect(template).toContain('RollingUpdate');
    expect(template).toContain('maxUnavailable: 0');
    expect(template).toContain('maxSurge: 1');
  });
});

describe('Health Probes (H11)', () => {
  it('api-deployment.yaml uses /health/live for liveness probe', () => {
    const template = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', '..', 'charts', 'browser-hitl', 'templates', 'api-deployment.yaml'),
      'utf-8',
    );
    expect(template).toContain('health.liveness');
  });

  it('api-deployment.yaml uses /health/ready for readiness probe', () => {
    const template = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', '..', 'charts', 'browser-hitl', 'templates', 'api-deployment.yaml'),
      'utf-8',
    );
    expect(template).toContain('health.readiness');
  });

  it('values.yaml has separate liveness and readiness paths', () => {
    const values = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', '..', 'charts', 'browser-hitl', 'values.yaml'),
      'utf-8',
    );
    expect(values).toContain('/health/live');
    expect(values).toContain('/health/ready');
  });
});
