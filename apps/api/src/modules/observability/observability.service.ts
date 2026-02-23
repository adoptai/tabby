import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as promClient from 'prom-client';

/**
 * ObservabilityService — real Prometheus metrics via prom-client.
 *
 * All metrics are registered in the default prom-client registry.
 * The /metrics endpoint (MetricsController) returns the output from
 * `promClient.register.metrics()`.
 *
 * Metric naming follows Prometheus conventions:
 *   - Counters: snake_case + _total suffix
 *   - Histograms: snake_case (auto-generates _bucket, _sum, _count)
 *   - Gauges: snake_case
 */
@Injectable()
export class ObservabilityService implements OnModuleInit {
  private readonly logger = new Logger(ObservabilityService.name);

  /** prom-client metric objects */
  private readonly histogramMap = new Map<string, promClient.Histogram>();
  private readonly counterMap = new Map<string, promClient.Counter>();
  private readonly gaugeMap = new Map<string, promClient.Gauge>();

  onModuleInit(): void {
    // Collect default Node.js metrics (GC, event loop, memory, etc.)
    promClient.collectDefaultMetrics({ prefix: 'browser_hitl_' });

    // Initialize well-known application metrics
    this.initHistogram('session_ttff_ms', 'Time to first frame (ms)');
    this.initHistogram('hitl_latency_ms', 'HITL intervention latency (ms)');
    this.initHistogram('state_machine_transition_ms', 'State machine transition duration (ms)');
    this.initHistogram('artifact_extraction_ms', 'Artifact extraction duration (ms)');
    this.initHistogram('login_dsl_step_ms', 'Login DSL step duration (ms)');
    this.initHistogram('hitl_request_to_resolution_ms', 'OTP requested to resolved (ms)');

    this.initCounter('hitl_interventions_total', 'Total HITL interventions');
    this.initCounter('hitl_intervention_requested_total', 'Total HITL interventions requested');
    this.initCounter('hitl_otp_submitted_total', 'Total OTP submissions');
    this.initCounter('hitl_intervention_completed_total', 'Total HITL interventions completed');
    this.initCounter('hitl_intervention_success_total', 'Total HITL intervention successes');
    this.initCounter('hitl_intervention_timeout_total', 'Total HITL intervention timeouts');
    this.initCounter('hitl_intervention_failed_total', 'Total HITL intervention failures');
    this.initCounter('hitl_resumed_total', 'Total HITL sessions resumed');
    this.initCounter('hitl_failed_total', 'Total HITL failures');
    this.initCounter('sessions_started_total', 'Total sessions started');
    this.initCounter('sessions_completed_total', 'Total sessions completed');
    this.initCounter('sessions_failed_total', 'Total sessions failed');

    this.initGauge('sessions_active', 'Currently active sessions');

    this.logger.log('Observability service initialized (prom-client mode)');
  }

  // --- Histogram operations ---

  private initHistogram(name: string, help: string): void {
    const h = new promClient.Histogram({ name, help, buckets: promClient.exponentialBuckets(10, 2, 12) });
    this.histogramMap.set(name, h);
  }

  recordHistogram(name: string, value: number): void {
    const h = this.histogramMap.get(name);
    if (h) {
      h.observe(value);
    } else {
      this.logger.warn(`Unknown histogram: ${name}`);
    }
  }

  // --- Counter operations ---

  private initCounter(name: string, help: string): void {
    const c = new promClient.Counter({ name, help });
    this.counterMap.set(name, c);
  }

  incrementCounter(name: string, delta = 1): void {
    const c = this.counterMap.get(name);
    if (c) {
      c.inc(delta);
    } else {
      this.logger.warn(`Unknown counter: ${name}`);
    }
  }

  // --- Gauge operations ---

  private initGauge(name: string, help: string): void {
    const g = new promClient.Gauge({ name, help });
    this.gaugeMap.set(name, g);
  }

  setGauge(name: string, value: number): void {
    const g = this.gaugeMap.get(name);
    if (g) {
      g.set(value);
    } else {
      this.logger.warn(`Unknown gauge: ${name}`);
    }
  }

  incrementGauge(name: string, delta = 1): void {
    const g = this.gaugeMap.get(name);
    if (g) {
      g.inc(delta);
    } else {
      this.logger.warn(`Unknown gauge: ${name}`);
    }
  }

  decrementGauge(name: string, delta = 1): void {
    const g = this.gaugeMap.get(name);
    if (g) {
      g.dec(delta);
    } else {
      this.logger.warn(`Unknown gauge: ${name}`);
    }
  }

  // --- Convenience methods for well-known metrics ---

  recordTTFF(ms: number): void {
    this.recordHistogram('session_ttff_ms', ms);
  }

  recordHitlLatency(ms: number): void {
    this.recordHistogram('hitl_latency_ms', ms);
    this.incrementCounter('hitl_interventions_total');
  }

  recordStateTransition(ms: number): void {
    this.recordHistogram('state_machine_transition_ms', ms);
  }

  recordArtifactExtraction(ms: number): void {
    this.recordHistogram('artifact_extraction_ms', ms);
  }

  recordLoginDslStep(ms: number): void {
    this.recordHistogram('login_dsl_step_ms', ms);
  }

  sessionStarted(): void {
    this.incrementCounter('sessions_started_total');
    this.incrementGauge('sessions_active');
  }

  sessionCompleted(): void {
    this.incrementCounter('sessions_completed_total');
    this.decrementGauge('sessions_active');
  }

  sessionFailed(): void {
    this.incrementCounter('sessions_failed_total');
    this.decrementGauge('sessions_active');
  }

  // --- Span helpers (stubs until OpenTelemetry is installed) ---

  startSpan(name: string, attributes?: Record<string, string | number>): SpanHandle {
    const startTime = Date.now();
    this.logger.debug(`[span:start] ${name}`, attributes);
    return {
      end: () => {
        const duration = Date.now() - startTime;
        this.logger.debug(`[span:end] ${name} (${duration}ms)`);
      },
      setAttribute: (key: string, value: string | number) => {
        this.logger.debug(`[span:attr] ${name} ${key}=${value}`);
      },
      setStatus: (status: 'ok' | 'error', message?: string) => {
        this.logger.debug(`[span:status] ${name} ${status} ${message || ''}`);
      },
    };
  }

  // --- Prometheus-compatible text output ---

  async getPrometheusMetrics(): Promise<string> {
    return promClient.register.metrics();
  }
}

export interface SpanHandle {
  end(): void;
  setAttribute(key: string, value: string | number): void;
  setStatus(status: 'ok' | 'error', message?: string): void;
}
