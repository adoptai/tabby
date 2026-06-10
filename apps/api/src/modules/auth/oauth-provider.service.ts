import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { IdentityProviderEntity } from '../../entities/identity-provider.entity';
import { resolveRoleFromIdp } from '../../common/helpers/role-resolver.helper';

/**
 * Handles the browser-side Generic OAuth flow for the admin-UI login.
 * Mirrors Grafana's "Generic OAuth" provider pattern:
 *   auth_url → token_url → userinfo_url → Tabby session
 *
 * Also owns client_secret encryption/decryption so the secret is never stored
 * in plaintext. Uses AES-256-GCM with the TENANT_ENCRYPTION_KEY.
 *
 * API path (backend-to-backend) does NOT use this service — it uses
 * ExternalJwksService + JwtStrategy directly.
 */
@Injectable()
export class OAuthProviderService {
  private readonly logger = new Logger(OAuthProviderService.name);

  // ─── Secret encryption ────────────────────────────────────────────────────

  /** Encrypt a plaintext client_secret for storage. Returns base64url ciphertext. */
  encryptSecret(plaintext: string): string {
    const key = this.getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Layout: iv(12) + tag(16) + ciphertext
    return Buffer.concat([iv, tag, encrypted]).toString('base64url');
  }

  /** Decrypt a stored client_secret. Returns plaintext. */
  decryptSecret(ciphertext: string): string {
    const key = this.getEncryptionKey();
    const buf = Buffer.from(ciphertext, 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }

  // ─── PKCE helpers ─────────────────────────────────────────────────────────

  /** Generate a PKCE code_verifier (43-128 chars, URL-safe). */
  generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /** Derive the code_challenge (S256) from a verifier. */
  computeCodeChallenge(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
  }

  // ─── OAuth browser flow ───────────────────────────────────────────────────

  /**
   * Build the authorization URL to redirect the user to.
   * Returns the URL string.
   */
  buildAuthorizationUrl(
    idp: IdentityProviderEntity,
    redirectUri: string,
    state: string,
    codeChallenge: string,
  ): string {
    if (!idp.auth_url) {
      throw new UnauthorizedException('IdP does not have auth_url configured');
    }

    const scopes = idp.scopes || 'openid email profile';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.IDP_CLIENT_ID || '',
      redirect_uri: redirectUri,
      scope: scopes.replace(/,/g, ' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return `${idp.auth_url}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens.
   * Returns { access_token, id_token? }.
   */
  async exchangeCode(
    idp: IdentityProviderEntity,
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<{ access_token: string; id_token?: string; expires_in?: number }> {
    const clientId = process.env.IDP_CLIENT_ID;
    const clientSecret = process.env.IDP_CLIENT_SECRET;
    if (!idp.token_url || !clientId || !clientSecret) {
      throw new UnauthorizedException('Missing token_url or IDP_CLIENT_ID/IDP_CLIENT_SECRET env vars');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: codeVerifier,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const resp = await fetch(idp.token_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: body.toString(),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new UnauthorizedException(`Token endpoint returned ${resp.status}: ${text}`);
      }

      const data = await resp.json() as Record<string, unknown>;
      if (!data.access_token) {
        throw new UnauthorizedException('Token endpoint did not return access_token');
      }

      return {
        access_token: String(data.access_token),
        id_token: data.id_token ? String(data.id_token) : undefined,
        expires_in: data.expires_in ? Number(data.expires_in) : undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fetch user profile from the userinfo endpoint using an access token.
   * Returns the raw claims object.
   */
  async fetchUserInfo(idp: IdentityProviderEntity, accessToken: string): Promise<Record<string, unknown>> {
    if (!idp.userinfo_url) {
      throw new UnauthorizedException('IdP does not have userinfo_url configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const resp = await fetch(idp.userinfo_url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new UnauthorizedException(`Userinfo endpoint returned ${resp.status}`);
      }

      return await resp.json() as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Extract user identity fields from userinfo claims using the IdP's configured claim names.
   */
  extractIdentity(
    idp: IdentityProviderEntity,
    claims: Record<string, unknown>,
  ): { userId: string; email: string; name: string; tenantIdClaimValue: string | null } {
    const userId = String(claims[idp.user_id_claim] || claims['sub'] || '');
    const email = String(claims[idp.email_claim] || claims['email'] || '');
    const name = String(claims[idp.name_claim] || claims['name'] || email);
    const tenantIdClaimValue = idp.tenant_id_claim
      ? (claims[idp.tenant_id_claim] ? String(claims[idp.tenant_id_claim]) : null)
      : null;

    return { userId, email, name, tenantIdClaimValue };
  }

  /**
   * Determine the Tabby role for a user based on IdP role claim mapping and email domain.
   * Delegates to resolveRoleFromIdp for consistent logic across all auth paths.
   */
  resolveRole(idp: IdentityProviderEntity, email: string, verifiedPayload: Record<string, unknown> = {}): string {
    return resolveRoleFromIdp(idp, verifiedPayload, email);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private getEncryptionKey(): Buffer {
    const raw = process.env.TENANT_ENCRYPTION_KEY || '';
    if (!raw) {
      if (process.env.NODE_ENV === 'test') {
        return Buffer.from('0'.repeat(64), 'hex');
      }
      throw new Error('TENANT_ENCRYPTION_KEY must be configured');
    }
    return Buffer.from(raw, 'hex');
  }
}
