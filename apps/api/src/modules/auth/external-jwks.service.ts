import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

interface JwksCacheEntry {
  keys: Array<{ kid: string; kty: string; n?: string; e?: string; x5c?: string[]; [key: string]: unknown }>;
  expiresAt: number;
  lastFetchAt: number;
}

@Injectable()
export class ExternalJwksService {
  private readonly logger = new Logger(ExternalJwksService.name);
  private readonly cache = new Map<string, JwksCacheEntry>();
  private readonly cacheTtlMs = (parseInt(process.env.JWKS_CACHE_TTL_SECONDS || '300', 10)) * 1000;
  private readonly minFetchIntervalMs = 30_000; // Max 1 fetch per issuer per 30s

  /**
   * Get the public key PEM for a given issuer and key ID.
   * Fetches and caches the JWKS document. On signature failure, caller should
   * call forceRefresh() then retry once.
   */
  async getPublicKey(issuerUrl: string, kid: string): Promise<string> {
    const jwks = await this.getJwks(issuerUrl);
    const key = jwks.find(k => k.kid === kid);
    if (!key) {
      throw new Error(`Key ${kid} not found in JWKS for ${issuerUrl}`);
    }
    return this.jwkToPem(key);
  }

  /** Force refresh the JWKS cache for an issuer (e.g., after signature failure). */
  async forceRefresh(issuerUrl: string): Promise<void> {
    this.cache.delete(issuerUrl);
    await this.getJwks(issuerUrl);
  }

  private async getJwks(issuerUrl: string): Promise<JwksCacheEntry['keys']> {
    const cached = this.cache.get(issuerUrl);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.keys;
    }

    // Rate limit: don't fetch more than once per 30s per issuer
    if (cached && (Date.now() - cached.lastFetchAt) < this.minFetchIntervalMs) {
      return cached.keys;
    }

    const jwksUri = await this.discoverJwksUri(issuerUrl);
    const keys = await this.fetchJwks(jwksUri);

    this.cache.set(issuerUrl, {
      keys,
      expiresAt: Date.now() + this.cacheTtlMs,
      lastFetchAt: Date.now(),
    });

    this.logger.log(`JWKS cached for ${issuerUrl}: ${keys.length} keys`);
    return keys;
  }

  private async discoverJwksUri(issuerUrl: string): Promise<string> {
    const discoveryUrl = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const resp = await fetch(discoveryUrl, { signal: controller.signal });
      if (!resp.ok) {
        throw new Error(`OIDC discovery failed: ${resp.status} ${resp.statusText}`);
      }
      const config = await resp.json() as { jwks_uri?: string };
      if (!config.jwks_uri) {
        throw new Error(`No jwks_uri in OIDC discovery for ${issuerUrl}`);
      }
      if (!config.jwks_uri.startsWith('https://')) {
        throw new Error(`JWKS URI must be HTTPS: ${config.jwks_uri}`);
      }
      return config.jwks_uri;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchJwks(jwksUri: string): Promise<JwksCacheEntry['keys']> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const resp = await fetch(jwksUri, { signal: controller.signal });
      if (!resp.ok) {
        throw new Error(`JWKS fetch failed: ${resp.status} ${resp.statusText}`);
      }
      const body = await resp.json() as { keys?: JwksCacheEntry['keys'] };
      if (!Array.isArray(body.keys)) {
        throw new Error('Invalid JWKS response: missing keys array');
      }
      return body.keys;
    } finally {
      clearTimeout(timeout);
    }
  }

  private jwkToPem(jwk: JwksCacheEntry['keys'][0]): string {
    // For RSA keys, use Node's crypto to convert JWK to PEM
    if (jwk.kty === 'RSA' && jwk.n && jwk.e) {
      const keyObject = crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
      return keyObject.export({ type: 'spki', format: 'pem' }) as string;
    }
    // For EC keys
    if (jwk.kty === 'EC') {
      const keyObject = crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
      return keyObject.export({ type: 'spki', format: 'pem' }) as string;
    }
    // Fallback: try x5c certificate chain
    if (jwk.x5c && jwk.x5c.length > 0) {
      return `-----BEGIN CERTIFICATE-----\n${jwk.x5c[0]}\n-----END CERTIFICATE-----`;
    }
    throw new Error(`Unsupported JWK key type: ${jwk.kty}`);
  }
}
