import {
  validateLoginConfig,
  validateKeepaliveConfig,
  validateExportPolicy,
  validateNotificationConfig,
  validateTargetUrls,
} from './dsl.validator';
import { LoginConfig, KeepaliveConfig, ExportPolicy, NotificationConfig } from './config.types';

describe('validateLoginConfig', () => {
  const validConfig: LoginConfig = {
    login_url: 'https://app.example.com/login',
    credential_ref: 'k8s:secret/app-cred-1',
    steps: [
      { action: 'goto', url: 'https://app.example.com/login' },
      { action: 'fill', selector: '#username', value: '${USERNAME}' },
      { action: 'fill', selector: '#password', value: '${PASSWORD}', sensitive: true },
      { action: 'click', selector: 'button[type=submit]' },
    ],
  };

  it('accepts valid login config', () => {
    const result = validateLoginConfig(validConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects config without goto action', () => {
    const result = validateLoginConfig({
      ...validConfig,
      steps: [{ action: 'fill', selector: '#x', value: 'v' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('goto'))).toBe(true);
  });

  it('rejects empty steps', () => {
    const result = validateLoginConfig({ ...validConfig, steps: [] });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid credential_ref format', () => {
    const result = validateLoginConfig({ ...validConfig, credential_ref: 'invalid' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'credential_ref')).toBe(true);
  });

  it('accepts manual: credential_ref', () => {
    const result = validateLoginConfig({ ...validConfig, credential_ref: 'manual:' });
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.path === 'credential_ref')).toHaveLength(0);
  });

  it('accepts manual: credential_ref with suffix', () => {
    const result = validateLoginConfig({ ...validConfig, credential_ref: 'manual:workday' });
    expect(result.valid).toBe(true);
    expect(result.errors.filter(e => e.path === 'credential_ref')).toHaveLength(0);
  });

  it('rejects invalid action type', () => {
    const result = validateLoginConfig({
      ...validConfig,
      steps: [
        { action: 'goto', url: 'https://x.com' },
        { action: 'invalid_action' as any, selector: '#x' },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it('validates all 15 DSL action types', () => {
    const allActions: LoginConfig = {
      login_url: 'https://app.example.com',
      credential_ref: 'k8s:secret/cred',
      steps: [
        { action: 'goto', url: 'https://app.example.com' },
        { action: 'fill', selector: '#x', value: 'v' },
        { action: 'type', selector: '#x', value: 'v' },
        { action: 'click', selector: '#x' },
        { action: 'select', selector: '#x', value: 'v' },
        { action: 'wait_for', selector: '#x' },
        { action: 'wait_for_url', pattern: '**/dashboard**' },
        { action: 'frame', selector: 'iframe#auth' },
        { action: 'main_frame' },
        { action: 'popup' },
        { action: 'keyboard', key: 'Enter' },
        { action: 'evaluate', expression: 'document.title' },
        { action: 'sleep', ms: 1000 },
        { action: 'screenshot' },
        { action: 'reload' },
      ],
    };
    const result = validateLoginConfig(allActions);
    expect(result.valid).toBe(true);
  });

  it('validates otp_prompt', () => {
    const withOtp: LoginConfig = {
      ...validConfig,
      otp_prompt: { method: 'chat', field_selector: '#otp' },
    };
    expect(validateLoginConfig(withOtp).valid).toBe(true);

    const badOtp: LoginConfig = {
      ...validConfig,
      otp_prompt: { method: 'email' as any, field_selector: '#otp' },
    };
    expect(validateLoginConfig(badOtp).valid).toBe(false);
  });

  it('rejects fill without value', () => {
    const result = validateLoginConfig({
      ...validConfig,
      steps: [
        { action: 'goto', url: 'https://x.com' },
        { action: 'fill', selector: '#x' } as any,
      ],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects sleep without ms', () => {
    const result = validateLoginConfig({
      ...validConfig,
      steps: [
        { action: 'goto', url: 'https://x.com' },
        { action: 'sleep' } as any,
      ],
    });
    expect(result.valid).toBe(false);
  });
});

describe('validateKeepaliveConfig', () => {
  const validConfig: KeepaliveConfig = {
    interval_seconds: 300,
    actions: [{ action: 'reload' }],
    health_checks: [
      { type: 'url_check', url: 'https://app.example.com', expect_status: 200 },
      { type: 'dom_check', selector: '#user-menu', exists: true },
    ],
    policy: 'all',
  };

  it('accepts valid config', () => {
    expect(validateKeepaliveConfig(validConfig).valid).toBe(true);
  });

  it('rejects interval_seconds < 60', () => {
    const result = validateKeepaliveConfig({ ...validConfig, interval_seconds: 30 });
    expect(result.valid).toBe(false);
  });

  it('rejects empty health_checks', () => {
    const result = validateKeepaliveConfig({ ...validConfig, health_checks: [] });
    expect(result.valid).toBe(false);
  });

  it('requires quorum_n when policy is quorum', () => {
    const result = validateKeepaliveConfig({ ...validConfig, policy: 'quorum' });
    expect(result.valid).toBe(false);

    const withQuorum = validateKeepaliveConfig({ ...validConfig, policy: 'quorum', quorum_n: 1 });
    expect(withQuorum.valid).toBe(true);
  });
});

describe('validateExportPolicy', () => {
  const validConfig: ExportPolicy = {
    artifact_types: ['cookies', 'headers'],
    encryption: { algo: 'AES-256-GCM', key_ref: 'k8s:secret/key' },
    ttl_seconds: 3600,
  };

  it('accepts valid config', () => {
    expect(validateExportPolicy(validConfig).valid).toBe(true);
  });

  it('rejects ttl_seconds < 300', () => {
    expect(validateExportPolicy({ ...validConfig, ttl_seconds: 100 }).valid).toBe(false);
  });

  it('rejects invalid artifact types', () => {
    expect(validateExportPolicy({ ...validConfig, artifact_types: ['invalid'] as any }).valid).toBe(false);
  });
});

describe('validateNotificationConfig', () => {
  it('accepts valid channels', () => {
    const config: NotificationConfig = { channels: ['slack:#ops', 'teams:channel-id'] };
    expect(validateNotificationConfig(config).valid).toBe(true);
  });

  it('accepts empty channels (agent-poll mode)', () => {
    expect(validateNotificationConfig({ channels: [] }).valid).toBe(true);
  });

  it('accepts agent provider channel', () => {
    expect(validateNotificationConfig({ channels: ['agent:poll'] }).valid).toBe(true);
  });

  it('rejects invalid channel format', () => {
    expect(validateNotificationConfig({ channels: ['invalid'] }).valid).toBe(false);
  });
});

describe('validateTargetUrls', () => {
  it('accepts valid HTTPS URLs', () => {
    expect(validateTargetUrls(['https://app.example.com']).valid).toBe(true);
  });

  it('rejects HTTP URLs', () => {
    expect(validateTargetUrls(['http://app.example.com']).valid).toBe(false);
  });

  it('rejects empty array', () => {
    expect(validateTargetUrls([]).valid).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(validateTargetUrls(['not-a-url']).valid).toBe(false);
  });
});
