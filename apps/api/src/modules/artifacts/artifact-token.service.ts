import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { REDIS_KEYS, REDIS_TTL, requireEnv } from '@browser-hitl/shared';
import { MinioProvisionerService } from '../tenants/minio-provisioner.service';

/**
 * Redis Lua CAS (Compare-And-Swap) script for artifact tokens.
 *
 * Atomically transitions an artifact-token key from "issued" to "consumed".
 * Returns 1 (allow) when the token was still in the "issued" state,
 * and 0 (deny) in every other case (already consumed, expired, missing).
 *
 * This is the same pattern used by StreamTokenService, applied to artifact
 * download tokens to enforce single-use presigned URLs.
 */
const ARTIFACT_TOKEN_CAS_SCRIPT = `
local key = KEYS[1]
local val = redis.call('GET', key)
if val == 'issued' then
  redis.call('SET', key, 'consumed', 'KEEPTTL')
  return 1
end
return 0
`;

export interface PresignedUrlResult {
  presigned_url: string;
  token_id: string;
  expires_at: string;
}

export interface IssuedArtifactToken {
  token_id: string;
  expires_at: string;
}

@Injectable()
export class ArtifactTokenService implements OnModuleDestroy {
  private readonly logger = new Logger(ArtifactTokenService.name);
  private readonly redis: Redis;

  constructor(
    private readonly minioProvisioner: MinioProvisionerService,
  ) {
    this.redis = new Redis(requireEnv('REDIS_URL', {
      testDefault: 'redis://localhost:6379',
    }), {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    this.redis.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });

    // Pre-load the Lua script so subsequent calls use EVALSHA
    this.redis.defineCommand('artifactTokenCas', {
      numberOfKeys: 1,
      lua: ARTIFACT_TOKEN_CAS_SCRIPT,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Generate a single-use presigned download URL for an artifact.
   *
   * Steps:
   *  1. Create a MinIO presigned GET URL (valid for ARTIFACT_TOKEN_SECONDS).
   *  2. Record the issuance in Redis with SET NX + TTL to guarantee
   *     the token can only be consumed once.
   *
   * @param objectRef - The MinIO object key (encrypted_payload_ref from the artifact entity)
   * @param tenantId  - The tenant that owns the artifact
   * @returns Presigned URL, token ID, and expiry timestamp
   */
  async generatePresignedUrl(
    objectRef: string,
    tenantId: string,
  ): Promise<PresignedUrlResult> {
    const tokenId = randomUUID();
    const ttlSeconds = REDIS_TTL.ARTIFACT_TOKEN_SECONDS; // 600 s (10 min)
    const bucket = this.minioProvisioner.bucketName(tenantId);
    const minioClient = this.minioProvisioner.getClient();

    // 1. Generate MinIO presigned GET URL
    const presignedUrl = await minioClient.presignedGetObject(
      bucket,
      objectRef,
      ttlSeconds,
    );

    // 2. Store issuance marker in Redis. NX ensures idempotency.
    const redisKey = REDIS_KEYS.artifactToken(tokenId);
    const stored = await this.redis.set(redisKey, 'issued', 'EX', ttlSeconds, 'NX');

    if (stored !== 'OK') {
      // Extremely unlikely with a UUID, but fail-safe.
      throw new Error('Failed to store artifact-token issuance marker in Redis');
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    this.logger.log(
      `Issued artifact token ${tokenId} for object ${objectRef} in bucket ${bucket}`,
    );

    return {
      presigned_url: presignedUrl,
      token_id: tokenId,
      expires_at: expiresAt.toISOString(),
    };
  }

  /**
   * Issue a single-use artifact token without exposing a direct MinIO URL.
   * Intended for API-proxied artifact download flows.
   */
  async issueArtifactToken(): Promise<IssuedArtifactToken> {
    const tokenId = randomUUID();
    const ttlSeconds = REDIS_TTL.ARTIFACT_TOKEN_SECONDS;
    const redisKey = REDIS_KEYS.artifactToken(tokenId);

    const stored = await this.redis.set(redisKey, 'issued', 'EX', ttlSeconds, 'NX');
    if (stored !== 'OK') {
      throw new Error('Failed to store artifact-token issuance marker in Redis');
    }

    return {
      token_id: tokenId,
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  /**
   * Validate an artifact token and atomically consume it so it cannot be reused.
   *
   * **CRITICAL**: If Redis is unreachable the method rejects the token (fail-closed).
   *
   * @returns `true` if the token was valid and has been consumed, `false` otherwise.
   */
  async validateArtifactToken(
    tokenId: string,
  ): Promise<{ valid: true } | { valid: false; reason: string }> {
    try {
      const result = await (this.redis as any).artifactTokenCas(
        REDIS_KEYS.artifactToken(tokenId),
      );

      if (Number(result) !== 1) {
        return { valid: false, reason: 'Token already consumed or expired' };
      }
    } catch (err) {
      // CRITICAL: Fail closed -- if Redis is down, reject the token.
      this.logger.error(
        `Redis CAS failed for artifact token, rejecting: ${(err as Error).message}`,
      );
      return { valid: false, reason: 'Token validation service unavailable' };
    }

    return { valid: true };
  }
}
