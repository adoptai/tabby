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
    ownerUserId?: string | null;
  }): Promise<ExecuteFetchResponse> {
    const {
      tenantId, profileId, request,
      role, allowedProfiles = [], ownerUserId,
    } = params;

    // Agent profile authorization
    if (role === 'Agent' && !allowedProfiles.includes(profileId)) {
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
          headers: request.headers,
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
    ownerUserId?: string | null;
  }): Promise<ExecuteBrowserResponse> {
    const {
      tenantId, profileId, request,
      role, allowedProfiles = [], ownerUserId,
    } = params;

    if (role === 'Agent' && !allowedProfiles.includes(profileId)) {
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
