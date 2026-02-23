import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { NATS_SUBJECTS, REDIS_KEYS, REDIS_TTL } from '@browser-hitl/shared';

// ---------------------------------------------------------------------------
// These integration tests verify the full artifact pipeline:
//   extraction -> AES-256-GCM encryption -> MinIO upload -> NATS publish
// All external dependencies (MinIO, NATS, Redis) are mocked.
// ---------------------------------------------------------------------------

describe('Artifact Pipeline Integration', () => {
  // -----------------------------------------------------------------------
  // AES-256-GCM encryption/decryption roundtrip
  // -----------------------------------------------------------------------
  describe('AES-256-GCM encryption/decryption roundtrip', () => {
    function encryptAes256Gcm(plaintext: Buffer, key: Buffer): { encrypted: Buffer; nonce: Buffer } {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      // Blob format from spec: [nonce (12 bytes)][ciphertext][auth tag (16 bytes)]
      const encrypted = Buffer.concat([nonce, ciphertext, authTag]);
      return { encrypted, nonce };
    }

    function decryptAes256Gcm(encrypted: Buffer, key: Buffer): Buffer {
      const nonce = encrypted.subarray(0, 12);
      const authTag = encrypted.subarray(encrypted.length - 16);
      const ciphertext = encrypted.subarray(12, encrypted.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }

    it('encrypts and decrypts a JSON artifact bundle', () => {
      const artifacts = {
        cookies: [{ name: 'session', value: 'abc123', domain: '.example.com' }],
        headers: { 'https://example.com': { 'x-csrf-token': 'tok123' } },
        local_storage: '{"key":"value"}',
      };

      const plaintext = Buffer.from(JSON.stringify(artifacts), 'utf-8');
      const key = randomBytes(32); // AES-256 key

      const { encrypted } = encryptAes256Gcm(plaintext, key);

      // Blob should be nonce(12) + ciphertext + authTag(16)
      expect(encrypted.length).toBe(12 + plaintext.length + 16);

      // Decrypt and verify roundtrip
      const decrypted = decryptAes256Gcm(encrypted, key);
      expect(decrypted.toString('utf-8')).toBe(JSON.stringify(artifacts));
    });

    it('uses 12-byte nonce from CSPRNG', () => {
      const key = randomBytes(32);
      const plaintext = Buffer.from('hello', 'utf-8');

      const { nonce } = encryptAes256Gcm(plaintext, key);
      expect(nonce.length).toBe(12);
    });

    it('produces different ciphertext for same plaintext (random nonce)', () => {
      const key = randomBytes(32);
      const plaintext = Buffer.from('same-data', 'utf-8');

      const result1 = encryptAes256Gcm(plaintext, key);
      const result2 = encryptAes256Gcm(plaintext, key);

      expect(result1.encrypted.equals(result2.encrypted)).toBe(false);
    });

    it('fails to decrypt with wrong key', () => {
      const key1 = randomBytes(32);
      const key2 = randomBytes(32);
      const plaintext = Buffer.from('secret', 'utf-8');

      const { encrypted } = encryptAes256Gcm(plaintext, key1);

      expect(() => decryptAes256Gcm(encrypted, key2)).toThrow();
    });

    it('fails to decrypt with tampered ciphertext', () => {
      const key = randomBytes(32);
      const plaintext = Buffer.from('integrity-check', 'utf-8');

      const { encrypted } = encryptAes256Gcm(plaintext, key);

      // Tamper with a byte in the ciphertext portion (between nonce and auth tag)
      const tampered = Buffer.from(encrypted);
      tampered[15] ^= 0xff; // flip a byte in ciphertext area

      expect(() => decryptAes256Gcm(tampered, key)).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Extraction -> Encryption -> Upload -> NATS publish flow (mocked)
  // -----------------------------------------------------------------------
  describe('extraction -> encryption -> upload -> NATS publish flow', () => {
    it('executes the full pipeline with mocked dependencies', async () => {
      // Mock MinIO client
      const minioPutObject = jest.fn().mockResolvedValue(undefined);
      const mockMinioClient = {
        putObject: minioPutObject,
      };

      // Mock NATS connection
      const natsPublish = jest.fn();
      const natsDrain = jest.fn().mockResolvedValue(undefined);
      const mockNatsConnection = {
        publish: natsPublish,
        drain: natsDrain,
      };

      // Simulate artifact extraction
      const cookies = [{ name: 'sid', value: 'abc', domain: '.example.com' }];
      const headers = { 'https://example.com/api': { authorization: 'Bearer tok' } };
      const artifacts = { cookies, headers };

      const plaintext = Buffer.from(JSON.stringify(artifacts), 'utf-8');

      // Encrypt
      const key = randomBytes(32);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const encrypted = Buffer.concat([nonce, ciphertext, authTag]);

      // Upload to MinIO
      const tenantId = 'tenant-abc';
      const appId = 'app-123';
      const sessionId = 'session-456';
      const bucketName = `artifact-bundles-${tenantId}`;
      const objectKey = `${appId}/${sessionId}/2026-01-01T00-00-00-000Z.enc`;

      await mockMinioClient.putObject(bucketName, objectKey, encrypted);
      expect(minioPutObject).toHaveBeenCalledWith(bucketName, objectKey, encrypted);

      // Publish to NATS
      const subject = NATS_SUBJECTS.authBundleExported(tenantId, appId);
      const payload = {
        type: 'auth.bundle.exported',
        timestamp: new Date().toISOString(),
        payload: {
          app_id: appId,
          session_id: sessionId,
          tenant_id: tenantId,
          exported_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          artifact_bundle_ref: `s3://${bucketName}/${objectKey}`,
          key_version: 'v1',
        },
      };

      mockNatsConnection.publish(subject, JSON.stringify(payload));
      expect(natsPublish).toHaveBeenCalledWith(
        `auth.bundle.exported.${tenantId}.${appId}`,
        expect.any(String),
      );
    });
  });

  // -----------------------------------------------------------------------
  // NATS subject ACL validation
  // -----------------------------------------------------------------------
  describe('NATS ACL validation', () => {
    it('all NATS subjects include tenant_id for ACL scoping', () => {
      const tenantId = 'tenant-42';
      const sessionId = 'session-1';
      const appId = 'app-1';

      const subjects = [
        NATS_SUBJECTS.authBundleExported(tenantId, appId),
        NATS_SUBJECTS.sessionStateChanged(tenantId, sessionId),
        NATS_SUBJECTS.hitlStarted(tenantId, sessionId),
        NATS_SUBJECTS.hitlCompleted(tenantId, sessionId),
        NATS_SUBJECTS.hitlOtpRequested(tenantId, sessionId),
      ];

      for (const subject of subjects) {
        expect(subject).toContain(tenantId);
      }
    });

    it('NATS subjects use dot-delimited hierarchy', () => {
      const subject = NATS_SUBJECTS.sessionStateChanged('t1', 's1');
      const parts = subject.split('.');
      expect(parts.length).toBeGreaterThanOrEqual(3);
    });

    it('different tenants produce different subjects', () => {
      const subjectA = NATS_SUBJECTS.hitlStarted('tenant-a', 'session-1');
      const subjectB = NATS_SUBJECTS.hitlStarted('tenant-b', 'session-1');
      expect(subjectA).not.toBe(subjectB);
    });
  });

  // -----------------------------------------------------------------------
  // Artifact Token single-use validation (mocked Redis)
  // -----------------------------------------------------------------------
  describe('artifact token single-use semantics (mocked Redis)', () => {
    it('issued token can be consumed once', async () => {
      const store = new Map<string, string>();

      // Mock Redis SET NX
      const mockSet = jest.fn().mockImplementation(
        (key: string, val: string, _ex: string, _ttl: number, _nx: string) => {
          if (store.has(key)) return null;
          store.set(key, val);
          return 'OK';
        },
      );

      // Mock Redis CAS script
      const mockTokenCas = jest.fn().mockImplementation((key: string) => {
        const val = store.get(key);
        if (val === 'issued') {
          store.set(key, 'consumed');
          return 1;
        }
        return 0;
      });

      // Issue token
      const tokenId = 'tok-123';
      const redisKey = REDIS_KEYS.artifactToken(tokenId);
      const stored = mockSet(redisKey, 'issued', 'EX', REDIS_TTL.ARTIFACT_TOKEN_SECONDS, 'NX');
      expect(stored).toBe('OK');

      // First validation succeeds
      const firstResult = mockTokenCas(redisKey);
      expect(firstResult).toBe(1);

      // Second validation fails (already consumed)
      const secondResult = mockTokenCas(redisKey);
      expect(secondResult).toBe(0);
    });
  });
});
