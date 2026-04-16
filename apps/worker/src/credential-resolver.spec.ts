import { resolveCredentials } from './credential-resolver';

describe('resolveCredentials', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('manual: credential_ref', () => {
    it('returns empty credentials for "manual:"', async () => {
      const creds = await resolveCredentials('manual:');
      expect(creds).toEqual({ username: '', password: '' });
    });

    it('returns empty credentials for "manual:workday"', async () => {
      const creds = await resolveCredentials('manual:workday');
      expect(creds).toEqual({ username: '', password: '' });
    });

    it('returns empty credentials for any manual: variant without reading filesystem', async () => {
      process.env.CREDENTIALS_MOUNT_PATH = '/nonexistent-path-that-should-not-be-read';
      const creds = await resolveCredentials('manual:any-suffix');
      expect(creds).toEqual({ username: '', password: '' });
    });
  });

  describe('k8s:secret/ credential_ref', () => {
    it('throws when no mount files exist and env fallback is disabled', async () => {
      process.env.CREDENTIALS_MOUNT_PATH = '/nonexistent';
      process.env.WORKER_ALLOW_ENV_CREDENTIAL_FALLBACK = 'false';
      await expect(resolveCredentials('k8s:secret/my-secret')).rejects.toThrow(
        'Credentials not found for k8s:secret/my-secret',
      );
    });

    it('throws for empty secret name', async () => {
      await expect(resolveCredentials('k8s:secret/')).rejects.toThrow('Invalid credential_ref');
    });

    it('uses env fallback when WORKER_ALLOW_ENV_CREDENTIAL_FALLBACK=true', async () => {
      process.env.CREDENTIALS_MOUNT_PATH = '/nonexistent';
      process.env.WORKER_ALLOW_ENV_CREDENTIAL_FALLBACK = 'true';
      process.env['my-secret_USERNAME'] = 'testuser';
      process.env['my-secret_PASSWORD'] = 'testpass';
      const creds = await resolveCredentials('k8s:secret/my-secret');
      expect(creds).toEqual({ username: 'testuser', password: 'testpass' });
    });
  });
});
