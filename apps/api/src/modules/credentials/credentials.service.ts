import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import {
  DEFAULTS,
  REDIS_KEYS,
  REDIS_TTL,
  CredentialFreshness,
  CredentialVolatility,
  ProfileVersionState,
  RedisFailureTier,
} from '@browser-hitl/shared';
import type {
  CredentialResponseEnvelope,
  CredentialSet,
  CookieCredential,
  HeaderCredential,
  CsrfCredential,
  CustomCredential,
  CredentialUsage,
  CredentialMetadata,
} from '@browser-hitl/shared';
import { SessionEntity } from '../../entities/session.entity';
import { ServiceProfileEntity } from '../../entities/service-profile.entity';
import { ArtifactBundleEntity } from '../../entities/artifact-bundle.entity';
import { ArtifactConsumptionEntity } from '../../entities/artifact-consumption.entity';
import { RedisHealthMonitor } from '../redis/redis-health-monitor';
import { MinioProvisionerService } from '../tenants/minio-provisioner.service';
import Redis from 'ioredis';
import { requireEnv } from '@browser-hitl/shared';
import { createDecipheriv } from 'crypto';
import { Readable } from 'stream';

/** In-memory cache entry for decrypted credential bundles. */
interface CacheEntry {
  credentials: CredentialSet;
  extractedAt: string;
  expiresAt: number;
  bundleId: string;
}

const CACHE_TTL_MS = 60_000; // 60 seconds
const CACHE_MAX_ENTRIES = 1000;

/**
 * Credentials Service (ADR-013 + Sprint 3b).
 *
 * Responsible for:
 * 1. Resolving the ACTIVE profile for a given profile_id
 * 2. Finding a healthy session for the profile's application (via app_id FK)
 * 3. Force-refresh coalescing via Redis SETNX (RT-11)
 * 4. Fetching & decrypting artifact bundles from MinIO (Strategy Y)
 * 5. Building the CredentialResponseEnvelope with real credential values
 * 6. In-memory LRU cache for repeated requests
 * 7. Audit trail via artifact_consumptions records
 */
@Injectable()
export class CredentialsService {
  private readonly logger = new Logger(CredentialsService.name);
  private readonly redis: Redis;
  private readonly credentialCache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(ServiceProfileEntity)
    private readonly profileRepo: Repository<ServiceProfileEntity>,
    @InjectRepository(ArtifactBundleEntity)
    private readonly artifactRepo: Repository<ArtifactBundleEntity>,
    @InjectRepository(ArtifactConsumptionEntity)
    private readonly consumptionRepo: Repository<ArtifactConsumptionEntity>,
    private readonly healthMonitor: RedisHealthMonitor,
    private readonly minioProvisioner: MinioProvisionerService,
  ) {
    this.redis = new Redis(requireEnv('REDIS_URL', {
      testDefault: 'redis://localhost:6379',
    }), {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    this.redis.on('error', () => {});
  }

  // ---------------------------------------------------------------
  // Main Request Flow
  // ---------------------------------------------------------------

  async requestCredentials(params: {
    tenantId: string;
    profileId: string;
    credentialSetId?: string;
    forceRefresh?: boolean;
    includeVolatile?: boolean;
    waitSeconds?: number;
    requestId: string;
  }): Promise<CredentialResponseEnvelope> {
    const {
      tenantId, profileId, credentialSetId,
      forceRefresh = false, includeVolatile = true, waitSeconds = 0, requestId,
    } = params;

    // 1. Resolve ACTIVE (or CANARY fallback) profile
    const profile = await this.resolveActiveProfile(tenantId, profileId);
    const isCanary = profile.version_state === ProfileVersionState.CANARY;

    // 2. Find healthy session via profile's app_id
    const session = await this.findHealthySession(tenantId, profile.app_id);

    // 3. Force-refresh coalescing (RT-11)
    let freshness: CredentialFreshness = isCanary
      ? CredentialFreshness.CANARY
      : CredentialFreshness.CACHED;
    const effectiveCredSetId = credentialSetId || 'default';

    if (forceRefresh && !isCanary) {
      const coalesceResult = await this.acquireExtractLock(
        tenantId, profileId, effectiveCredSetId,
      );
      freshness = coalesceResult.isLeader
        ? CredentialFreshness.EXTRACTED
        : CredentialFreshness.ON_DEMAND;

      // Signal worker to re-extract artifacts from the live browser
      if (coalesceResult.isLeader) {
        await this.signalWorkerExtract(session.id);

        // If caller wants to wait for fresh data, block until the worker signals done
        if (waitSeconds > 0) {
          const doneKey = REDIS_KEYS.extractDone(session.id);
          await this.redis.blpop(doneKey, waitSeconds);
          // Returns when worker pushes, or null on timeout — proceed either way
        }
      }
    }

    // 4. Record canary traffic
    if (isCanary) {
      await this.profileRepo.increment({ id: profile.id }, 'canary_request_count', 1);
    }

    // 5. Fetch and decrypt latest artifact bundle from MinIO
    let bundle: { decrypted: Record<string, any>; extractedAt: string } | null = null;
    try {
      bundle = await this.fetchAndDecryptLatestBundle(
        session, tenantId, requestId, forceRefresh,
      );
    } catch (err) {
      if (isCanary) {
        await this.profileRepo.increment({ id: profile.id }, 'canary_error_count', 1);
      }
      throw err;
    }

    // 6. Build credential set with real values from bundle
    const credentials = this.buildCredentialSet(profile, includeVolatile, bundle?.decrypted);

    // 7. Build usage hints
    const usage = this.buildUsage(profile);

    // 8. Build metadata
    const metadata: CredentialMetadata = {
      extracted_at: bundle?.extractedAt || new Date().toISOString(),
      extraction_duration_ms: 0,
      profile_version: profile.version,
    };

    return {
      freshness,
      request_id: requestId,
      profile_id: profileId,
      session_id: session.id,
      credentials,
      usage,
      metadata,
    };
  }

  // ---------------------------------------------------------------
  // Profile Resolution
  // ---------------------------------------------------------------

  async resolveActiveProfile(tenantId: string, profileId: string): Promise<ServiceProfileEntity> {
    // Query for both ACTIVE and CANARY profiles, preferring ACTIVE
    const profiles = await this.profileRepo.find({
      where: {
        tenant_id: tenantId,
        profile_id: profileId,
        version_state: In([ProfileVersionState.ACTIVE, ProfileVersionState.CANARY]),
      },
    });

    if (profiles.length === 0) {
      throw new NotFoundException(`No active profile found for "${profileId}"`);
    }

    // Prefer ACTIVE over CANARY
    const active = profiles.find(p => p.version_state === ProfileVersionState.ACTIVE);
    return active || profiles[0];
  }

  // ---------------------------------------------------------------
  // Session Resolution (now uses app_id for FK chain)
  // ---------------------------------------------------------------

  async findHealthySession(tenantId: string, appId?: string | null): Promise<SessionEntity> {
    const where: Record<string, any> = {
      tenant_id: tenantId,
      state: 'HEALTHY',
    };
    if (appId) {
      where.app_id = appId;
    }

    const session = await this.sessionRepo.findOne({ where });
    if (!session) {
      throw new NotFoundException('No healthy session available');
    }
    return session;
  }

  // ---------------------------------------------------------------
  // Artifact Decryption (Strategy Y — MinIO Decrypt-on-Demand)
  // ---------------------------------------------------------------

  async fetchAndDecryptLatestBundle(
    session: SessionEntity,
    tenantId: string,
    consumerId: string,
    bypassCache: boolean = false,
  ): Promise<{ decrypted: Record<string, any>; extractedAt: string } | null> {
    // Find latest non-expired artifact bundle for this session
    const bundle = await this.artifactRepo.findOne({
      where: {
        session_id: session.id,
        tenant_id: tenantId,
        expires_at: MoreThan(new Date()),
      },
      order: { exported_at: 'DESC' },
    });

    if (!bundle) {
      this.logger.debug(`No artifact bundle found for session ${session.id}`);
      return null;
    }

    // Check in-memory cache (bypass on force_refresh)
    if (!bypassCache) {
      const cached = this.getFromCache(bundle.id);
      if (cached) {
        this.logger.debug(`Cache hit for bundle ${bundle.id}`);
        return { decrypted: cached.credentials as any, extractedAt: cached.extractedAt };
      }
    }

    // Download encrypted blob from MinIO
    const bucket = this.minioProvisioner.bucketName(tenantId);
    const objectKey = bundle.encrypted_payload_ref;

    let encryptedBuf: Buffer;
    try {
      const stream = await this.minioProvisioner.getClient().getObject(bucket, objectKey);
      encryptedBuf = await this.streamToBuffer(stream as Readable);
    } catch (err) {
      this.logger.warn(`Failed to download artifact ${bundle.id} from MinIO: ${(err as Error).message}`);
      return null;
    }

    // Decrypt AES-256-GCM: nonce (first 12 bytes) | ciphertext | auth tag (last 16 bytes)
    let decryptedJson: Record<string, any>;
    const decryptedBuf = Buffer.alloc(0); // Reference for zeroing

    // TypeORM may return bytea as Buffer or hex string — normalise to Buffer
    let nonceBuf: Buffer;
    if (Buffer.isBuffer(bundle.nonce)) {
      nonceBuf = bundle.nonce;
    } else if (typeof bundle.nonce === 'string') {
      // Handle hex-encoded string (with or without \x prefix)
      const hex = (bundle.nonce as string).replace(/^\\x/, '');
      nonceBuf = Buffer.from(hex, 'hex');
    } else {
      nonceBuf = Buffer.from(bundle.nonce as any);
    }

    try {
      decryptedJson = this.decryptBundle(encryptedBuf, nonceBuf);
    } catch (err) {
      this.logger.warn(`Failed to decrypt artifact ${bundle.id}: ${(err as Error).message} (nonce type=${typeof bundle.nonce}, isBuffer=${Buffer.isBuffer(bundle.nonce)}, len=${nonceBuf.length})`);
      return null;
    } finally {
      // Zero the encrypted buffer
      encryptedBuf.fill(0);
    }

    const extractedAt = bundle.exported_at.toISOString();

    // Store in cache
    this.putInCache(bundle.id, {
      credentials: decryptedJson as any,
      extractedAt,
      expiresAt: Date.now() + CACHE_TTL_MS,
      bundleId: bundle.id,
    });

    // Record artifact consumption for audit trail
    try {
      const consumption = this.consumptionRepo.create({
        artifact_id: bundle.id,
        consumer_id: consumerId,
        token_id: `api_req_${consumerId}`,
        access_method: 'api_envelope',
      });
      await this.consumptionRepo.save(consumption);
    } catch (err) {
      this.logger.warn(`Failed to record artifact consumption: ${(err as Error).message}`);
    }

    return { decrypted: decryptedJson, extractedAt };
  }

  /** Decrypt an AES-256-GCM encrypted blob using the stored nonce. */
  decryptBundle(encrypted: Buffer, nonce: Buffer): Record<string, any> {
    const encryptionKey = requireEnv('TENANT_ENCRYPTION_KEY', {
      testDefault: '0'.repeat(64),
    });
    const keyBuf = Buffer.from(encryptionKey, 'hex');

    // Worker writes blobs as: [nonce (12 bytes)][ciphertext][auth tag (16 bytes)]
    // The nonce is also stored separately in the artifact_bundles.nonce column.
    // Strip the 12-byte nonce prefix to get just [ciphertext][auth tag].
    const nonceLength = 12;
    const authTagLength = 16;
    if (encrypted.length < nonceLength + authTagLength) {
      throw new Error('Encrypted payload too short');
    }

    const payload = encrypted.subarray(nonceLength);
    const ciphertext = payload.subarray(0, payload.length - authTagLength);
    const authTag = payload.subarray(payload.length - authTagLength);

    const decipher = createDecipheriv('aes-256-gcm', keyBuf, nonce);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    const json = JSON.parse(decrypted.toString('utf8'));

    // Zero the decrypted buffer
    decrypted.fill(0);

    return json;
  }

  // ---------------------------------------------------------------
  // Force-Refresh Coalescing (RT-11)
  // ---------------------------------------------------------------

  async acquireExtractLock(
    tenantId: string,
    profileId: string,
    credSetId: string,
  ): Promise<{ isLeader: boolean }> {
    // Check Redis health — skip lock when DEGRADED/DOWN (CONSISTENCY tier)
    const tierAction = this.healthMonitor.evaluateTier(RedisFailureTier.CONSISTENCY);
    if (tierAction === 'skip') {
      this.logger.warn('Redis DEGRADED/DOWN — skipping extract lock, treating as leader');
      return { isLeader: true };
    }

    const lockKey = REDIS_KEYS.extractLock(tenantId, profileId, credSetId);

    try {
      const result = await this.redis.set(
        lockKey,
        Date.now().toString(),
        'EX',
        DEFAULTS.EXTRACT_LOCK_TTL_SECONDS,
        'NX',
      );

      if (result === 'OK') {
        this.logger.debug(`Extract lock acquired: ${lockKey}`);
        return { isLeader: true };
      }

      this.logger.debug(`Extract lock coalesced: ${lockKey} (another request is leader)`);
      return { isLeader: false };
    } catch (err) {
      this.logger.warn(`Extract lock error (treating as leader): ${(err as Error).message}`);
      return { isLeader: true };
    }
  }

  /**
   * Signal the worker to perform an immediate artifact extraction.
   * Sets a Redis key that the keepalive runner polls for on each tick.
   */
  private async signalWorkerExtract(sessionId: string): Promise<void> {
    const key = REDIS_KEYS.extractRequest(sessionId);
    try {
      await this.redis.set(key, Date.now().toString(), 'EX', REDIS_TTL.EXTRACT_REQUEST_SECONDS);
      this.logger.debug(`Extract request signaled for session ${sessionId}`);
    } catch (err) {
      this.logger.warn(`Failed to signal extract request for ${sessionId}: ${(err as Error).message}`);
    }
  }

  async releaseExtractLock(
    tenantId: string,
    profileId: string,
    credSetId: string,
  ): Promise<void> {
    const lockKey = REDIS_KEYS.extractLock(tenantId, profileId, credSetId);
    try {
      await this.redis.del(lockKey);
    } catch {
      // Best-effort release
    }
  }

  // ---------------------------------------------------------------
  // Credential Set Construction (now with real values from bundle)
  // ---------------------------------------------------------------

  buildCredentialSet(
    profile: ServiceProfileEntity,
    includeVolatile: boolean,
    decrypted?: Record<string, any> | null,
  ): CredentialSet {
    const credTypes = profile.credential_types as Record<string, any>;

    // Build lookup maps from decrypted artifact data
    const cookieValues = new Map<string, Record<string, any>>();
    const headerValues = new Map<string, string>();
    let csrfValue = '';

    if (decrypted) {
      // Map cookies by name for fast lookup
      if (Array.isArray(decrypted.cookies)) {
        for (const c of decrypted.cookies) {
          cookieValues.set(c.name, c);
        }
      }
      // Map headers: decrypted.headers is { url: { headerName: value } }
      // Store with lowercase key for case-insensitive lookup (HTTP headers are case-insensitive)
      if (decrypted.headers && typeof decrypted.headers === 'object') {
        for (const url of Object.keys(decrypted.headers)) {
          const hdrs = decrypted.headers[url];
          if (hdrs && typeof hdrs === 'object') {
            for (const [name, value] of Object.entries(hdrs)) {
              headerValues.set(name.toLowerCase(), String(value));
            }
          }
        }
      }
      // CSRF token
      if (decrypted.csrf_token) {
        csrfValue = String(decrypted.csrf_token);
      }
    }

    const cookies: CookieCredential[] = [];
    const headers: HeaderCredential[] = [];
    let csrf: CsrfCredential | undefined;

    // Build cookies from credential_types, merging real values
    if (credTypes.cookies && Array.isArray(credTypes.cookies)) {
      for (const cookie of credTypes.cookies) {
        const volatility = (cookie.volatility as CredentialVolatility) || CredentialVolatility.STABLE;
        if (!includeVolatile && volatility === CredentialVolatility.VOLATILE) {
          continue;
        }
        const real = cookieValues.get(cookie.name);
        cookies.push({
          name: cookie.name || '',
          value: real?.value ?? '',
          domain: real?.domain ?? cookie.domain ?? '',
          path: real?.path ?? cookie.path ?? '/',
          secure: real?.secure ?? cookie.secure ?? true,
          httpOnly: real?.httpOnly ?? cookie.httpOnly ?? true,
          volatility,
        });
      }
    }

    // Build headers from credential_types, merging real values
    if (credTypes.headers && Array.isArray(credTypes.headers)) {
      for (const header of credTypes.headers) {
        const volatility = (header.volatility as CredentialVolatility) || CredentialVolatility.SEMI_STABLE;
        if (!includeVolatile && volatility === CredentialVolatility.VOLATILE) {
          continue;
        }
        headers.push({
          name: header.name || '',
          value: headerValues.get((header.name || '').toLowerCase()) ?? '',
          volatility,
        });
      }
    }

    // Build CSRF from credential_types, merging real value
    if (credTypes.csrf) {
      const volatility = (credTypes.csrf.volatility as CredentialVolatility) || CredentialVolatility.VOLATILE;
      if (includeVolatile || volatility !== CredentialVolatility.VOLATILE) {
        csrf = {
          token: csrfValue,
          header_name: credTypes.csrf.header_name || 'X-CSRF-Token',
          volatility,
        };
      }
    }

    // Build custom credentials from credential_types.custom, merging values from decrypted.custom
    const custom: CustomCredential[] = [];
    if (credTypes.custom && Array.isArray(credTypes.custom)) {
      const customValues = (decrypted?.custom || {}) as Record<string, string>;
      for (const entry of credTypes.custom) {
        const volatility = (entry.volatility as CredentialVolatility) || CredentialVolatility.SEMI_STABLE;
        if (!includeVolatile && volatility === CredentialVolatility.VOLATILE) {
          continue;
        }
        custom.push({
          key: entry.key,
          value: customValues[entry.key] ?? '',
          volatility,
        });
      }
    }

    // Merge local_storage and session_storage from decrypted bundle
    const result: CredentialSet = { cookies, headers, csrf, ...(custom.length > 0 ? { custom } : {}) };
    if (decrypted?.local_storage) {
      result.local_storage = decrypted.local_storage;
    }
    if (decrypted?.session_storage) {
      result.session_storage = decrypted.session_storage;
    }

    return result;
  }

  buildUsage(profile: ServiceProfileEntity): CredentialUsage {
    const extraConfig = (profile.extra_config || {}) as Record<string, any>;
    const credTypes = profile.credential_types as Record<string, any>;

    // Collect volatile field names
    const volatileFields: string[] = [];
    if (credTypes.cookies && Array.isArray(credTypes.cookies)) {
      for (const c of credTypes.cookies) {
        if (c.volatility === CredentialVolatility.VOLATILE) {
          volatileFields.push(`cookie:${c.name}`);
        }
      }
    }
    if (credTypes.headers && Array.isArray(credTypes.headers)) {
      for (const h of credTypes.headers) {
        if (h.volatility === CredentialVolatility.VOLATILE) {
          volatileFields.push(`header:${h.name}`);
        }
      }
    }
    if (credTypes.csrf?.volatility === CredentialVolatility.VOLATILE) {
      volatileFields.push('csrf');
    }
    if (credTypes.custom && Array.isArray(credTypes.custom)) {
      for (const c of credTypes.custom) {
        if (c.volatility === CredentialVolatility.VOLATILE) {
          volatileFields.push(`custom:${c.key}`);
        }
      }
    }

    return {
      ttl_seconds: extraConfig.ttl_seconds ?? DEFAULTS.EXPORT_TTL_SECONDS,
      refresh_before_seconds: extraConfig.refresh_before_seconds ?? DEFAULTS.EXPORT_REFRESH_INTERVAL_SECONDS,
      volatile_fields: volatileFields,
    };
  }

  // ---------------------------------------------------------------
  // In-Memory LRU Cache
  // ---------------------------------------------------------------

  private getFromCache(bundleId: string): CacheEntry | null {
    const entry = this.credentialCache.get(bundleId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.credentialCache.delete(bundleId);
      return null;
    }
    return entry;
  }

  private putInCache(bundleId: string, entry: CacheEntry): void {
    // Evict expired entries and enforce max size
    if (this.credentialCache.size >= CACHE_MAX_ENTRIES) {
      this.evictExpired();
    }
    // If still at capacity, remove oldest entry (first key in Map iteration order)
    if (this.credentialCache.size >= CACHE_MAX_ENTRIES) {
      const firstKey = this.credentialCache.keys().next().value;
      if (firstKey) this.credentialCache.delete(firstKey);
    }
    this.credentialCache.set(bundleId, entry);
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.credentialCache) {
      if (now > entry.expiresAt) {
        this.credentialCache.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
