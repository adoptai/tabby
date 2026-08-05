import { Page, BrowserContext } from 'playwright';
import { REDIS_KEYS, REDIS_TTL } from '@browser-hitl/shared';
import Redis from 'ioredis';
import { LoginDslRunner } from './login-dsl-runner';
import { HealthPredicateRunner } from './health-predicate-runner';
import { ArtifactExtractor } from './artifact-extractor';
import { SessionDb } from './session-db';

/**
 * Keepalive Runner per spec section 9.9.
 *
 * Execution order per keepalive cycle:
 * 1. Execute keepalive actions (reload, click, etc.) sequentially
 * 2. Wait 2 seconds for page to stabilize
 * 3. Execute health predicates sequentially
 * 4. Write results to sessions table
 * 5. If health passes and artifacts stale, re-extract
 */
export class KeepaliveRunner {
  private timer: NodeJS.Timeout | null = null;
  private extractPollTimer: NodeJS.Timeout | null = null;
  private running = false;
  private extracting = false;
  private redis: Redis | null = null;
  // Last health verdict, used to gate the human-simulation 'activity' nudge:
  // once a session bounces to a login/expired page (health != PASS), we must
  // stop feeding it robotic mouse/scroll input, or reCAPTCHA v3 / fingerprint
  // SDKs score the page as a bot before the human can re-login. null until the
  // first cycle's health check (session enters keepalive already logged in).
  private lastHealthOverall: string | null = null;

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly dslRunner: LoginDslRunner,
    private readonly healthRunner: HealthPredicateRunner,
    private readonly artifactExtractor: ArtifactExtractor,
    private readonly db: SessionDb,
    private appConfig: any,
    private readonly appId: string,
    private readonly sessionId: string,
    private readonly credentials: { username: string; password: string },
    // In VNC recording mode, suppress keepalive actions (reload/navigate)
    // so they cannot pollute or disrupt the human-driven recording. Health
    // checks still run to keep the session HEALTHY.
    private readonly recordingMode = false,
  ) {}

  async start(): Promise<void> {
    const intervalSeconds = this.appConfig.keepalive_config?.interval_seconds || 300;

    // Connect to Redis for on-demand extract polling
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
      this.redis.on('error', () => {});
      await this.redis.connect();
    } catch {
      console.warn('[Keepalive] Redis unavailable — on-demand extract polling disabled');
      this.redis = null;
    }

    // Run first cycle immediately
    await this.runCycle();

    // Schedule subsequent cycles
    this.timer = setInterval(async () => {
      if (!this.running) {
        await this.runCycle();
      }
    }, intervalSeconds * 1000);

    // Poll Redis every 2s for on-demand extract requests
    if (this.redis) {
      this.extractPollTimer = setInterval(() => this.checkExtractRequest(), 2000);
    }

    console.log(`Keepalive loop started: interval=${intervalSeconds}s`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.extractPollTimer) {
      clearInterval(this.extractPollTimer);
      this.extractPollTimer = null;
    }
    if (this.redis) {
      this.redis.disconnect();
      this.redis = null;
    }
  }

  private async runCycle(): Promise<void> {
    this.running = true;

    try {
      await this.refreshConfig();

      // Step 1: Execute keepalive actions (suppressed in recording mode).
      let actions = this.recordingMode ? [] : (this.appConfig.keepalive_config?.actions || []);
      // HEALTHY-gate the 'activity' nudge: if the previous cycle found the
      // session NOT healthy (it has likely bounced to the app's login/expired
      // page), skip the trusted mouse-move + scroll — robotic input on a page
      // reCAPTCHA v3 / a fingerprint SDK is scoring reads as a bot and tanks the
      // score before the human can re-login. Non-interactive actions (e.g. goto
      // for header capture) are unaffected, and health checks below still run.
      if (this.lastHealthOverall !== null && this.lastHealthOverall !== 'PASS') {
        const before = actions.length;
        actions = actions.filter((a: { action?: string }) => a.action !== 'activity');
        if (actions.length < before) {
          console.log(`Keepalive: skipping 'activity' nudge (last health ${this.lastHealthOverall}, likely on login page)`);
        }
      }
      if (actions.length > 0) {
        try {
          await this.dslRunner.execute(actions, this.credentials);
        } catch (error) {
          console.warn(`Keepalive action failed: ${error}`);
        }
      }

      // Step 2: Wait 2 seconds for page to stabilize
      await this.page.waitForTimeout(2000);

      // Step 3-4: Execute health predicates and write results
      const healthResult = await this.healthRunner.evaluate();
      // Remember the verdict so the NEXT cycle can gate the 'activity' nudge
      // (see Step 1) — a not-PASS session is likely sitting on a login page.
      this.lastHealthOverall = healthResult.overall;
      await this.db.updateHealthResult(this.sessionId, healthResult.overall);

      console.log(`Health check: ${healthResult.overall} (${healthResult.checks.length} checks)`);
      for (const cr of healthResult.checks) {
        if (cr.result !== 'PASS') {
          console.log(`  [${cr.check.type}] ${cr.result}: ${cr.detail ?? 'no detail'} (${cr.duration_ms}ms)`);
        }
      }

      // Step 5: Re-extract artifacts if health passes and stale
      if (healthResult.overall === 'PASS') {
        const refreshInterval = this.appConfig.export_policy?.refresh_interval_seconds || 3600;
        const lastExported = await this.db.getLastExportedAt(this.sessionId);
        const elapsed = lastExported ? Date.now() - new Date(lastExported).getTime() : Infinity;

        if (!lastExported || elapsed > refreshInterval * 1000) {
          try {
            await this.artifactExtractor.extractAndUpload();
            await this.db.updateLastExportedAt(this.sessionId);
          } catch (error) {
            // Per spec: extraction failure doesn't change HEALTHY state
            console.error(`Artifact extraction failed: ${error}`);
          }
        } else {
          const remaining = Math.round((refreshInterval * 1000 - elapsed) / 1000);
          console.log(`Artifacts still fresh, next extraction in ~${remaining}s (refresh_interval=${refreshInterval}s)`);
        }
      }
    } catch (error) {
      console.error(`Keepalive cycle error: ${error}`);
    } finally {
      this.running = false;
    }
  }

  private async checkExtractRequest(): Promise<void> {
    if (!this.redis || this.extracting || this.running) return;

    try {
      const key = REDIS_KEYS.extractRequest(this.sessionId);
      const value = await this.redis.get(key);
      if (!value) return;

      // Consume the request
      await this.redis.del(key);
      this.extracting = true;
      console.log('[Keepalive] On-demand extract request received, extracting now');

      try {
        await this.artifactExtractor.extractAndUpload();
        await this.db.updateLastExportedAt(this.sessionId);
        console.log('[Keepalive] On-demand extraction complete');

        // Signal any waiting API caller that fresh artifacts are ready (atomic pipeline)
        const doneKey = REDIS_KEYS.extractDone(this.sessionId);
        await this.redis!.pipeline()
          .lpush(doneKey, '1')
          .expire(doneKey, REDIS_TTL.EXTRACT_DONE_SECONDS)
          .exec();
      } catch (error) {
        console.error(`[Keepalive] On-demand extraction failed: ${error}`);
      }
    } catch (error) {
      console.warn(`[Keepalive] Extract request poll error: ${error}`);
    } finally {
      this.extracting = false;
    }
  }

  private async refreshConfig(): Promise<void> {
    try {
      const latest = await this.db.loadAppConfig(this.appId);
      if (latest) {
        this.appConfig = latest;
        this.healthRunner.setKeepaliveConfig(latest.keepalive_config);
      }
    } catch (error) {
      console.warn(`Failed to refresh app config for keepalive: ${error}`);
    }
  }
}
