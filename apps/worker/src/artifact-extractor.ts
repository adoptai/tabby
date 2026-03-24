import { Page, BrowserContext, Response } from 'playwright';
import { createCipheriv, randomBytes } from 'crypto';
import { connect, StringCodec } from 'nats';
import { NATS_SUBJECTS, requireEnv } from '@browser-hitl/shared';
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
export class ArtifactExtractor {
  private capturedHeaders: Map<string, Record<string, string>> = new Map();
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

    this.page.on('response', async (response: Response) => {
      try {
        const headers = await response.allHeaders();
        const url = response.url();

        // Filter captured headers against allowlist
        const filtered: Record<string, string> = {};
        for (const key of allowlist) {
          const lowerKey = key.toLowerCase();
          if (headers[lowerKey]) {
            filtered[key] = headers[lowerKey];
          }
        }

        if (Object.keys(filtered).length > 0) {
          this.capturedHeaders.set(url, filtered);
        }
      } catch {
        // Ignore errors during header capture
      }
    });
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
   * Extract cookies filtered to target domains (spec section 10.8).
   * Falls back to all cookies if URL-based filtering returns empty
   * (e.g., when target_urls scheme/hostname differs from actual visit URL).
   */
  private async extractCookies(targetUrls: string[]): Promise<unknown> {
    if (targetUrls.length > 0) {
      const filtered = await this.context.cookies(targetUrls);
      if (filtered.length > 0) return filtered;
    }
    // Fallback: return all cookies from the browser context
    return this.context.cookies();
  }

  /**
   * Extract captured response headers from passive listener.
   */
  private extractHeaders(): Record<string, Record<string, string>> {
    const result: Record<string, Record<string, string>> = {};
    for (const [url, headers] of this.capturedHeaders) {
      result[url] = headers;
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

    try {
      newPage = await this.context.newPage();
      console.log(`[Artifacts] Opening new tab for extraction: ${url}`);
      await newPage.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await newPage.waitForTimeout(8000);

      for (const extraction of extractions) {
        try {
          const value = await this.runSingleExtraction(newPage, extraction);
          if (value) results[extraction.key] = value;
        } catch (error) {
          console.warn(`Custom extraction '${extraction.key}' failed in new tab: ${error}`);
        }
      }

      console.log(`[Artifacts] New tab extractions: ${Object.keys(results).map(k => `${k}=${results[k]?.length || 0}chars`).join(', ')}`);
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
      const nc = await connect({ servers: natsUrl });
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
