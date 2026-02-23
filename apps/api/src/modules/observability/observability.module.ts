import { Module, Global } from '@nestjs/common';
import { ObservabilityService } from './observability.service';
import { MetricsController } from './metrics.controller';

/**
 * ObservabilityModule provides metrics collection and tracing.
 *
 * Current implementation uses a lightweight in-memory shim for metrics
 * and span tracking. To enable full OpenTelemetry instrumentation:
 *
 * 1. Install packages:
 *    pnpm --filter @browser-hitl/api add \
 *      @opentelemetry/api \
 *      @opentelemetry/sdk-node \
 *      @opentelemetry/sdk-trace-node \
 *      @opentelemetry/sdk-metrics \
 *      @opentelemetry/exporter-prometheus \
 *      @opentelemetry/exporter-trace-otlp-http \
 *      @opentelemetry/instrumentation-http \
 *      @opentelemetry/instrumentation-express \
 *      @opentelemetry/instrumentation-pg
 *
 * 2. Create a tracing.ts bootstrap file that initializes the NodeSDK
 *    before NestJS starts (require it via -r flag or import at top of main.ts).
 *
 * 3. Replace the shim methods in ObservabilityService with real OTel API calls.
 *
 * Metrics exposed at GET /metrics in Prometheus text format:
 * - session_ttff_ms: Time to first frame (histogram)
 * - hitl_latency_ms: HITL intervention latency (histogram)
 * - hitl_interventions_total: Total HITL interventions (counter)
 * - sessions_active: Currently active sessions (gauge)
 * - sessions_started_total: Total sessions started (counter)
 * - sessions_completed_total: Total sessions completed (counter)
 * - sessions_failed_total: Total sessions failed (counter)
 * - state_machine_transition_ms: State transition duration (histogram)
 * - artifact_extraction_ms: Artifact extraction duration (histogram)
 * - login_dsl_step_ms: Login DSL step duration (histogram)
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [ObservabilityService],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}
