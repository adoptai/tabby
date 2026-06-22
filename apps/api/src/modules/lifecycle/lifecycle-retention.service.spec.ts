import { LifecycleRetentionService } from './lifecycle-retention.service';

describe('LifecycleRetentionService helpers', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function buildService(): LifecycleRetentionService {
    return new LifecycleRetentionService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any, // browserStateRepo
      {} as any, // DataSource
    );
  }

  it('uses fallback retention when env is missing', () => {
    const service = buildService();
    const days = (service as any).getRetentionDays('LIFECYCLE_SESSION_RETENTION_DAYS', 14);
    expect(days).toBe(14);
  });

  it('parses positive retention days from env', () => {
    process.env.LIFECYCLE_SESSION_RETENTION_DAYS = '21';
    const service = buildService();
    const days = (service as any).getRetentionDays('LIFECYCLE_SESSION_RETENTION_DAYS', 14);
    expect(days).toBe(21);
  });

  it('falls back retention when env is invalid', () => {
    process.env.LIFECYCLE_SESSION_RETENTION_DAYS = '-5';
    const service = buildService();
    const days = (service as any).getRetentionDays('LIFECYCLE_SESSION_RETENTION_DAYS', 14);
    expect(days).toBe(14);
  });
});

