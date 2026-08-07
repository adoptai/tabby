import { Page, BrowserContext } from 'playwright';
import { REDIS_KEYS, REDIS_TTL } from '@browser-hitl/shared';
import Redis from 'ioredis';
import { LoginDslRunner } from './login-dsl-runner';
import { HealthPredicateRunner } from './health-predicate-runner';
import { ArtifactExtractor } from './artifact-extractor';
import { SessionDb } from './session-db';
import { isAgentBusy, msSinceAgentActivity } from './agent-activity';

// A cycle skipped because an agent command was in flight is retried on the next
// tick, but health must not go stale forever behind a continuously busy agent.
// After this many consecutive skips the cycle runs its health checks anyway
// (still without actions).
const MAX_CONSECUTIVE_BUSY_SKIPS = 3;

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
  private consecutiveBusySkips = 0;

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
      // Step 0: Stay out of an agent's way. If a browser command is in flight,
      // skip the whole cycle — not just the actions. Health checks read the live
      // page (dom_check resolves a locator, and returns AUTH_FAIL when it cannot
      // find it) so evaluating mid-navigation reports a signed-in session as
      // signed out, which drives it to LOGIN_NEEDED and shows the human a
      // sign-in card in the middle of a working task. The agent's own traffic is
      // keeping the session alive meanwhile, so there is nothing to lose by
      // waiting for the next tick.
      if (isAgentBusy() && this.consecutiveBusySkips < MAX_CONSECUTIVE_BUSY_SKIPS) {
        this.consecutiveBusySkips += 1;
        console.log(
          `Keepalive: agent command in flight, skipping cycle ` +
            `(${this.consecutiveBusySkips}/${MAX_CONSECUTIVE_BUSY_SKIPS})`,
        );
        return;
      }
      this.consecutiveBusySkips = 0;

      await this.refreshConfig();

      // Step 1: Execute keepalive actions (suppressed in recording mode).
      let actions = this.recordingMode ? [] : (this.appConfig.keepalive_config?.actions || []);

      // Agent-driven gate: if the agent touched the origin within the last
      // keepalive interval, every action here is redundant — its clicks and
      // navigations already reset the portal's idle timer, which is the only
      // thing keepalive exists to do. Running anyway is actively harmful: a
      // synthetic scroll/mouse-move can move an element between the agent's
      // locator resolution and its click, and a 'goto' reloads the page out from
      // under a half-finished flow. Robotic input interleaved with real
      // interaction also reads worse to reCAPTCHA v3 than either alone.
      // Read-only commands (screenshot, get_page_summary) deliberately do not
      // count as activity — they make no request, so the idle timer keeps
      // running and the nudge is still needed.
      const intervalMs = (this.appConfig.keepalive_config?.interval_seconds || 300) * 1000;
      const agentIdleMs = msSinceAgentActivity();
      if (actions.length > 0 && agentIdleMs < intervalMs) {
        console.log(
          `Keepalive: skipping ${actions.length} action(s) — agent active ` +
            `${Math.round(agentIdleMs / 1000)}s ago (interval ${Math.round(intervalMs / 1000)}s)`,
        );
        actions = [];
      }
      // HEALTHY-gate the 'activity' nudge: if the previous cycle found the
      // session NOT healthy (it has likely bounced to the app's login/expired
      // page), skip the trusted mouse-move + scroll — robotic input on a page
      // reCAPTCHA v3 / a fingerprint SDK is scoring reads as a bot and tanks the
      // score before the human can re-login. Non-interactive actions (e.g. goto
      // for header capture) are unaffected, and health checks below still run.
      // AUTH_FAIL only, NOT any non-PASS. TRANSIENT_FAIL is a 5xx / probe
      // timeout / egress blip — the session is still signed in, so suppressing
      // the nudge there lets the portal's own idle timer run out and converts a
      // recoverable blip into a real expiry, the exact outcome 'activity' exists
      // to prevent. The bot-scoring rationale only applies to a login page.
      if (this.lastHealthOverall === 'AUTH_FAIL') {
        const before = actions.length;
        actions = actions.filter((a: { action?: string }) => a.action !== 'activity');
        if (actions.length < before) {
          console.log(`Keepalive: skipping 'activity' nudge (last health AUTH_FAIL, likely on login page)`);
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
    // Also hold off while an agent command is in flight: extraction navigates
    // the page when export_policy.extract_urls is configured, which would yank
    // the agent off whatever it was working on. The request stays in Redis and
    // is picked up by the next 2s poll.
    if (!this.redis || this.extracting || this.running || isAgentBusy()) return;

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
