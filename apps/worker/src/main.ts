import { initSentry } from '@browser-hitl/shared';
initSentry('worker');

import * as Sentry from '@sentry/node';
import { chromium, Browser, BrowserContext, Page, LaunchOptions } from 'playwright';
import { CHROMIUM_FLAGS, CDP_PORTS, PORTS } from '@browser-hitl/shared';
import { HealthServer } from './health-server';
import { LoginDslRunner } from './login-dsl-runner';
import { KeepaliveRunner } from './keepalive-runner';
import { HealthPredicateRunner } from './health-predicate-runner';
import { ArtifactExtractor } from './artifact-extractor';
import { InputRelay } from './input-relay';
import { SessionDb } from './session-db';
import { RecyclingMonitor } from './recycling-monitor';
import { ScreenshotFallback } from './screenshot-fallback';
import { resolveCredentials } from './credential-resolver';
import { RecordingRunner } from './recording-runner';
import type { RecordingMode } from '@browser-hitl/shared';

/**
 * Browser Worker Main Entry Point
 * Per spec section 15.5, startup sequence:
 * 1. (Xvfb and x11vnc started by entrypoint script)
 * 2. Start Playwright with Chromium in headed mode
 * 3. Start worker HTTP health server on :8091
 * 4. Begin login DSL execution
 * 5. Enter keepalive loop
 */
async function main() {
  const sessionId = process.env.SESSION_ID;
  const appId = process.env.APP_ID;
  const tenantId = process.env.TENANT_ID;

  if (!sessionId || !appId || !tenantId) {
    console.error('SESSION_ID, APP_ID, and TENANT_ID are required');
    process.exit(1);
  }

  console.log(`Worker starting: session=${sessionId}, app=${appId}, tenant=${tenantId}`);

  // Initialize database connection
  const db = new SessionDb();
  await db.connect();

  // Load application config from the database
  const appConfig = await db.loadAppConfig(appId);
  if (!appConfig) {
    console.error(`Application ${appId} not found`);
    process.exit(1);
  }

  // Start health HTTP server
  const healthServer = new HealthServer(sessionId);
  healthServer.start(PORTS.WORKER_HEALTH);

  const streamingMode = (process.env.STREAMING_MODE || 'vnc').trim().toLowerCase();
  console.log(`Streaming mode: ${streamingMode}`);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let keepaliveRunner: KeepaliveRunner | null = null;
  let recyclingMonitor: RecyclingMonitor | null = null;
  let screenshotFallback: ScreenshotFallback | null = null;
  let cdpRelay: { stop(): void } | null = null;
  let recordingRunner: RecordingRunner | null = null;

  // Install shutdown handler once so both success and failure paths are covered.
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down');
    keepaliveRunner?.stop();
    recyclingMonitor?.stop();
    screenshotFallback?.stop();
    cdpRelay?.stop();
    recordingRunner?.detach();
    healthServer.cleanupBeforeShutdown();
    if (context) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
    await db.disconnect();
    healthServer.stop();
    process.exit(0);
  });

  try {
    // Launch browser
    const browserArgs = [...CHROMIUM_FLAGS] as string[];
    if (streamingMode !== 'cdp') {
      // VNC mode: size the headed browser window to fill the Xvfb framebuffer
      // (1440x900) so the viewer shows the full window, not a small default
      // window in a black canvas.
      browserArgs.push('--window-position=0,0', '--window-size=1440,900', '--start-maximized');
    }
    const launchOptions: LaunchOptions = {
      headless: streamingMode === 'cdp', // CDP: headless; VNC: renders in Xvfb display
      args: browserArgs,
    };
    const egressProxyUrl = (process.env.EGRESS_PROXY_URL || '').trim();
    const proxyBypassList = (process.env.EGRESS_PROXY_BYPASS_LIST || '').trim();
    if (egressProxyUrl) {
      try {
        const parsedProxy = new URL(egressProxyUrl);
        const proxyConfig: NonNullable<LaunchOptions['proxy']> = {
          server: `${parsedProxy.protocol}//${parsedProxy.host}`,
        };
        if (parsedProxy.username) {
          proxyConfig.username = decodeURIComponent(parsedProxy.username);
        }
        if (parsedProxy.password) {
          proxyConfig.password = decodeURIComponent(parsedProxy.password);
        }
        if (proxyBypassList) {
          proxyConfig.bypass = proxyBypassList;
        }
        launchOptions.proxy = proxyConfig;
      } catch {
        browserArgs.push(`--proxy-server=${egressProxyUrl}`);
        if (proxyBypassList) {
          browserArgs.push(`--proxy-bypass-list=${proxyBypassList}`);
        }
      }
    }
    // Try CloakBrowser (stealth Chromium) first, fall back to stock Playwright.
    // CloakBrowser is ESM-only ("exports" only has "import", no "require").
    // TypeScript "module":"commonjs" transpiles `await import()` into require(),
    // which fails with ERR_PACKAGE_PATH_NOT_EXPORTED. We hide the import() from
    // the transpiler using Function() so Node executes a real ESM dynamic import.
    try {
      const esmImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;
      const { launch: cloakLaunch } = await esmImport('cloakbrowser');
      browser = await cloakLaunch(launchOptions) as Browser;
      console.log('Browser launched via CloakBrowser (stealth mode)');
    } catch (cloakErr) {
      console.warn(`CloakBrowser unavailable, falling back to stock Playwright: ${cloakErr}`);
      browser = await chromium.launch(launchOptions);
    }

    context = await browser.newContext({
      // VNC: null viewport => the page fills the actual browser window (which we
      // sized to the Xvfb display), so the human sees a full, properly-sized
      // page. CDP/headless keeps a fixed 1920x1080 viewport.
      viewport: streamingMode === 'cdp' ? { width: 1920, height: 1080 } : null,
    });

    // Disable downloads, clipboard, file chooser per browser_policy
    const browserPolicy = appConfig.browser_policy || { downloads: false, clipboard: false, file_chooser: false };
    const recordingMode = (browserPolicy as { recording_mode?: RecordingMode }).recording_mode;
    if (!browserPolicy.downloads) {
      // Playwright doesn't have a direct "disable downloads" API,
      // but we intercept and cancel download events
      context.on('page', (page) => {
        page.on('download', (download) => download.cancel());
      });
    }
    if (!browserPolicy.file_chooser) {
      const blockFileChooser = (activePage: Page) => {
        activePage.on('filechooser', async (fileChooser) => {
          try {
            await fileChooser.setFiles([]);
          } catch {
            // Best effort: block file chooser uploads by policy.
          }
        });
      };
      context.on('page', blockFileChooser);
      context.pages().forEach(blockFileChooser);
    }
    if (!browserPolicy.clipboard) {
      await context.addInitScript(() => {
        const blocked = async () => {
          throw new Error('Clipboard access disabled by browser policy');
        };
        const clipboardShim = {
          writeText: blocked,
          readText: blocked,
          write: blocked,
          read: blocked,
        };
        try {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: false,
            enumerable: true,
            value: clipboardShim,
          });
        } catch {
          // Non-fatal in environments that disallow overriding navigator.clipboard.
        }
      });
    }

    const page = await context.newPage();

    // Recording sessions are human-VNC-only — disable execute before wiring the
    // page so /execute/* returns 409 instead of registering handlers.
    healthServer.setRecordingMode(Boolean(recordingMode));

    // Register execute endpoint on the health server
    healthServer.setPage(page);

    // Start CDP relay server if in CDP mode
    if (streamingMode === 'cdp') {
      const { CdpRelayServer } = await import('./cdp-relay-server');
      const relay = new CdpRelayServer();
      await relay.start(CDP_PORTS.CDP_RELAY);
      cdpRelay = relay;
    }

    // Initialize components
    const inputRelay = new InputRelay(sessionId);
    const allowDslEvaluate = ((appConfig.browser_policy as Record<string, unknown> | undefined)?.allow_evaluate === true)
      || (process.env.DSL_ALLOW_EVALUATE || '').trim().toLowerCase() === 'true';
    const dslRunner = new LoginDslRunner(
      page,
      context,
      inputRelay,
      sessionId,
      tenantId,
      appId,
      {
        allowEvaluate: allowDslEvaluate,
        // Signal controller that human input is needed.
        onInputRequested: async (request) => {
          console.log(`[HITL] onInputRequested called: sessionId=${sessionId}, request=${JSON.stringify(request)}`);
          await db.writePendingInputRequest(sessionId, request as unknown as Record<string, unknown>);
          console.log(`[HITL] writePendingInputRequest done for sessionId=${sessionId}`);
          await db.updateHealthResult(sessionId, 'AUTH_FAIL');
        },
      },
    );
    const healthRunner = new HealthPredicateRunner(page, context, appConfig.keepalive_config);
    const artifactExtractor = new ArtifactExtractor(page, context, appConfig, tenantId, sessionId, appId, db);
    // Resolve credentials from K8s Secret
    const credentials = await resolveCredentials(appConfig.login_config.credential_ref);
    keepaliveRunner = new KeepaliveRunner(
      page, context, dslRunner, healthRunner, artifactExtractor, db, appConfig, appId, sessionId, credentials,
      Boolean(recordingMode),
    );

    if (recordingMode) {
      // VNC recording session: a human drives the browser while the worker
      // passively captures HAR + DOM interaction + URL events. No login DSL,
      // no artifact extraction, no keepalive navigation.
      console.log(`Starting VNC recording session (mode=${recordingMode})`);
      recordingRunner = new RecordingRunner(page, context, sessionId, recordingMode);
      await recordingRunner.start();
      healthServer.setRecordingRunner(recordingRunner);

      // Session reuse: seed cookies captured from a prior login recording so the
      // human starts already authenticated (no stored credentials). Provisioned
      // via recording-provision when `--from <login-session>` is given.
      const seedCookies = (appConfig.login_config as { seed_cookies?: unknown })?.seed_cookies;
      if (Array.isArray(seedCookies) && seedCookies.length > 0) {
        try {
          await context.addCookies(seedCookies as Parameters<typeof context.addCookies>[0]);
          console.log(`Seeded ${seedCookies.length} cookie(s) from source login recording`);
        } catch (err) {
          console.warn(`Failed to seed cookies: ${err}`);
        }
      }

      const startUrl = (
        process.env.RECORDING_START_URL || appConfig.login_config?.login_url || ''
      ).trim();
      if (startUrl && startUrl !== 'about:blank') {
        try {
          await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
        } catch (err) {
          console.warn(`Recording start navigation failed: ${err}`);
        }
      }

      await db.updateHealthResult(sessionId, 'PASS');
      console.log('Entering recording keepalive loop (actions suppressed)');
      await keepaliveRunner.start();
    } else {
      // Register header capture listeners BEFORE login (per spec section 10.8).
      // Request-header capture must also register before login so the first authenticated
      // outbound request (bearer JWT, tenant key) is not missed.
      artifactExtractor.registerHeaderCapture();
      artifactExtractor.registerRequestHeaderCapture();

      // Execute login DSL
      console.log('Starting login DSL execution');
      await db.updateLastLoginAt(sessionId);
      await dslRunner.execute(appConfig.login_config.steps, credentials);

      // Pass DSL variables (e.g., quote_id from store_as) to artifact extractor
      const dslVars = dslRunner.getVariables();
      if (dslVars.size > 0) {
        artifactExtractor.setDslVariables(dslVars);
        console.log(`DSL variables passed to extractor: ${[...dslVars.keys()].join(', ')}`);
      }

      // Run health predicate to confirm authentication
      const healthResult = await healthRunner.evaluate();
      await db.updateHealthResult(sessionId, healthResult.overall);

      if (healthResult.overall === 'PASS') {
        console.log('Login successful, extracting artifacts');
        try {
          await artifactExtractor.extractAndUpload();
        } catch (err) {
          console.error(`Initial artifact extraction failed: ${err}`);
        }
      }

      // Enter keepalive loop
      console.log('Entering keepalive loop');
      await keepaliveRunner.start();
    }

    // Start recycling monitor (FR-34)
    const maxAgeHours = parseInt(process.env.MAX_SESSION_AGE_HOURS || '24', 10);
    recyclingMonitor = new RecyclingMonitor(sessionId, maxAgeHours, 2560, async (reason) => {
      console.warn(`Recycling triggered: ${reason}`);
      // Export artifacts before signaling termination
      try {
        await artifactExtractor.extractAndUpload();
        await db.updateLastExportedAt(sessionId);
      } catch (err) {
        console.error(`Pre-recycle artifact export failed: ${err}`);
      }
      // Signal degraded status; controller handles recycle based on age/watermark checks.
      await db.updateHealthResult(sessionId, 'TRANSIENT_FAIL');
    });
    recyclingMonitor.start();

    // Initialize screenshot fallback (FR-36)
    screenshotFallback = new ScreenshotFallback(page);
  } catch (error) {
    console.error(`Worker error: ${error}`);
    Sentry.captureException(error);
    await db.updateHealthResult(sessionId, classifyWorkerError(error));
  }
}

function classifyWorkerError(error: unknown): 'AUTH_FAIL' | 'TRANSIENT_FAIL' {
  const message = String((error as any)?.message || error || '').toLowerCase();

  // Authentication/HITL-related failures that should trigger login intervention flows.
  if (
    /otp|captcha|credential|password|username|invalid login|auth fail|authentication/.test(message)
    || /dsl step .* failed/.test(message)
  ) {
    return 'AUTH_FAIL';
  }

  // Network, runtime, infra, or unknown errors should not be collapsed into auth failures.
  return 'TRANSIENT_FAIL';
}

main().catch(async (error) => {
  console.error(`Fatal error: ${error}`);
  Sentry.captureException(error);
  await Sentry.flush(2000);
  process.exit(1);
});
