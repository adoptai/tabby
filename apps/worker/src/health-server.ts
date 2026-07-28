import express, { Express } from 'express';
import helmet from 'helmet';
import { Server } from 'http';
import { testSentry } from '@browser-hitl/shared';
import type { Page } from 'playwright';
import { registerExecuteHandler } from './execute-handler';
import { registerBrowserHandler, cleanupHarListeners } from './execute-browser-handler';
import { executeAuthMiddleware } from './execute-auth';
import type { RecordingRunner } from './recording-runner';

/** Params for binding a warm pool recording pod to a real recording target. */
export interface BindParams {
  start_url: string;
  seed_cookies?: unknown[];
}

/**
 * Worker Health HTTP Server per spec section 15.5.
 * GET /health - Kubernetes liveness/readiness probe
 * GET /status - Session state details for observability
 * POST /health/sentry-test - Fire test error to Sentry
 * POST /execute/fetch - Run fetch() inside the browser (registered via setPage)
 * POST /execute/browser - Run browser commands (registered via setPage)
 */
export class HealthServer {
  private server: Server | null = null;
  private app: Express | null = null;
  private page: Page | null = null;
  private healthy = true;
  // Readiness is distinct from liveness (`healthy`). The pod's K8s readinessProbe
  // hits /ready, which stays 503 until the browser window is actually up and
  // rendering in Xvfb — i.e. until VNC/noVNC can serve a real frame. This
  // replaces the old fixed `readinessProbe.initialDelaySeconds: 15` guess with an
  // accurate signal, so the per-session noVNC Service gets endpoints the moment
  // the browser is viewable instead of ~15s later. Flipped true right after the
  // page is created (main.ts), NOT after login/DSL — a HITL login session must be
  // viewable while the human is still completing the login.
  private ready = false;
  private recordingRunner: RecordingRunner | null = null;
  private recording = false;
  private bindHandler: ((params: BindParams) => Promise<void>) | null = null;

  constructor(private readonly sessionId: string) {}

  /**
   * Mark this worker as a recording session. Must be called before setPage().
   * Disables the execute endpoints (a recording session is human-VNC-only;
   * concurrent /execute commands would corrupt the capture).
   */
  setRecordingMode(recording: boolean): void {
    this.recording = recording;
  }

  /**
   * Register the recording runner so POST /recording/stop can drain it.
   * Pod-internal route — the API is the authenticated boundary.
   */
  setRecordingRunner(runner: RecordingRunner): void {
    this.recordingRunner = runner;
  }

  /**
   * Register the warm-pool bind handler. A pool pod boots as a recording session
   * on about:blank; when a recording request claims it, the API POSTs
   * /recording/bind with the real target so the worker seeds cookies + navigates.
   */
  setBindHandler(handler: (params: BindParams) => Promise<void>): void {
    this.bindHandler = handler;
  }

  /**
   * Register the Playwright page for execute endpoints.
   * Call after the browser page is created. The execute route is added
   * to the already-running Express app.
   */
  setPage(page: Page): void {
    this.page = page;
    if (!this.app) return;
    if (this.recording) {
      // Reject any execute traffic on recording sessions (one active consumer).
      this.app.use('/execute', (_req, res) =>
        res.status(409).json({ success: false, error: 'Execute is disabled during recording sessions' }),
      );
      console.log('Recording mode: /execute/* disabled (409)');
      return;
    }
    if (process.env.EXECUTE_ENABLED === 'true') {
      this.app.use('/execute', executeAuthMiddleware);
      registerExecuteHandler(this.app, page);
      registerBrowserHandler(this.app, page);
      console.log('Execute handlers registered on /execute/fetch and /execute/browser');
    }
  }

  cleanupBeforeShutdown(): void {
    if (this.recordingRunner) {
      this.recordingRunner.detach();
    }
    if (this.page) {
      cleanupHarListeners(this.page);
    }
  }

  start(port: number): void {
    const app = express();
    app.use(helmet());
    app.use(express.json({ limit: '10mb' }));
    this.app = app;

    app.get('/health', (_req, res) => {
      if (this.healthy) {
        res.json({ status: 'ok', session_id: this.sessionId });
      } else {
        res.status(503).json({ status: 'unhealthy', session_id: this.sessionId });
      }
    });

    // Readiness probe (and startup probe) target. 503 until the browser window
    // is up and rendering in Xvfb so the noVNC Service only gets endpoints once
    // VNC can actually serve a frame. See the `ready` field comment.
    app.get('/ready', (_req, res) => {
      if (this.ready) {
        res.json({ status: 'ready', session_id: this.sessionId });
      } else {
        res.status(503).json({ status: 'starting', session_id: this.sessionId });
      }
    });

    app.get('/status', (_req, res) => {
      res.json({
        session_id: this.sessionId,
        app_id: process.env.APP_ID,
        tenant_id: process.env.TENANT_ID,
        healthy: this.healthy,
        uptime_seconds: Math.floor(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      });
    });

    app.post('/health/sentry-test', (_req, res) => {
      res.json({ sent: testSentry('worker'), service: 'worker' });
    });

    // Drain a VNC recording session. Synchronous: HAR + interaction + URL
    // events are flushed before responding (no fire-and-forget race).
    // Pod-internal only — the API authenticates the caller.
    app.post('/recording/stop', (_req, res) => {
      if (!this.recordingRunner) {
        res.status(409).json({ success: false, error: 'No active recording on this session' });
        return;
      }
      const runner = this.recordingRunner;
      this.recordingRunner = null;
      runner
        .drain()
        .then((bundle) => res.json({ success: true, bundle }))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Recording drain error: ${message}`);
          res.status(500).json({ success: false, error: message });
        });
    });

    // Bind a warm pool pod to a real recording target (seed cookies + navigate).
    // Pod-internal only — the API authenticates the caller before proxying here.
    app.post('/recording/bind', (req, res) => {
      if (!this.bindHandler) {
        res.status(409).json({ success: false, error: 'Session does not support binding' });
        return;
      }
      const body = (req.body || {}) as Partial<BindParams>;
      const startUrl = typeof body.start_url === 'string' ? body.start_url.trim() : '';
      if (!startUrl) {
        res.status(400).json({ success: false, error: 'start_url is required' });
        return;
      }
      this.bindHandler({ start_url: startUrl, seed_cookies: Array.isArray(body.seed_cookies) ? body.seed_cookies : [] })
        .then(() => res.json({ success: true }))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Recording bind error: ${message}`);
          res.status(500).json({ success: false, error: message });
        });
    });

    this.server = app.listen(port, () => {
      console.log(`Health server listening on port ${port}`);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
    }
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  /**
   * Flip the K8s readiness/startup signal. Called once the browser window is up
   * and rendering (main.ts, right after the page is created) — for every mode,
   * BEFORE login/DSL runs, so HITL login sessions are viewable while the human
   * completes the login.
   */
  setReady(ready: boolean): void {
    this.ready = ready;
  }
}
