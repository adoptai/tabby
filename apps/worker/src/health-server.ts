import express, { Express } from 'express';
import helmet from 'helmet';
import { Server } from 'http';
import { testSentry } from '@browser-hitl/shared';
import type { Page } from 'playwright';
import { registerExecuteHandler } from './execute-handler';
import { registerBrowserHandler, cleanupHarListeners } from './execute-browser-handler';
import { executeAuthMiddleware } from './execute-auth';

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

  constructor(private readonly sessionId: string) {}

  /**
   * Register the Playwright page for execute endpoints.
   * Call after the browser page is created. The execute route is added
   * to the already-running Express app.
   */
  setPage(page: Page): void {
    this.page = page;
    if (this.app && process.env.EXECUTE_ENABLED === 'true') {
      this.app.use('/execute', executeAuthMiddleware);
      registerExecuteHandler(this.app, page);
      registerBrowserHandler(this.app, page);
      console.log('Execute handlers registered on /execute/fetch and /execute/browser');
    }
  }

  cleanupBeforeShutdown(): void {
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
}
