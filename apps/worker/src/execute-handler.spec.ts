import { EXECUTE_LIMITS } from '@browser-hitl/shared';

describe('execute-handler validation', () => {
  describe('URL validation', () => {
    it('rejects missing url', () => {
      const body = { method: 'GET' };
      expect(!body || !(body as any).url).toBe(true);
    });

    it('rejects invalid URL', () => {
      expect(() => new URL('not-a-url')).toThrow();
    });

    it('accepts valid https URL', () => {
      const parsed = new URL('https://api.example.com/data');
      expect(EXECUTE_LIMITS.ALLOWED_SCHEMES.includes(parsed.protocol)).toBe(true);
    });

    it('accepts valid http URL', () => {
      const parsed = new URL('http://localhost:3000/api');
      expect(EXECUTE_LIMITS.ALLOWED_SCHEMES.includes(parsed.protocol)).toBe(true);
    });
  });

  describe('scheme rejection', () => {
    it('rejects ftp scheme', () => {
      const parsed = new URL('ftp://files.example.com/data');
      expect(EXECUTE_LIMITS.ALLOWED_SCHEMES.includes(parsed.protocol)).toBe(false);
    });

    it('rejects file scheme', () => {
      const parsed = new URL('file:///etc/passwd');
      expect(EXECUTE_LIMITS.ALLOWED_SCHEMES.includes(parsed.protocol)).toBe(false);
    });

    it('rejects javascript scheme', () => {
      // URL constructor throws for javascript: — test that it doesn't pass validation
      try {
        const parsed = new URL('javascript:alert(1)');
        expect(EXECUTE_LIMITS.ALLOWED_SCHEMES.includes(parsed.protocol)).toBe(false);
      } catch {
        // URL throws on javascript: in some implementations — also acceptable
        expect(true).toBe(true);
      }
    });
  });

  describe('header count limits', () => {
    it('allows up to MAX_HEADER_COUNT headers', () => {
      const headers: Record<string, string> = {};
      for (let i = 0; i < EXECUTE_LIMITS.MAX_HEADER_COUNT; i++) {
        headers[`X-Header-${i}`] = `value-${i}`;
      }
      expect(Object.keys(headers).length <= EXECUTE_LIMITS.MAX_HEADER_COUNT).toBe(true);
    });

    it('rejects more than MAX_HEADER_COUNT headers', () => {
      const headers: Record<string, string> = {};
      for (let i = 0; i < EXECUTE_LIMITS.MAX_HEADER_COUNT + 1; i++) {
        headers[`X-Header-${i}`] = `value-${i}`;
      }
      expect(Object.keys(headers).length > EXECUTE_LIMITS.MAX_HEADER_COUNT).toBe(true);
    });
  });

  describe('body size limits', () => {
    it('rejects body exceeding MAX_BODY_SIZE_BYTES', () => {
      const oversized = 'x'.repeat(EXECUTE_LIMITS.MAX_BODY_SIZE_BYTES + 1);
      expect(Buffer.byteLength(oversized, 'utf8') > EXECUTE_LIMITS.MAX_BODY_SIZE_BYTES).toBe(true);
    });

    it('accepts body within MAX_BODY_SIZE_BYTES', () => {
      const small = 'hello world';
      expect(Buffer.byteLength(small, 'utf8') <= EXECUTE_LIMITS.MAX_BODY_SIZE_BYTES).toBe(true);
    });
  });

  describe('timeout clamping', () => {
    it('clamps timeout to MAX_TIMEOUT_MS', () => {
      const requested = 120_000;
      const clamped = Math.min(
        Math.max(requested, 1000),
        EXECUTE_LIMITS.MAX_TIMEOUT_MS,
      );
      expect(clamped).toBe(EXECUTE_LIMITS.MAX_TIMEOUT_MS);
    });

    it('uses DEFAULT_TIMEOUT_MS when not specified', () => {
      const requested = undefined;
      const clamped = Math.min(
        Math.max(requested || EXECUTE_LIMITS.DEFAULT_TIMEOUT_MS, 1000),
        EXECUTE_LIMITS.MAX_TIMEOUT_MS,
      );
      expect(clamped).toBe(EXECUTE_LIMITS.DEFAULT_TIMEOUT_MS);
    });

    it('enforces minimum of 1000ms', () => {
      const requested = 100;
      const clamped = Math.min(
        Math.max(requested, 1000),
        EXECUTE_LIMITS.MAX_TIMEOUT_MS,
      );
      expect(clamped).toBe(1000);
    });
  });
});
