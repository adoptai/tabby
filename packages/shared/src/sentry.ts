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
    beforeSend: redactSensitiveRequestData,
  });
}

/** Request-body keys that must never reach Sentry (portal passwords on POST /credentials/request). */
const REDACTED_REQUEST_KEYS = new Set(['login_credentials', 'password']);

/**
 * The default RequestData integration attaches the incoming request body
 * (`include.data: true`) to every event. Strip credential-bearing keys before
 * the event leaves the process, whether the body is still an object or was
 * already serialised to a JSON string.
 */
export function redactSensitiveRequestData<T extends { request?: { data?: unknown } }>(event: T): T {
  const data = event.request?.data;
  if (data == null) {
    return event;
  }
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      const redacted = redactObject(parsed);
      if (redacted !== parsed) {
        event.request!.data = JSON.stringify(redacted);
      }
    } catch {
      // Not JSON: nothing to redact by key.
    }
    return event;
  }
  event.request!.data = redactObject(data);
  return event;
}

function redactObject(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_REQUEST_KEYS.has(key)) {
      out[key] = '[redacted]';
      changed = true;
    } else {
      out[key] = v;
    }
  }
  return changed ? out : value;
}

export function testSentry(service: TabbyService): boolean {
  if (!Sentry.getClient()) return false;
  Sentry.captureException(new Error(`[Sentry test] ${service} — this is a test error, safe to ignore`));
  return true;
}
