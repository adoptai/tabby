import express, { Express } from 'express';
import { Server } from 'http';
import type { Page } from 'playwright';
import { registerExecuteHandler } from './execute-handler';

/**
 * Worker Health HTTP Server per spec section 15.5.
 * GET /health - Kubernetes liveness/readiness probe
 * GET /status - Session state details for observability
 * POST /execute/fetch - Run fetch() inside the browser (registered via setPage)
 */
export class HealthServer {
  private server: Server | null = null;
  private app: Express | null = null;
  private healthy = true;

  constructor(private readonly sessionId: string) {}

  /**
   * Register the Playwright page for execute endpoints.
   * Call after the browser page is created. The execute route is added
   * to the already-running Express app.
   */
  setPage(page: Page): void {
    if (this.app) {
      registerExecuteHandler(this.app, page);
      console.log('Execute handler registered on /execute/fetch');
    }
  }

  start(port: number): void {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
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
