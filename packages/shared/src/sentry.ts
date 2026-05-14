import * as Sentry from '@sentry/node';

export type TabbyService = 'api' | 'controller' | 'worker' | 'slack-bot' | 'admin-ui';

export function initSentry(service: TabbyService): void {
  const dsn = process.env.SENTRY_DSN;
  const enabled = process.env.SENTRY_ENABLED === 'true';
  const environment = process.env.APP_ENV || process.env.NODE_ENV || 'development';

  if (!enabled || !dsn) {
    return;
  }

  Sentry.init({
    dsn,
    environment,
    release: process.env.CHART_VERSION || undefined,
    serverName: `tabby-${service}`,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    initialScope: {
      tags: { service },
    },
  });
}

export function testSentry(service: TabbyService): boolean {
  if (!Sentry.getClient()) return false;
  Sentry.captureException(new Error(`[Sentry test] ${service} — this is a test error, safe to ignore`));
  return true;
}
