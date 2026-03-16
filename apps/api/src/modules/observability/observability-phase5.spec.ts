import * as fs from 'fs';
import * as path from 'path';

/**
 * Phase 5: Observability remediation tests
 * - 5.1 Structured JSON logging (H10)
 * - 5.2 Real Prometheus client metrics (M4)
 * - 5.3 Alerting scaffolding (C8)
 */
describe('Phase 5: Observability', () => {
  // =========================================================================
  // 5.1 Structured JSON Logging (H10)
  // =========================================================================
  describe('5.1 Structured JSON Logger (H10)', () => {
    const loggerPath = path.resolve(__dirname, '../../common/logger/json-logger.service.ts');
    const loggerSrc = fs.readFileSync(loggerPath, 'utf-8');

    it('should implement LoggerService interface', () => {
      expect(loggerSrc).toContain('implements LoggerService');
    });

    it('should have log, error, warn, debug, verbose methods', () => {
      for (const method of ['log(', 'error(', 'warn(', 'debug(', 'verbose(']) {
        expect(loggerSrc).toContain(method);
      }
    });

    it('should output JSON when LOG_FORMAT=json', () => {
      expect(loggerSrc).toContain('JSON.stringify(entry)');
    });

    it('should include timestamp in JSON output', () => {
      expect(loggerSrc).toContain('timestamp');
      expect(loggerSrc).toContain('toISOString()');
    });

    it('should support LOG_LEVEL configuration', () => {
      expect(loggerSrc).toContain('LOG_LEVEL');
    });

    it('should be wired into main.ts bootstrap', () => {
      const mainSrc = fs.readFileSync(
        path.resolve(__dirname, '../../main.ts'),
        'utf-8',
      );
      expect(mainSrc).toContain('JsonLoggerService');
      expect(mainSrc).toContain('logger: new JsonLoggerService()');
    });
  });

  // =========================================================================
  // 5.2 Real Prometheus Client Metrics (M4)
  // =========================================================================
  describe('5.2 Real Prometheus Metrics (M4)', () => {
    const obsSrc = fs.readFileSync(
      path.resolve(__dirname, 'observability.service.ts'),
      'utf-8',
    );

    it('should import prom-client', () => {
      expect(obsSrc).toContain("import * as promClient from 'prom-client'");
    });

    it('should collect default Node.js metrics', () => {
      expect(obsSrc).toContain('collectDefaultMetrics');
    });

    it('should use real prom-client Histogram', () => {
      expect(obsSrc).toContain('new promClient.Histogram');
    });

    it('should use real prom-client Counter', () => {
      expect(obsSrc).toContain('new promClient.Counter');
    });

    it('should use real prom-client Gauge', () => {
      expect(obsSrc).toContain('new promClient.Gauge');
    });

    it('should use register.metrics() for Prometheus output', () => {
      expect(obsSrc).toContain('promClient.register.metrics()');
    });

    it('should NOT contain in-memory shim code', () => {
      expect(obsSrc).not.toContain('private readonly histograms = new Map');
      expect(obsSrc).not.toContain('private readonly counters = new Map<string, number>');
      expect(obsSrc).not.toContain('lightweight shim');
    });

    it('should use underscore metric names (Prometheus convention)', () => {
      expect(obsSrc).toContain("'session_ttff_ms'");
      expect(obsSrc).toContain("'hitl_latency_ms'");
      expect(obsSrc).toContain("'sessions_active'");
      expect(obsSrc).toContain("'sessions_started_total'");
    });

    it('should have prom-client as dependency', () => {
      const pkgJson = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf-8'),
      );
      expect(pkgJson.dependencies['prom-client']).toBeDefined();
    });

    it('should have async getPrometheusMetrics', () => {
      expect(obsSrc).toContain('async getPrometheusMetrics(): Promise<string>');
    });

    it('callers should use underscore notation', () => {
      const gatewayPath = path.resolve(__dirname, '../events/events.gateway.ts');
      const gatewaySrc = fs.readFileSync(gatewayPath, 'utf-8');
      // Should NOT have any dot-notation metric names
      expect(gatewaySrc).not.toMatch(/incrementCounter\('hitl\./);
      expect(gatewaySrc).not.toMatch(/recordHistogram\('hitl\./);
      // Should have underscore notation
      expect(gatewaySrc).toContain("'hitl_intervention_requested_total'");
      expect(gatewaySrc).toContain("'hitl_intervention_completed_total'");
    });
  });

  // =========================================================================
  // 5.3 Alerting Scaffolding (C8)
  // =========================================================================
  describe('5.3 Alerting Scaffolding (C8)', () => {
    // Navigate from apps/api/src/modules/observability → project root → charts
    const chartsDir = path.resolve(__dirname, '../../../../../charts/browser-hitl');

    it('should have PrometheusRule template', () => {
      const rulePath = path.join(chartsDir, 'templates/prometheus-rules.yaml');
      expect(fs.existsSync(rulePath)).toBe(true);

      const ruleSrc = fs.readFileSync(rulePath, 'utf-8');
      expect(ruleSrc).toContain('kind: PrometheusRule');
      expect(ruleSrc).toContain('monitoring.coreos.com/v1');
    });

    it('should define session failure rate alert', () => {
      const ruleSrc = fs.readFileSync(
        path.join(chartsDir, 'templates/prometheus-rules.yaml'),
        'utf-8',
      );
      expect(ruleSrc).toContain('HighSessionFailureRate');
      expect(ruleSrc).toContain('sessions_failed_total');
    });

    it('should define HITL latency alert', () => {
      const ruleSrc = fs.readFileSync(
        path.join(chartsDir, 'templates/prometheus-rules.yaml'),
        'utf-8',
      );
      expect(ruleSrc).toContain('HitlLatencyHigh');
      expect(ruleSrc).toContain('hitl_latency_ms');
    });

    it('should define HITL timeout rate alert', () => {
      const ruleSrc = fs.readFileSync(
        path.join(chartsDir, 'templates/prometheus-rules.yaml'),
        'utf-8',
      );
      expect(ruleSrc).toContain('HitlTimeoutRate');
      expect(ruleSrc).toContain('hitl_intervention_timeout_total');
    });

    it('should define pod readiness alert', () => {
      const ruleSrc = fs.readFileSync(
        path.join(chartsDir, 'templates/prometheus-rules.yaml'),
        'utf-8',
      );
      expect(ruleSrc).toContain('ApiPodNotReady');
    });

    it('should be gated by alerting.enabled', () => {
      const ruleSrc = fs.readFileSync(
        path.join(chartsDir, 'templates/prometheus-rules.yaml'),
        'utf-8',
      );
      expect(ruleSrc).toContain('.Values.alerting.enabled');
    });

    it('should have alerting config in values.yaml', () => {
      const valuesSrc = fs.readFileSync(
        path.join(chartsDir, 'values.yaml'),
        'utf-8',
      );
      expect(valuesSrc).toContain('alerting:');
      expect(valuesSrc).toContain('enabled: false');
      expect(valuesSrc).toContain('sessionFailureRate');
      expect(valuesSrc).toContain('hitlLatencyP95Ms');
      expect(valuesSrc).toContain('hitlTimeoutRate');
    });

    it('should have alerting configuration in default values', () => {
      const valuesSrc = fs.readFileSync(
        path.join(chartsDir, 'values.yaml'),
        'utf-8',
      );
      expect(valuesSrc).toContain('alerting:');
    });
  });
});
