import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Repository } from 'typeorm';
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
import { ApplicationEntity } from '../../entities/application.entity';
import { AppTemplateEntity } from '../../entities/app-template.entity';
import { AppsService } from '../apps/apps.service';
import { ProfilesService } from '../profiles/profiles.service';
import { SessionsService } from '../sessions/sessions.service';
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
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(AppTemplateEntity)
    private readonly templateRepo: Repository<AppTemplateEntity>,
    private readonly appsService: AppsService,
    private readonly profilesService: ProfilesService,
    private readonly sessionsService: SessionsService,
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
    role?: string;
    allowedProfiles?: string[];
    unrestrictedProfiles?: boolean;
    ownerUserId?: string | null;
  }): Promise<CredentialResponseEnvelope> {
    const {
      tenantId, profileId, credentialSetId,
      forceRefresh = false, includeVolatile = true, waitSeconds = 0, requestId,
      role, allowedProfiles = [], unrestrictedProfiles, ownerUserId,
    } = params;

    if (role === 'Agent' && !unrestrictedProfiles && !allowedProfiles.includes(profileId)) {
      throw new ForbiddenException(`Agent not authorized for profile "${profileId}"`);
    }

    // 1. Resolve ACTIVE (or CANARY fallback) profile, scoped by owner if federated
    const profile = await this.resolveActiveProfile(tenantId, profileId, ownerUserId);
    const isCanary = profile.version_state === ProfileVersionState.CANARY;

    // 2. Find healthy session via profile's app_id, scoped by owner if federated
    let session: SessionEntity;
    try {
      session = await this.findHealthySession(tenantId, profile.app_id, ownerUserId);
    } catch (e) {
      if (e instanceof NotFoundException && profile.app_id) {
        // No healthy session — check if app was idle-shutdown (desired_session_count=0)
        // If so, scale it back up so the controller creates a new session
        const app = await this.appRepo.findOne({ where: { id: profile.app_id } });
        if (app && app.desired_session_count === 0) {
          this.logger.log(`Re-scaling app ${app.id} from idle shutdown for user ${ownerUserId || 'shared'}`);
          await this.sessionsService.scale(app.id, 1, tenantId, `federated:${ownerUserId || 'system'}`);
        }
      }
      throw e;
    }

    // Update last_credential_request_at and last_activity_at for idle shutdown tracking
    await this.sessionRepo.update(session.id, {
      last_credential_request_at: new Date(),
      last_activity_at: new Date(),
    });
    // NOTE: execute/fetch and execute/browser also call touchSessionActivity() for the same purpose.

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

  /**
   * Resolve the captured credential set for an ALREADY-resolved session.
   *
   * Used by execute/fetch to attach a profile's captured request headers (e.g. a
   * client-minted bearer harvested via request_header_allowlist) to the outgoing
   * in-page fetch, server-side. The bearer is pulled from the SAME session the fetch
   * runs in, so it matches that session's cookies/state, and it never has to be
   * supplied by — or exposed to — the caller. Caller resolves profile + session once
   * (execute/fetch already does) and passes them in, avoiding a second resolution that
   * could pick a different session with a mismatched bearer.
   */
  async getCredentialsForSession(
    profile: ServiceProfileEntity,
    session: SessionEntity,
    tenantId: string,
    consumerId: string,
    opts?: { forceRefresh?: boolean; includeVolatile?: boolean; waitSeconds?: number },
  ): Promise<CredentialSet> {
    const { forceRefresh = false, includeVolatile = true, waitSeconds = 0 } = opts || {};

    // Optionally trigger an immediate re-extraction for volatile bearers (silent-refresh
    // tokens rotate faster than refresh_interval_seconds). Coalesced across concurrent callers.
    // Only the coalesce leader actually triggers an extraction, so only the leader should
    // bypass the cache — followers would just do a redundant MinIO round-trip for identical data.
    let bypassCache = false;
    if (forceRefresh) {
      const coalesceResult = await this.acquireExtractLock(tenantId, profile.profile_id, 'default');
      if (coalesceResult.isLeader) {
        bypassCache = true;
        await this.signalWorkerExtract(session.id);
        if (waitSeconds > 0) {
          await this.redis.blpop(REDIS_KEYS.extractDone(session.id), waitSeconds);
        }
      }
    }

    const bundle = await this.fetchAndDecryptLatestBundle(session, tenantId, consumerId, bypassCache);
    return this.buildCredentialSet(profile, includeVolatile, bundle?.decrypted);
  }

  // ---------------------------------------------------------------
  // Profile Resolution
  // ---------------------------------------------------------------

  async resolveActiveProfile(tenantId: string, profileId: string, ownerUserId?: string | null): Promise<ServiceProfileEntity> {
    // Build where clause — add owner_user_id filter for federated users
    const where: Record<string, any> = {
      tenant_id: tenantId,
      profile_id: profileId,
      version_state: In([ProfileVersionState.ACTIVE, ProfileVersionState.CANARY]),
    };

    // If ownerUserId provided, try user-scoped profile first
    if (ownerUserId) {
      where.owner_user_id = ownerUserId;
      const userProfiles = await this.profileRepo.find({ where });
      if (userProfiles.length > 0) {
        const active = userProfiles.find(p => p.version_state === ProfileVersionState.ACTIVE);
        return active || userProfiles[0];
      }
      // Fall through to shared profiles (owner_user_id IS NULL only, not other users' profiles)
      where.owner_user_id = IsNull();
    }

    // Query for shared/tenant-scoped profiles (backward compat)
    const profiles = await this.profileRepo.find({ where });

    if (profiles.length === 0) {
      // Auto-provision from template if federated user has no profile yet
      if (ownerUserId) {
        try {
          const provisioned = await this.autoProvisionFromTemplate(tenantId, profileId, ownerUserId);
          if (provisioned) {
            return provisioned;
          }
        } catch (err) {
          // Race condition: another request already provisioned. Retry the lookup
          // with relaxed filters (any version_state, correct owner_user_id).
          if ((err as any)?.code === '23505' || (err as any)?.message?.includes('duplicate key')) {
            this.logger.warn(`Duplicate key during auto-provision for "${profileId}" user=${ownerUserId} — retrying lookup`);
            // Small delay to let the winning request commit its transaction
            await new Promise(r => setTimeout(r, 200));
            const retryProfiles = await this.profileRepo.find({
              where: { tenant_id: tenantId, profile_id: profileId, owner_user_id: ownerUserId },
            });
            if (retryProfiles.length > 0) {
              const active = retryProfiles.find(p => p.version_state === ProfileVersionState.ACTIVE);
              return active || retryProfiles[0];
            }
          }
          throw err;
        }
      }
      throw new NotFoundException(`No active profile found for "${profileId}"`);
    }

    // Prefer ACTIVE over CANARY
    const active = profiles.find(p => p.version_state === ProfileVersionState.ACTIVE);
    return active || profiles[0];
  }

  /**
   * Auto-provision app + profile + session from a matching app template.
   * Called when a federated user requests credentials but has no profile yet.
   */
  private async autoProvisionFromTemplate(
    tenantId: string,
    profileId: string,
    ownerUserId: string,
  ): Promise<ServiceProfileEntity | null> {
    const template = await this.templateRepo.findOne({
      where: { tenant_id: tenantId, profile_name_pattern: profileId },
    });

    if (!template) {
      this.logger.warn(`No app template found for profile_name_pattern="${profileId}" in tenant ${tenantId}`);
      return null;
    }

    this.logger.log(`Auto-provisioning from template "${template.name}" for user ${ownerUserId}`);

    const actorId = `federated:${ownerUserId}`;

    // 1. Create App via AppsService (full validation + audit)
    const { app_id } = await this.appsService.create({
      name: `${template.name} — ${ownerUserId}`,
      target_urls: [
        ...((template.login_config as any)?.login_url ? [(template.login_config as any).login_url] : []),
        ...((template.export_policy as any)?.target_domains || []).map((d: string) => `https://${d}`),
      ],
      // Carry the template's extra egress domains onto the cloned app so the
      // per-user session's allowlist includes the vendor's auth/CDN hosts.
      extra_egress_allowlist: template.extra_egress_allowlist ?? [],
      login_config: template.login_config as any,
      keepalive_config: template.keepalive_config as any,
      export_policy: template.export_policy as any,
      notification_config: template.notification_config as any,
      browser_policy: template.browser_policy as any,
      // Carry the template's execute capability onto the cloned app — without it the
      // controller never provisions the worker Service + JWT_SIGNING_KEY, so the
      // per-user connection could never run /execute/fetch | /execute/browser.
      execute_enabled: template.execute_enabled,
      desired_session_count: 0, // Start with 0, scale up after profile is created
    }, tenantId, actorId);

    // Set owner_user_id + template_id on app — controller will inherit owner_user_id to sessions
    await this.appRepo.update(app_id, { owner_user_id: ownerUserId, template_id: template.id });

    // 2. Create Profile via ProfilesService (full validation + audit + promote to ACTIVE)
    const savedProfile = await this.profilesService.create({
      profile_id: profileId,
      app_id,
      version: '1.0.0',
      login_config: template.login_config as any,
      credential_types: (template.export_policy as any)?.credential_types || {},
      target_domains: (template.export_policy as any)?.target_domains || [],
    }, tenantId, actorId);

    // Set owner_user_id + promote directly to ACTIVE (skip canary for auto-provisioned profiles)
    await this.profileRepo.update(savedProfile.id, {
      owner_user_id: ownerUserId,
      version_state: ProfileVersionState.ACTIVE,
    });

    // 3. Scale to 1 session via SessionsService (controller creates pod + baton + service + network policy)
    await this.sessionsService.scale(app_id, 1, tenantId, actorId);

    this.logger.log(
      `Auto-provisioned: app=${app_id} profile=${savedProfile.id} ` +
      `owner=${ownerUserId} template=${template.name} — session scaling to 1`,
    );

    return savedProfile;
  }

  // ---------------------------------------------------------------
  // Session Resolution (now uses app_id for FK chain)
  // ---------------------------------------------------------------

  async findHealthySession(tenantId: string, appId?: string | null, ownerUserId?: string | null): Promise<SessionEntity> {
    const where: Record<string, any> = {
      tenant_id: tenantId,
      state: 'HEALTHY',
    };
    if (appId) {
      where.app_id = appId;
    }

    // If ownerUserId provided, strict scoping — only return sessions owned by this user
    if (ownerUserId) {
      where.owner_user_id = ownerUserId;
    }

    const session = await this.sessionRepo.findOne({ where });
    if (!session) {
      throw new NotFoundException('No healthy session available');
    }
    return session;
  }

  /** Fire-and-forget activity touch for idle shutdown tracking. */
  async touchSessionActivity(sessionId: string): Promise<void> {
    await this.sessionRepo.update(sessionId, { last_activity_at: new Date() });
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
    if (credTypes.cookies === 'ALL') {
      // Return all extracted cookies
      for (const [, real] of cookieValues) {
        cookies.push({
          name: real.name || '',
          value: real.value ?? '',
          domain: real.domain ?? '',
          path: real.path ?? '/',
          secure: real.secure ?? true,
          httpOnly: real.httpOnly ?? true,
          volatility: CredentialVolatility.SEMI_STABLE,
        });
      }
    } else if (Array.isArray(credTypes.cookies)) {
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
    if (credTypes.headers === 'ALL') {
      // Return all extracted headers
      for (const [name, value] of headerValues) {
        headers.push({
          name,
          value,
          volatility: CredentialVolatility.SEMI_STABLE,
        });
      }
    } else if (Array.isArray(credTypes.headers)) {
      for (const header of credTypes.headers) {
        // Support both object format {"name": "x"} and string format "x"
        const headerName = typeof header === 'string' ? header : header.name;
        const volatility = typeof header === 'string'
          ? CredentialVolatility.SEMI_STABLE
          : (header.volatility as CredentialVolatility) || CredentialVolatility.SEMI_STABLE;
        if (!includeVolatile && volatility === CredentialVolatility.VOLATILE) {
          continue;
        }
        headers.push({
          name: headerName || '',
          value: headerValues.get((headerName || '').toLowerCase()) ?? '',
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
