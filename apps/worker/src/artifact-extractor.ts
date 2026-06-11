import { Page, BrowserContext, Request, Response } from 'playwright';
import { createCipheriv, randomBytes } from 'crypto';
import { StringCodec } from 'nats';
import { NATS_SUBJECTS, requireEnv, connectNats } from '@browser-hitl/shared';
import { SessionDb } from './session-db';

/**
 * Custom extraction definition for export_policy.custom_extractions.
 * Supports extracting values via JS evaluation or named cookie lookup.
 */
interface CustomExtraction {
  key: string;
  type: 'js_eval' | 'cookie';
  expression?: string;       // JS expression to evaluate in page context (for js_eval)
  cookie_name?: string;      // Cookie name to extract (for cookie type)
  extract_on_url?: string;   // Only extract when current page URL matches this glob
  description?: string;
}

/**
 * Artifact Extraction Pipeline per spec sections 9.8, 10.8.
 *
 * Extracts: cookies, headers, csrf_token, local_storage, session_storage, custom (js_eval).
 * Encrypts with AES-256-GCM per-tenant key.
 * Uploads encrypted blob to MinIO.
 * Publishes export metadata to NATS.
 */
/**
 * Max number of distinct URLs tracked per capture direction.
 * Prevents unbounded growth on SPA-heavy sessions that fire thousands of XHRs.
 */
const HEADER_CAPTURE_URL_CAP = 500;

export class ArtifactExtractor {
  private capturedResponseHeaders: Map<string, Record<string, string>> = new Map();
  private capturedRequestHeaders: Map<string, Record<string, string>> = new Map();
  private dslVariables: Map<string, string> = new Map();

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly appConfig: any,
    private readonly tenantId: string,
    private readonly sessionId: string,
    private readonly appId: string,
    private readonly db: SessionDb,
  ) {}

  setDslVariables(vars: Map<string, string>): void {
    this.dslVariables = vars;
  }

  /**
   * Register response header capture BEFORE login actions (spec section 10.8).
   * Uses page.on('response') passive listener (not page.route()).
   */
  registerHeaderCapture(): void {
    const allowlist: string[] = this.appConfig.export_policy?.header_allowlist || [];
    if (allowlist.length === 0) return;

    const urlMatches = this.buildUrlMatcher();

    this.page.on('response', async (response: Response) => {
      try {
        const url = response.url();
        if (!urlMatches(url)) return;

        const headers = await response.allHeaders();

        // Filter captured headers against allowlist (preserve configured casing)
        const filtered: Record<string, string> = {};
        for (const key of allowlist) {
          const lowerKey = key.toLowerCase();
          if (headers[lowerKey]) {
            filtered[key] = headers[lowerKey];
          }
        }

        if (Object.keys(filtered).length > 0) {
          this.storeCapturedHeaders(this.capturedResponseHeaders, url, filtered);
        }
      } catch {
        // Ignore errors during header capture
      }
    });
  }

  /**
   * Register outbound request header capture BEFORE login actions.
   * Mirrors registerHeaderCapture but listens on 'request' for JS-minted auth material
   * (bearer JWTs, tenant keys) that never appears in a response.
   *
   * The allowlist is the gate — no wildcard, no 'Cookie'. Validator enforces this upstream.
   */
  registerRequestHeaderCapture(): void {
    const allowlist: string[] = this.appConfig.export_policy?.request_header_allowlist || [];
    if (allowlist.length === 0) return;

    const urlMatches = this.buildUrlMatcher();

    this.page.on('request', async (request: Request) => {
      try {
        const url = request.url();
        if (!urlMatches(url)) return;

        const headers = await request.allHeaders();

        const filtered: Record<string, string> = {};
        for (const key of allowlist) {
          const lowerKey = key.toLowerCase();
          if (headers[lowerKey]) {
            filtered[key] = headers[lowerKey];
          }
        }

        if (Object.keys(filtered).length > 0) {
          this.storeCapturedHeaders(this.capturedRequestHeaders, url, filtered);
        }
      } catch {
        // Request may have been redirected or aborted — ignore
      }
    });
  }

  /**
   * Build a URL matcher from appConfig.target_urls (glob patterns).
   * Empty or missing target_urls means match everything (consistent with cookie extraction).
   */
  private buildUrlMatcher(): (url: string) => boolean {
    const targetUrls: string[] = this.appConfig.target_urls || [];
    if (targetUrls.length === 0) return () => true;

    const regexes = targetUrls.map((glob) => {
      // Escape regex special chars except '*' which becomes '.*'
      const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`);
    });
    return (url: string) => regexes.some((r) => r.test(url));
  }

  /**
   * Insert/update a per-URL header map with LRU-style cap.
   * When the cap is reached, evict the oldest entry (Map preserves insertion order).
   */
  private storeCapturedHeaders(
    store: Map<string, Record<string, string>>,
    url: string,
    headers: Record<string, string>,
  ): void {
    if (store.has(url)) {
      store.delete(url); // re-insert to move to end (most recent)
    } else if (store.size >= HEADER_CAPTURE_URL_CAP) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(url, headers);
  }

  /**
   * Extract artifacts, encrypt, upload to MinIO, publish to NATS.
   */
  async extractAndUpload(): Promise<void> {
    const exportPolicy = this.appConfig.export_policy;
    const artifactTypes: string[] = exportPolicy?.artifact_types || [];
    const targetUrls: string[] = this.appConfig.target_urls || [];

    const artifacts: Record<string, unknown> = {};

    // Extract based on artifact_types configuration
    if (artifactTypes.includes('cookies')) {
      artifacts.cookies = await this.extractCookies(targetUrls);
    }

    if (artifactTypes.includes('headers')) {
      artifacts.headers = this.extractHeaders();
    }

    if (artifactTypes.includes('csrf_token')) {
      artifacts.csrf_token = await this.extractCsrfToken();
    }

    if (artifactTypes.includes('local_storage')) {
      artifacts.local_storage = await this.extractLocalStorage();
    }

    if (artifactTypes.includes('session_storage')) {
      artifacts.session_storage = await this.extractSessionStorage();
    }

    // Custom extractions (js_eval for aura tokens, VF remoting, etc.)
    const customExtractions = exportPolicy?.custom_extractions as CustomExtraction[] | undefined;
    if (customExtractions && customExtractions.length > 0) {
      artifacts.custom = await this.extractCustom(customExtractions);
    }

    // Log extracted artifact summary (keys + value lengths, NOT values)
    console.log('[Artifacts] Extracted:');
    if (artifacts.cookies) {
      const cookies = artifacts.cookies as any[];
      console.log(`  cookies: ${cookies.length} cookies [${cookies.map((c: any) => `${c.name}=${String(c.value).length}chars`).join(', ')}]`);
    }
    if (artifacts.headers) console.log(`  headers: ${Object.keys(artifacts.headers as object).length} URLs captured`);
    if (artifacts.local_storage) console.log(`  local_storage: ${String(artifacts.local_storage).length} chars`);
    if (artifacts.session_storage) console.log(`  session_storage: ${String(artifacts.session_storage).length} chars`);
    if (artifacts.custom) {
      const custom = artifacts.custom as Record<string, string>;
      console.log(`  custom: ${Object.keys(custom).map(k => `${k}=${custom[k]?.length || 0}chars`).join(', ')}`);
    }

    // Encrypt the artifact bundle
    const plaintext = Buffer.from(JSON.stringify(artifacts), 'utf-8');
    const { encrypted, nonce, keyVersion } = await this.encrypt(plaintext);

    // Upload to MinIO
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const objectKey = `${this.appId}/${this.sessionId}/${timestamp}.enc`;
    const bucketName = `artifact-bundles-${this.tenantId}`;
    const expiresAt = new Date(
      Date.now() + (exportPolicy?.ttl_seconds || 3600) * 1000
    ).toISOString();

    await this.uploadToMinio(bucketName, objectKey, encrypted);

    const artifactId = await this.db.insertArtifactBundle({
      sessionId: this.sessionId,
      appId: this.appId,
      tenantId: this.tenantId,
      encryptedPayloadRef: objectKey,
      nonce,
      keyVersion,
      expiresAt,
    });
    if (!artifactId) {
      throw new Error('Failed to persist artifact bundle metadata');
    }

    // Publish export metadata to NATS
    await this.publishExportEvent(objectKey, nonce, keyVersion, expiresAt);

    console.log(`Artifacts exported: ${objectKey}`);
  }

  /**
   * Extract ALL cookies from the browser context.
   * Playwright's context.cookies(urls) misses broad-domain cookies (e.g., .salesforce.com)
   * that don't exactly match the target URLs. Always return all cookies to ensure
   * auth cookies on parent domains are included.
   */
  private async extractCookies(_targetUrls: string[]): Promise<unknown> {
    return this.context.cookies();
  }

  /**
   * Extract captured headers (union of response + request directions) from passive listeners.
   * On per-URL conflict, request-header values win — they are the auth material we care about,
   * while same-named response headers are typically Set-Cookie / Server noise.
   * Disk shape is unchanged: { url: { headerName: value } }.
   */
  private extractHeaders(): Record<string, Record<string, string>> {
    const result: Record<string, Record<string, string>> = {};
    for (const [url, headers] of this.capturedResponseHeaders) {
      result[url] = { ...headers };
    }
    for (const [url, headers] of this.capturedRequestHeaders) {
      result[url] = { ...(result[url] || {}), ...headers };
    }
    return result;
  }

  /**
   * Extract CSRF token from DOM or meta tag (spec section 10.8).
   */
  private async extractCsrfToken(): Promise<string | null> {
    try {
      return await this.page.evaluate(() => {
        // Try meta tag first
        const meta = document.querySelector('meta[name="csrf-token"]');
        if (meta) return meta.getAttribute('content');

        // Try input field
        const input = document.querySelector('input[name="_csrf"], input[name="csrf_token"]') as HTMLInputElement;
        if (input) return input.value;

        return null;
      });
    } catch {
      return null;
    }
  }

  /**
   * Extract localStorage (spec section 10.8).
   * Note: context.storageState() does NOT capture sessionStorage.
   */
  private async extractLocalStorage(): Promise<string> {
    return this.page.evaluate(() => JSON.stringify(window.localStorage));
  }

  /**
   * Extract sessionStorage (requires explicit page.evaluate per spec).
   */
  private async extractSessionStorage(): Promise<string> {
    return this.page.evaluate(() => JSON.stringify(window.sessionStorage));
  }

  /**
   * Run custom extractions defined in export_policy.custom_extractions.
   * Supports js_eval (run arbitrary JS in page context) and cookie (named cookie lookup).
   * Used for Salesforce aura tokens, VF Remoting tokens, and similar site-specific extractions.
   */
  private async extractCustom(extractions: CustomExtraction[]): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    const currentUrl = this.page.url();
    const extractUrls: Record<string, string> = this.appConfig.export_policy?.extract_urls || {};

    // Group extractions: those matching current page vs those needing a new tab
    const mainPageExtractions: CustomExtraction[] = [];
    const remoteGroups: Map<string, CustomExtraction[]> = new Map();

    for (const extraction of extractions) {
      if (!extraction.extract_on_url) {
        mainPageExtractions.push(extraction);
        continue;
      }
      const pattern = extraction.extract_on_url.replace(/\*/g, '.*');
      if (new RegExp(pattern).test(currentUrl)) {
        mainPageExtractions.push(extraction);
      } else {
        const group = remoteGroups.get(extraction.extract_on_url) || [];
        group.push(extraction);
        remoteGroups.set(extraction.extract_on_url, group);
      }
    }

    // Run main page extractions on current page
    for (const extraction of mainPageExtractions) {
      try {
        const value = await this.runSingleExtraction(this.page, extraction);
        if (value) results[extraction.key] = value;
      } catch (error) {
        console.warn(`Custom extraction '${extraction.key}' failed: ${error}`);
      }
    }

    // Run remote extractions in new tabs
    for (const [urlPattern, group] of remoteGroups) {
      const urlTemplate = extractUrls[urlPattern];
      if (!urlTemplate) {
        console.warn(`[Artifacts] No extract_urls mapping for pattern '${urlPattern}', skipping ${group.length} extractions`);
        continue;
      }
      // Interpolate {{varname}} from DSL variables
      const resolvedUrl = urlTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => this.dslVariables.get(key) ?? '');
      if (!resolvedUrl || resolvedUrl.includes('{{')) {
        console.warn(`[Artifacts] Unresolved variables in extract URL: ${resolvedUrl}`);
        continue;
      }

      const remoteResults = await this.extractInNewTab(resolvedUrl, group);
      Object.assign(results, remoteResults);
    }

    return results;
  }

  private async runSingleExtraction(page: Page, extraction: CustomExtraction): Promise<string | null> {
    if (extraction.type === 'js_eval' && extraction.expression) {
      const value = await page.evaluate(extraction.expression);
      return value ? String(value) : null;
    } else if (extraction.type === 'cookie' && extraction.cookie_name) {
      const cookies = await this.context.cookies();
      const match = cookies.find(c => c.name === extraction.cookie_name);
      return match ? match.value : null;
    }
    return null;
  }

  /**
   * Open a new tab, navigate to the given URL, run extractions, close the tab.
   * Shares the same BrowserContext (cookies, proxy) as the main page.
   */
  private async extractInNewTab(url: string, extractions: CustomExtraction[]): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    let newPage: Page | null = null;

    const timeoutMs = parseInt(process.env.EXTRACT_TAB_TIMEOUT_MS || '15000', 10);
    const pollIntervalMs = parseInt(process.env.EXTRACT_TAB_POLL_INTERVAL_MS || '3000', 10);

    try {
      newPage = await this.context.newPage();
      console.log(`[Artifacts] Opening new tab for extraction: ${url}`);
      await newPage.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });

      const deadline = Date.now() + timeoutMs;
      let attempt = 0;
      let prevSuccessCount = 0;
      let stableRounds = 0;

      while (Date.now() < deadline) {
        attempt++;
        await newPage.waitForTimeout(pollIntervalMs);

        for (const extraction of extractions) {
          if (results[extraction.key]) continue;
          try {
            const value = await this.runSingleExtraction(newPage, extraction);
            if (value) results[extraction.key] = value;
          } catch (error) {
            console.warn(`Custom extraction '${extraction.key}' attempt ${attempt} failed: ${error}`);
          }
        }

        const successCount = Object.keys(results).length;

        if (successCount === extractions.length) {
          console.log(`[Artifacts] All ${successCount} extractions succeeded on attempt ${attempt}`);
          break;
        }

        if (successCount > 0 && successCount === prevSuccessCount) {
          stableRounds++;
          if (stableRounds >= 2) {
            console.log(`[Artifacts] Extractions stabilized at ${successCount}/${extractions.length} after ${attempt} attempts — stopping early`);
            break;
          }
        } else {
          stableRounds = 0;
        }
        prevSuccessCount = successCount;
      }

      const extracted = Object.keys(results);
      const failed = extractions.filter(e => !results[e.key]).map(e => e.key);
      console.log(`[Artifacts] New tab extractions after ${attempt} attempt(s): ${extracted.map(k => `${k}=${results[k]?.length || 0}chars`).join(', ')}${failed.length ? ` | gave up on: ${failed.join(', ')}` : ''}`);
    } catch (error) {
      console.error(`[Artifacts] New tab extraction failed for ${url}: ${error}`);
    } finally {
      if (newPage) {
        try { await newPage.close(); } catch { /* best effort */ }
      }
    }

    return results;
  }

  /**
   * Encrypt artifact bundle with AES-256-GCM per spec section 13.3.
   * Blob format: [nonce (12 bytes)] [ciphertext] [GCM auth tag (16 bytes)]
   */
  private async encrypt(plaintext: Buffer): Promise<{
    encrypted: Buffer;
    nonce: Buffer;
    keyVersion: string;
  }> {
    // In production, key is loaded from K8s Secret tenant-key-{tenant_id}.
    const keyHex = (process.env.TENANT_ENCRYPTION_KEY || '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error('TENANT_ENCRYPTION_KEY must be a 64-character hex string');
    }
    const key = Buffer.from(keyHex, 'hex');
    const keyVersion = (process.env.TENANT_KEY_VERSION || 'v1').trim() || 'v1';

    // 12-byte random nonce from CSPRNG
    const nonce = randomBytes(12);

    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Blob: [nonce][ciphertext][auth tag]
    const encrypted = Buffer.concat([nonce, ciphertext, authTag]);

    return { encrypted, nonce, keyVersion };
  }

  /**
   * Upload encrypted blob to MinIO.
   */
  private async uploadToMinio(bucket: string, objectKey: string, data: Buffer): Promise<void> {
    const { Client } = await import('minio');
    const minioEndpoint = requireEnv('MINIO_ENDPOINT', {
      testDefault: 'localhost',
    });
    const minioAccessKey = requireEnv('MINIO_ACCESS_KEY', {
      testDefault: 'minioadmin',
    });
    const minioSecretKey = requireEnv('MINIO_SECRET_KEY', {
      testDefault: 'minioadmin',
    });
    const minioClient = new Client({
      endPoint: minioEndpoint,
      port: parseInt(process.env.MINIO_PORT || '9000', 10),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: minioAccessKey,
      secretKey: minioSecretKey,
    });

    const exists = await minioClient.bucketExists(bucket);
    if (!exists) {
      await minioClient.makeBucket(bucket);
    }
    await minioClient.putObject(bucket, objectKey, data);
  }

  /**
   * Publish export metadata to NATS.
   */
  private async publishExportEvent(
    objectKey: string,
    nonce: Buffer,
    keyVersion: string,
    expiresAt: string,
  ): Promise<void> {
    try {
      const natsUrl = requireEnv('NATS_URL', {
        testDefault: 'nats://localhost:4222',
      });
      const workerLogger = {
        log: (msg: string) => console.log(msg),
        warn: (msg: string) => console.warn(msg),
        error: (msg: string) => console.error(msg),
      };
      const nc = await connectNats(natsUrl, workerLogger, { skipStatusMonitor: true });
      const sc = StringCodec();

      const subject = NATS_SUBJECTS.authBundleExported(this.tenantId, this.appId);
      const payload = {
        type: 'auth.bundle.exported',
        timestamp: new Date().toISOString(),
        payload: {
          app_id: this.appId,
          session_id: this.sessionId,
          tenant_id: this.tenantId,
          exported_at: new Date().toISOString(),
          expires_at: expiresAt,
          artifact_bundle_ref: `s3://artifact-bundles-${this.tenantId}/${objectKey}`,
          key_version: keyVersion,
        },
      };

      nc.publish(subject, sc.encode(JSON.stringify(payload)));
      await nc.drain();
    } catch (error) {
      console.error(`NATS publish failed: ${error}`);
    }
  }
}
