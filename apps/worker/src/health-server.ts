import express from 'express';
import { Server } from 'http';

/**
 * Worker Health HTTP Server per spec section 15.5.
 * GET /health - Kubernetes liveness/readiness probe
 * GET /status - Session state details for observability
 */
export class HealthServer {
  private server: Server | null = null;
  private healthy = true;

  constructor(private readonly sessionId: string) {}

  start(port: number): void {
    const app = express();

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
