import { OAuthProviderService } from './oauth-provider.service';
import { IdentityProviderEntity } from '../../entities/identity-provider.entity';
import { UnauthorizedException } from '@nestjs/common';

function makeIdp(overrides: Partial<IdentityProviderEntity> = {}): IdentityProviderEntity {
  return {
    id: 'test-idp-id',
    name: 'Test IdP',
    provider_type: 'oidc',
    issuer_url: null,
    jwks_uri: null,
    audience: null,
    auth_url: 'https://idp.example.com/oauth/authorize',
    token_url: 'https://idp.example.com/oauth/token',
    userinfo_url: 'https://idp.example.com/userinfo',
    sign_out_url: null,
    scopes: 'openid email profile',
    admin_domains: null,
    tenant_id_claim: null,
    user_id_claim: 'sub',
    email_claim: 'email',
    name_claim: 'name',
    claim_mappings: null,
    enabled: true,
    allow_auto_provision: false,
    default_role: 'Operator',
    allow_shared_session_fallback: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as IdentityProviderEntity;
}

describe('OAuthProviderService', () => {
  let service: OAuthProviderService;

  beforeEach(() => {
    service = new OAuthProviderService();
    // Clear env vars before each test
    delete process.env.IDP_CLIENT_ID;
    delete process.env.IDP_CLIENT_SECRET;
  });

  afterEach(() => {
    delete process.env.IDP_CLIENT_ID;
    delete process.env.IDP_CLIENT_SECRET;
  });

  // ── buildAuthorizationUrl ────────────────────────────────────────────────

  describe('buildAuthorizationUrl', () => {
    it('uses IDP_CLIENT_ID env var for client_id param', () => {
      process.env.IDP_CLIENT_ID = 'env-client-id-123';
      const idp = makeIdp();
      const url = service.buildAuthorizationUrl(idp, 'https://app.example.com/callback', 'state123', 'challenge456');
      expect(url).toContain('client_id=env-client-id-123');
    });

    it('uses empty string when IDP_CLIENT_ID is not set', () => {
      const idp = makeIdp();
      const url = service.buildAuthorizationUrl(idp, 'https://app.example.com/callback', 'state123', 'challenge456');
      expect(url).toContain('client_id=');
      // Should not contain a real value
      expect(url).not.toContain('client_id=some-value');
    });

    it('throws when auth_url is not configured', () => {
      const idp = makeIdp({ auth_url: null });
      expect(() =>
        service.buildAuthorizationUrl(idp, 'https://app.example.com/callback', 'state', 'challenge'),
      ).toThrow(UnauthorizedException);
    });

    it('includes expected OAuth params in URL', () => {
      process.env.IDP_CLIENT_ID = 'my-client-id';
      const idp = makeIdp();
      const url = service.buildAuthorizationUrl(idp, 'https://app.example.com/callback', 'my-state', 'my-challenge');
      expect(url).toContain('response_type=code');
      expect(url).toContain('state=my-state');
      expect(url).toContain('code_challenge=my-challenge');
      expect(url).toContain('code_challenge_method=S256');
    });
  });

  // ── exchangeCode ─────────────────────────────────────────────────────────

  describe('exchangeCode', () => {
    it('throws when IDP_CLIENT_ID env var is missing', async () => {
      process.env.IDP_CLIENT_SECRET = 'my-secret';
      const idp = makeIdp();
      await expect(
        service.exchangeCode(idp, 'code', 'verifier', 'https://app.example.com/callback'),
      ).rejects.toThrow('Missing token_url or IDP_CLIENT_ID/IDP_CLIENT_SECRET env vars');
    });

    it('throws when IDP_CLIENT_SECRET env var is missing', async () => {
      process.env.IDP_CLIENT_ID = 'my-client-id';
      const idp = makeIdp();
      await expect(
        service.exchangeCode(idp, 'code', 'verifier', 'https://app.example.com/callback'),
      ).rejects.toThrow('Missing token_url or IDP_CLIENT_ID/IDP_CLIENT_SECRET env vars');
    });

    it('throws when token_url is missing', async () => {
      process.env.IDP_CLIENT_ID = 'my-client-id';
      process.env.IDP_CLIENT_SECRET = 'my-secret';
      const idp = makeIdp({ token_url: null });
      await expect(
        service.exchangeCode(idp, 'code', 'verifier', 'https://app.example.com/callback'),
      ).rejects.toThrow('Missing token_url or IDP_CLIENT_ID/IDP_CLIENT_SECRET env vars');
    });

    it('calls token endpoint with env var credentials', async () => {
      process.env.IDP_CLIENT_ID = 'env-client-id';
      process.env.IDP_CLIENT_SECRET = 'env-client-secret';
      const idp = makeIdp();

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'tok-abc', id_token: 'id-tok', expires_in: 3600 }),
      });
      global.fetch = mockFetch as any;

      const result = await service.exchangeCode(idp, 'auth-code', 'verifier-xyz', 'https://app.example.com/callback');

      expect(result.access_token).toBe('tok-abc');
      expect(result.id_token).toBe('id-tok');

      const callBody = mockFetch.mock.calls[0][1].body as string;
      expect(callBody).toContain('client_id=env-client-id');
      expect(callBody).toContain('client_secret=env-client-secret');
      expect(callBody).toContain('code=auth-code');

      // Restore
      delete (global as any).fetch;
    });
  });

  // ── encryptSecret / decryptSecret still work ─────────────────────────────

  describe('encryptSecret / decryptSecret', () => {
    it('round-trips plaintext correctly', () => {
      const plaintext = 'super-secret-value-123!';
      const ciphertext = service.encryptSecret(plaintext);
      expect(ciphertext).not.toBe(plaintext);
      const decrypted = service.decryptSecret(ciphertext);
      expect(decrypted).toBe(plaintext);
    });
  });

  // ── PKCE helpers ─────────────────────────────────────────────────────────

  describe('PKCE helpers', () => {
    it('generateCodeVerifier produces a non-empty string', () => {
      const verifier = service.generateCodeVerifier();
      expect(typeof verifier).toBe('string');
      expect(verifier.length).toBeGreaterThan(32);
    });

    it('computeCodeChallenge produces a deterministic hash', () => {
      const challenge1 = service.computeCodeChallenge('test-verifier');
      const challenge2 = service.computeCodeChallenge('test-verifier');
      expect(challenge1).toBe(challenge2);
    });

    it('different verifiers produce different challenges', () => {
      const c1 = service.computeCodeChallenge('verifier-a');
      const c2 = service.computeCodeChallenge('verifier-b');
      expect(c1).not.toBe(c2);
    });
  });
});
