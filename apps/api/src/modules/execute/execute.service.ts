import {
  BadRequestException,
  ConflictException,
  BadGatewayException,
  Injectable,
  Logger,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { EXECUTE_LIMITS, PORTS, REDIS_KEYS, REDIS_TTL, BROWSER_COMMANDS } from '@browser-hitl/shared';
import type {
  ExecuteFetchRequest, ExecuteFetchResponse,
  ExecuteBrowserRequest, ExecuteBrowserResponse,
  CredentialSet,
} from '@browser-hitl/shared';
import { CredentialsService } from '../credentials/credentials.service';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { requireEnv } from '@browser-hitl/shared';

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_PER_MINUTE = Number(process.env.EXECUTE_RATE_LIMIT_PER_MIN || '60');

@Injectable()
export class ExecuteService {
  private readonly logger = new Logger(ExecuteService.name);
  private readonly redis: Redis;
  private readonly workerNamespace: string;
  private readonly localWorkerUrl: string | undefined;

  constructor(
    private readonly credentialsService: CredentialsService,
    private readonly jwtService: JwtService,
  ) {
    this.workerNamespace = process.env.WORKER_NAMESPACE || 'browser-hitl';
    this.localWorkerUrl = process.env.LOCAL_WORKER_URL;
    this.redis = new Redis(requireEnv('REDIS_URL', {
      testDefault: 'redis://localhost:6379',
    }), {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    this.redis.on('error', () => {});
  }

  async executeFetch(params: {
    tenantId: string;
    profileId: string;
    request: ExecuteFetchRequest;
    role?: string;
    allowedProfiles?: string[];
    unrestrictedProfiles?: boolean;
    ownerUserId?: string | null;
    attachCaptured?: boolean;
    refreshCredentials?: boolean;
  }): Promise<ExecuteFetchResponse> {
    const {
      tenantId, profileId, request,
      role, allowedProfiles = [], unrestrictedProfiles, ownerUserId,
      attachCaptured = false, refreshCredentials = false,
    } = params;

    // Agent profile authorization
    if (role === 'Agent' && !unrestrictedProfiles && !allowedProfiles.includes(profileId)) {
      throw new BadRequestException(`Agent not authorized for profile "${profileId}"`);
    }

    // Validate before rate limiting so invalid requests don't burn quota
    this.validateRequest(request);

    await this.enforceRateLimit(profileId);

    // Resolve profile → session → pod
    const profile = await this.credentialsService.resolveActiveProfile(
      tenantId, profileId, ownerUserId,
    );
    const session = await this.credentialsService.findHealthySession(
      tenantId, profile.app_id, ownerUserId,
    );

    // Track activity for idle shutdown (execute/fetch counts as usage)
    this.credentialsService.touchSessionActivity(session.id).catch(() => {});

    if (!session.pod_name) {
      throw new ConflictException('Session has no assigned worker pod');
    }

    // Optionally attach the profile's captured request headers (e.g. a client-minted
    // bearer harvested via request_header_allowlist) to the outgoing fetch, server-side.
    // Pulled from the SAME session the fetch runs in, so the credential matches the
    // session; the bearer never has to be supplied by, or exposed to, the caller.
    let outgoingHeaders = request.headers;
    if (attachCaptured && !this.isRequestInCaptureScope(request.url, profile.target_domains)) {
      // Origin-scope the injection: only ever send the profile's captured bearer to a host
      // within its declared capture scope (target_domains) — the hosts the credential was
      // captured from. This stops a prompt-injected / attacker-influenced URL (e.g.
      // https://evil.com) from receiving the captured Authorization header, independent of
      // the worker egress allowlist. Out of scope → forward the caller's headers only.
      this.logger.warn(
        `attach_captured_credentials: target host for profile "${profileId}" is outside its `
        + `capture scope (target_domains=${JSON.stringify(profile.target_domains || [])}) — `
        + `NOT attaching captured credentials`,
      );
    } else if (attachCaptured) {
      try {
        const credSet = await this.credentialsService.getCredentialsForSession(
          profile, session, tenantId, `execute-fetch:${profileId}`,
          // refresh_credentials must actually block for the freshly-exported bundle
          // (a volatile bearer rotated seconds ago is the whole reason to refresh);
          // without a wait it could read the previous cached bundle.
          { forceRefresh: refreshCredentials, waitSeconds: refreshCredentials ? 5 : 0 },
        );
        outgoingHeaders = this.mergeCapturedHeaders(request.headers, credSet);
        if (!this.hasCapturedHeaders(credSet)) {
          // Name the most common misconfig: a profile can capture bearers at the worker
          // level (export_policy.request_header_allowlist) yet never surface them because
          // credential_types.headers is unset — the call returns 200 but the target 401s.
          const declaresHeaders = Boolean((profile.credential_types as any)?.headers);
          const hint = declaresHeaders
            ? 'the latest artifact bundle carries none yet — check export_policy.request_header_allowlist + '
              + 'target_urls (needs the /** glob), and that a request bearing the header has been made'
            : 'the profile does not declare credential_types.headers, so captured headers are never '
              + 'surfaced — add it (e.g. ["authorization"])';
          this.logger.warn(
            `attach_captured_credentials: no captured headers for profile "${profileId}" `
            + `(session ${session.id}): ${hint}. Forwarding caller headers only.`,
          );
        }
      } catch (err) {
        // Fail soft: forward caller headers only. A downstream auth failure will surface
        // the real problem rather than masking it behind a credential-lookup error.
        this.logger.warn(
          `attach_captured_credentials failed for profile "${profileId}": `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Keep MAX_HEADER_COUNT authoritative: validateRequest checked the caller's headers,
      // but merging captured headers can push the total over the limit.
      if (outgoingHeaders && Object.keys(outgoingHeaders).length > EXECUTE_LIMITS.MAX_HEADER_COUNT) {
        throw new BadRequestException(
          `Too many headers after attaching captured credentials `
          + `(${Object.keys(outgoingHeaders).length} > ${EXECUTE_LIMITS.MAX_HEADER_COUNT})`,
        );
      }
    }

    const workerUrl = this.buildWorkerUrl(session.pod_name, '/execute/fetch');

    // Forward to worker
    const timeoutMs = Math.min(
      request.timeout_ms || EXECUTE_LIMITS.DEFAULT_TIMEOUT_MS,
      EXECUTE_LIMITS.MAX_TIMEOUT_MS,
    );

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs + 5000);

    try {
      const workerResponse = await fetch(workerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.signWorkerToken(tenantId, profileId)}`,
        },
        body: JSON.stringify({
          url: request.url,
          method: request.method,
          headers: outgoingHeaders,
          body: request.body,
          timeout_ms: timeoutMs,
        } satisfies ExecuteFetchRequest),
        signal: abortController.signal,
      });

      if (!workerResponse.ok) {
        const errorBody = await workerResponse.text().catch(() => 'unknown error');
        if (workerResponse.status === 502) {
          throw new BadGatewayException(`Worker fetch failed: ${errorBody}`);
        }
        throw new BadGatewayException(
          `Worker returned ${workerResponse.status}: ${errorBody}`,
        );
      }

      return await workerResponse.json() as ExecuteFetchResponse;
    } catch (err: unknown) {
      if (err instanceof BadGatewayException || err instanceof GatewayTimeoutException) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort')) {
        throw new GatewayTimeoutException('Worker request timed out');
      }
      throw new BadGatewayException(`Worker unreachable: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async executeBrowser(params: {
    tenantId: string;
    profileId: string;
    request: ExecuteBrowserRequest;
    role?: string;
    allowedProfiles?: string[];
    unrestrictedProfiles?: boolean;
    ownerUserId?: string | null;
  }): Promise<ExecuteBrowserResponse> {
    const {
      tenantId, profileId, request,
      role, allowedProfiles = [], unrestrictedProfiles, ownerUserId,
    } = params;

    if (role === 'Agent' && !unrestrictedProfiles && !allowedProfiles.includes(profileId)) {
      throw new BadRequestException(`Agent not authorized for profile "${profileId}"`);
    }

    if (!request.command || !BROWSER_COMMANDS.includes(request.command as any)) {
      throw new BadRequestException(
        `Invalid command "${request.command}". Valid: ${BROWSER_COMMANDS.join(', ')}`,
      );
    }

    await this.enforceBrowserRateLimit(profileId);

    const profile = await this.credentialsService.resolveActiveProfile(
      tenantId, profileId, ownerUserId,
    );
    const session = await this.credentialsService.findHealthySession(
      tenantId, profile.app_id, ownerUserId,
    );

    // Track activity for idle shutdown (execute/browser counts as usage)
    this.credentialsService.touchSessionActivity(session.id).catch(() => {});

    if (!session.pod_name) {
      throw new ConflictException('Session has no assigned worker pod');
    }

    // Acquire session consumer lock (mandatory per integration notes)
    const lockKey = REDIS_KEYS.executeBrowserLock(session.id);
    const lockAcquired = await this.acquireSessionLock(lockKey);
    if (!lockAcquired) {
      throw new ConflictException(
        'Session is currently being driven by another consumer. Try again shortly.',
      );
    }

    const workerUrl = this.buildWorkerUrl(session.pod_name, '/execute/browser');
    const timeoutMs = Math.min(
      request.timeout_ms || EXECUTE_LIMITS.DEFAULT_TIMEOUT_MS,
      EXECUTE_LIMITS.MAX_TIMEOUT_MS,
    );

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs + 5000);

    try {
      const workerResponse = await fetch(workerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.signWorkerToken(tenantId, profileId)}`,
        },
        body: JSON.stringify({
          command: request.command,
          params: request.params || {},
          timeout_ms: timeoutMs,
        } satisfies ExecuteBrowserRequest),
        signal: abortController.signal,
      });

      if (!workerResponse.ok) {
        const errorBody = await workerResponse.text().catch(() => 'unknown error');
        if (workerResponse.status === 502) {
          throw new BadGatewayException(`Worker browser command failed: ${errorBody}`);
        }
        throw new BadGatewayException(
          `Worker returned ${workerResponse.status}: ${errorBody}`,
        );
      }

      const result = await workerResponse.json() as ExecuteBrowserResponse;
      return result;
    } catch (err: unknown) {
      if (err instanceof ConflictException || err instanceof BadGatewayException) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort')) {
        throw new GatewayTimeoutException('Worker browser command timed out');
      }
      throw new BadGatewayException(`Worker unreachable: ${message}`);
    } finally {
      clearTimeout(timer);
      await this.releaseSessionLock(lockKey);
    }
  }

  /**
   * True if the request URL's host is within the profile's declared capture scope
   * (`target_domains`) — i.e. a host the captured credential was harvested from. Used to
   * origin-scope credential injection so a captured bearer is never attached to an
   * out-of-scope host. Fails closed: no declared scope (empty) → not in scope.
   */
  private isRequestInCaptureScope(url: string, targetDomains?: string[] | null): boolean {
    if (!targetDomains || targetDomains.length === 0) return false;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    return targetDomains.some((d) => {
      const dom = String(d).toLowerCase().replace(/^\.+/, '').replace(/^https?:\/\//, '');
      return dom.length > 0 && (host === dom || host.endsWith(`.${dom}`));
    });
  }

  /** True if the captured set carries at least one non-empty header or CSRF token. */
  private hasCapturedHeaders(credSet: CredentialSet): boolean {
    if (credSet.headers?.some((h) => h?.name && h.value)) return true;
    return Boolean(credSet.csrf?.token && credSet.csrf.header_name);
  }

  /**
   * Merge a session's captured request headers into the caller's headers for the
   * outgoing in-page fetch. Cookies are intentionally excluded — the in-page fetch
   * inherits them via credentials:'include', and browsers forbid setting a Cookie
   * header on fetch. Caller-supplied headers win on a case-insensitive name collision,
   * preserving the "caller headers forwarded as-is" contract; captured headers fill
   * in what the caller omits (typically the client-minted Authorization bearer).
   */
  private mergeCapturedHeaders(
    callerHeaders: Record<string, string> | undefined,
    credSet: CredentialSet,
  ): Record<string, string> {
    // Cookie/Cookie2 are forbidden header names for an in-page fetch() — attaching one
    // would make page.evaluate throw. request_header_allowlist already rejects Cookie, but
    // filter defensively so a misconfigured capture can't break every /execute/fetch.
    const forbidden = new Set(['cookie', 'cookie2']);
    const captured: Record<string, string> = {};
    for (const h of credSet.headers || []) {
      const name = h?.name?.trim();
      if (!name || !h.value || forbidden.has(name.toLowerCase())) continue;
      captured[name] = h.value;
    }
    if (credSet.csrf?.token && credSet.csrf.header_name?.trim()) {
      const csrfName = credSet.csrf.header_name.trim();
      if (!forbidden.has(csrfName.toLowerCase())) captured[csrfName] = credSet.csrf.token;
    }

    if (!callerHeaders || Object.keys(callerHeaders).length === 0) {
      return captured;
    }

    const merged: Record<string, string> = { ...captured };
    const callerNamesLower = new Set(Object.keys(callerHeaders).map((k) => k.toLowerCase()));
    for (const key of Object.keys(merged)) {
      if (callerNamesLower.has(key.toLowerCase())) delete merged[key];
    }
    return { ...merged, ...callerHeaders };
  }

  private buildWorkerUrl(podName: string, path: string): string {
    if (this.localWorkerUrl) {
      return `${this.localWorkerUrl.replace(/\/+$/, '')}${path}`;
    }
    return `http://${podName}-worker.${this.workerNamespace}.svc.cluster.local:${PORTS.WORKER_HEALTH}${path}`;
  }

  private async acquireSessionLock(lockKey: string): Promise<boolean> {
    try {
      const result = await this.redis.set(
        lockKey,
        Date.now().toString(),
        'EX',
        REDIS_TTL.EXECUTE_BROWSER_LOCK_SECONDS,
        'NX',
      );
      return result === 'OK';
    } catch (err) {
      this.logger.warn(`Session lock check failed (allowing request): ${err}`);
      return true;
    }
  }

  private async releaseSessionLock(lockKey: string): Promise<void> {
    try {
      await this.redis.del(lockKey);
    } catch {
      // Best-effort release
    }
  }

  private async enforceBrowserRateLimit(profileId: string): Promise<void> {
    const key = `execute_browser_rate:${profileId}`;
    try {
      const count = await this.atomicIncr(key, RATE_LIMIT_WINDOW_SECONDS);
      if (count > EXECUTE_LIMITS.BROWSER_RATE_LIMIT_PER_MIN) {
        throw new HttpException(
          `Rate limit exceeded for profile "${profileId}" (${EXECUTE_LIMITS.BROWSER_RATE_LIMIT_PER_MIN}/min)`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS) throw err;
      this.logger.warn(`Browser rate limit check failed (allowing request): ${err}`);
    }
  }

  private validateRequest(request: ExecuteFetchRequest): void {
    if (!request.url || typeof request.url !== 'string') {
      throw new BadRequestException('Missing or invalid "url" field');
    }

    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      throw new BadRequestException(`Invalid URL: ${request.url}`);
    }

    if (!EXECUTE_LIMITS.ALLOWED_SCHEMES.includes(parsed.protocol)) {
      throw new BadRequestException(
        `Scheme "${parsed.protocol}" not allowed. Use http: or https:`,
      );
    }

    if (request.headers && Object.keys(request.headers).length > EXECUTE_LIMITS.MAX_HEADER_COUNT) {
      throw new BadRequestException(
        `Too many headers (max ${EXECUTE_LIMITS.MAX_HEADER_COUNT})`,
      );
    }

    if (request.body && Buffer.byteLength(request.body, 'utf8') > EXECUTE_LIMITS.MAX_BODY_SIZE_BYTES) {
      throw new BadRequestException(
        `Body too large (max ${EXECUTE_LIMITS.MAX_BODY_SIZE_BYTES} bytes)`,
      );
    }
  }

  private async enforceRateLimit(profileId: string): Promise<void> {
    const key = `execute_rate:${profileId}`;
    try {
      const count = await this.atomicIncr(key, RATE_LIMIT_WINDOW_SECONDS);
      if (count > RATE_LIMIT_PER_MINUTE) {
        throw new HttpException(
          `Rate limit exceeded for profile "${profileId}" (${RATE_LIMIT_PER_MINUTE}/min)`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS) throw err;
      this.logger.warn(`Rate limit check failed (allowing request): ${err}`);
    }
  }

  private async atomicIncr(key: string, ttlSeconds: number): Promise<number> {
    const result = await this.redis.eval(
      `local c = redis.call('INCR', KEYS[1])
       if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return c`,
      1,
      key,
      ttlSeconds,
    ) as number;
    return result;
  }

  private signWorkerToken(tenantId: string, profileId: string): string {
    return this.jwtService.sign(
      { sub: 'execute-proxy', tenant_id: tenantId, profile_id: profileId, token_type: 'service' },
      { expiresIn: '2m' },
    );
  }
}
