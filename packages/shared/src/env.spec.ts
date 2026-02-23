import { requireEnv, validateEnv, EnvVarSpec } from './env';

describe('requireEnv', () => {
  const orig = { ...process.env };
  afterEach(() => { process.env = { ...orig }; });

  it('returns value when set', () => {
    process.env.TEST_VAR = 'hello';
    expect(requireEnv('TEST_VAR')).toBe('hello');
  });

  it('throws when missing', () => {
    delete process.env.TEST_VAR;
    expect(() => requireEnv('TEST_VAR')).toThrow('TEST_VAR must be configured');
  });

  it('returns testDefault in test environment', () => {
    delete process.env.TEST_VAR;
    process.env.NODE_ENV = 'test';
    expect(requireEnv('TEST_VAR', { testDefault: 'fallback' })).toBe('fallback');
  });
});

describe('validateEnv', () => {
  const orig = { ...process.env };
  afterEach(() => { process.env = { ...orig }; });

  it('passes when all required vars are set', () => {
    process.env.NODE_ENV = 'production';
    process.env.DB_URL = 'postgres://localhost/db';
    process.env.REDIS_URL = 'redis://localhost';

    const specs: EnvVarSpec[] = [
      { name: 'DB_URL', required: true },
      { name: 'REDIS_URL', required: true },
    ];

    const result = validateEnv(specs);
    expect(result.DB_URL).toBe('postgres://localhost/db');
    expect(result.REDIS_URL).toBe('redis://localhost');
  });

  it('collects ALL missing vars before throwing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DB_URL;
    delete process.env.REDIS_URL;
    delete process.env.NATS_URL;

    const specs: EnvVarSpec[] = [
      { name: 'DB_URL', required: true, description: 'PostgreSQL connection' },
      { name: 'REDIS_URL', required: true },
      { name: 'NATS_URL', required: true },
    ];

    expect(() => validateEnv(specs)).toThrow(/DB_URL.*MISSING/);
    try {
      validateEnv(specs);
    } catch (e: any) {
      // All three must appear in ONE error message
      expect(e.message).toContain('DB_URL');
      expect(e.message).toContain('REDIS_URL');
      expect(e.message).toContain('NATS_URL');
      expect(e.message).toContain('PostgreSQL connection');
    }
  });

  it('uses default values when provided', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOG_LEVEL;

    const specs: EnvVarSpec[] = [
      { name: 'LOG_LEVEL', default: 'info' },
    ];

    const result = validateEnv(specs);
    expect(result.LOG_LEVEL).toBe('info');
  });

  it('validates pattern when provided', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENCRYPTION_KEY = 'tooshort';

    const specs: EnvVarSpec[] = [
      { name: 'ENCRYPTION_KEY', pattern: /^[0-9a-f]{64}$/, description: '64-char hex' },
    ];

    expect(() => validateEnv(specs)).toThrow(/ENCRYPTION_KEY.*INVALID/);
  });

  it('passes pattern validation for correct values', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);

    const specs: EnvVarSpec[] = [
      { name: 'ENCRYPTION_KEY', pattern: /^[0-9a-f]{64}$/ },
    ];

    const result = validateEnv(specs);
    expect(result.ENCRYPTION_KEY).toBe('a'.repeat(64));
  });

  it('skips required checks in test environment', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.DB_URL;

    const specs: EnvVarSpec[] = [
      { name: 'DB_URL', required: true },
    ];

    // Should NOT throw in test env
    expect(() => validateEnv(specs)).not.toThrow();
  });
});
