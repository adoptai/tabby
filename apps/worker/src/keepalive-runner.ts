import { Page, BrowserContext } from 'playwright';
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
  private running = false;

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
  ) {}

  async start(): Promise<void> {
    const intervalSeconds = this.appConfig.keepalive_config?.interval_seconds || 300;

    // Run first cycle immediately
    await this.runCycle();

    // Schedule subsequent cycles
    this.timer = setInterval(async () => {
      if (!this.running) {
        await this.runCycle();
      }
    }, intervalSeconds * 1000);

    console.log(`Keepalive loop started: interval=${intervalSeconds}s`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runCycle(): Promise<void> {
    this.running = true;

    try {
      await this.refreshConfig();

      // Step 1: Execute keepalive actions
      const actions = this.appConfig.keepalive_config?.actions || [];
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
      await this.db.updateHealthResult(this.sessionId, healthResult.overall);

      console.log(`Health check: ${healthResult.overall} (${healthResult.checks.length} checks)`);

      // Step 5: Re-extract artifacts if health passes and stale
      if (healthResult.overall === 'PASS') {
        const refreshInterval = this.appConfig.export_policy?.refresh_interval_seconds || 3600;
        const lastExported = await this.db.getLastExportedAt(this.sessionId);

        if (!lastExported || (Date.now() - new Date(lastExported).getTime()) > refreshInterval * 1000) {
          try {
            await this.artifactExtractor.extractAndUpload();
            await this.db.updateLastExportedAt(this.sessionId);
          } catch (error) {
            // Per spec: extraction failure doesn't change HEALTHY state
            console.error(`Artifact extraction failed: ${error}`);
          }
        }
      }
    } catch (error) {
      console.error(`Keepalive cycle error: ${error}`);
    } finally {
      this.running = false;
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
