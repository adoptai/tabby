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
import { EXECUTE_LIMITS, PORTS } from '@browser-hitl/shared';
import type { ExecuteFetchRequest, ExecuteFetchResponse } from '@browser-hitl/shared';
import { CredentialsService } from '../credentials/credentials.service';
import Redis from 'ioredis';
import { requireEnv } from '@browser-hitl/shared';

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_PER_MINUTE = Number(process.env.EXECUTE_RATE_LIMIT_PER_MIN || '60');

@Injectable()
export class ExecuteService {
  private readonly logger = new Logger(ExecuteService.name);
  private readonly redis: Redis;
  private readonly workerNamespace: string;

  constructor(
    private readonly credentialsService: CredentialsService,
  ) {
    this.workerNamespace = process.env.WORKER_NAMESPACE || 'browser-hitl';
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

    // Rate limit per profile
    await this.enforceRateLimit(profileId);

    // Resolve profile → session → pod
    const profile = await this.credentialsService.resolveActiveProfile(
      tenantId, profileId, ownerUserId,
    );
    const session = await this.credentialsService.findHealthySession(
      tenantId, profile.app_id, ownerUserId,
    );

    if (!session.pod_name) {
      throw new ConflictException('Session has no assigned worker pod');
    }

    // Validate request
    this.validateRequest(request);

    // Build internal worker URL
    const workerUrl = `http://${session.pod_name}-worker.${this.workerNamespace}.svc.cluster.local:${PORTS.WORKER_HEALTH}/execute/fetch`;

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
        headers: { 'Content-Type': 'application/json' },
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
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
      }
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
}
