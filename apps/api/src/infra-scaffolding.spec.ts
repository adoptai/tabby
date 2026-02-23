import * as fs from 'fs';
import * as path from 'path';

/**
 * Adversarial tests for Phase 3 infrastructure scaffolding.
 * These verify that security infrastructure is scaffolded and documented
 * so it cannot be silently removed.
 */

const CHARTS_DIR = path.join(__dirname, '..', '..', '..', 'charts', 'browser-hitl');
const TEMPLATES_DIR = path.join(CHARTS_DIR, 'templates');

describe('Phase 3: NATS Authentication (C7)', () => {
  it('values.yaml has nats.auth.enabled toggle', () => {
    const values = fs.readFileSync(path.join(CHARTS_DIR, 'values.yaml'), 'utf-8');
    expect(values).toContain('auth:');
    expect(values).toMatch(/nats:[\s\S]*?auth:[\s\S]*?enabled:/);
  });

  it('nats-statefulset.yaml conditionally includes authorization block', () => {
    const template = fs.readFileSync(path.join(TEMPLATES_DIR, 'nats-statefulset.yaml'), 'utf-8');
    expect(template).toContain('nats.auth.enabled');
    expect(template).toContain('authorization');
    expect(template).toContain('NATS_AUTH_TOKEN');
  });

  it('secrets.yaml includes nats-auth-token', () => {
    const secrets = fs.readFileSync(path.join(TEMPLATES_DIR, 'secrets.yaml'), 'utf-8');
    expect(secrets).toContain('nats-auth-token');
  });

  it('values-production.yaml enables NATS auth', () => {
    const prod = fs.readFileSync(path.join(CHARTS_DIR, 'values-production.yaml'), 'utf-8');
    expect(prod).toMatch(/nats:[\s\S]*?auth:[\s\S]*?enabled:\s*true/);
  });
});

describe('Phase 3: TLS Scaffolding (C6)', () => {
  it('values.yaml has cert-manager annotation commented', () => {
    const values = fs.readFileSync(path.join(CHARTS_DIR, 'values.yaml'), 'utf-8');
    expect(values).toContain('cert-manager.io/cluster-issuer');
  });

  it('values-production.yaml enables TLS with cert-manager', () => {
    const prod = fs.readFileSync(path.join(CHARTS_DIR, 'values-production.yaml'), 'utf-8');
    expect(prod).toContain('cert-manager.io/cluster-issuer');
    expect(prod).toContain('ssl-redirect');
    expect(prod).toMatch(/tls:[\s\S]*?enabled:\s*true/);
  });

  it('values-local.yaml disables TLS', () => {
    const local = fs.readFileSync(path.join(CHARTS_DIR, 'values-local.yaml'), 'utf-8');
    expect(local).toMatch(/tls:[\s\S]*?enabled:\s*false/);
  });
});

describe('Phase 3: Secrets Hardening (H3)', () => {
  it('secrets.yaml uses b64enc for all sensitive values', () => {
    const secrets = fs.readFileSync(path.join(TEMPLATES_DIR, 'secrets.yaml'), 'utf-8');
    // Every value in data should use b64enc
    const dataLines = secrets.split('\n').filter((l) => l.includes('b64enc'));
    expect(dataLines.length).toBeGreaterThanOrEqual(5);
  });

  it('values-production.yaml has empty secret defaults (no hardcoded values)', () => {
    const prod = fs.readFileSync(path.join(CHARTS_DIR, 'values-production.yaml'), 'utf-8');
    // Production should have empty secret defaults
    expect(prod).toMatch(/postgresPassword:\s*""/);
    expect(prod).toMatch(/jwtSigningKey:\s*""/);
    expect(prod).toMatch(/tenantEncryptionKey:\s*""/);
  });

  it('values-local.yaml has dev-only placeholder secrets', () => {
    const local = fs.readFileSync(path.join(CHARTS_DIR, 'values-local.yaml'), 'utf-8');
    expect(local).toContain('NEVER use in production');
    expect(local).toContain('localdev');
  });
});

describe('Phase 3: Core Network Policies (H12)', () => {
  it('network-policies.yaml template exists', () => {
    expect(fs.existsSync(path.join(TEMPLATES_DIR, 'network-policies.yaml'))).toBe(true);
  });

  it('network-policies.yaml has policies for API, controller, postgres, redis, nats', () => {
    const policies = fs.readFileSync(path.join(TEMPLATES_DIR, 'network-policies.yaml'), 'utf-8');
    expect(policies).toContain('NetworkPolicy');
    expect(policies).toContain('api');
    expect(policies).toContain('controller');
    expect(policies).toContain('postgres');
    expect(policies).toContain('redis');
    expect(policies).toContain('nats');
  });

  it('network-policies.yaml is gated by networkPolicies.enabled', () => {
    const policies = fs.readFileSync(path.join(TEMPLATES_DIR, 'network-policies.yaml'), 'utf-8');
    expect(policies).toContain('networkPolicies.enabled');
  });

  it('values-production.yaml enables network policies', () => {
    const prod = fs.readFileSync(path.join(CHARTS_DIR, 'values-production.yaml'), 'utf-8');
    expect(prod).toMatch(/networkPolicies:[\s\S]*?enabled:\s*true/);
  });

  it('values-local.yaml disables network policies', () => {
    const local = fs.readFileSync(path.join(CHARTS_DIR, 'values-local.yaml'), 'utf-8');
    expect(local).toMatch(/networkPolicies:[\s\S]*?enabled:\s*false/);
  });
});

describe('Phase 3: .env.local gitignore (M11)', () => {
  it('.gitignore excludes .env.* files', () => {
    const gitignore = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '.gitignore'),
      'utf-8',
    );
    expect(gitignore).toContain('.env.*');
  });

  it('.gitignore allows .env.example', () => {
    const gitignore = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '.gitignore'),
      'utf-8',
    );
    expect(gitignore).toContain('!.env.example');
  });
});

describe('Phase 3: Two-tier values split (local vs production)', () => {
  it('values-local.yaml exists', () => {
    expect(fs.existsSync(path.join(CHARTS_DIR, 'values-local.yaml'))).toBe(true);
  });

  it('values-production.yaml exists', () => {
    expect(fs.existsSync(path.join(CHARTS_DIR, 'values-production.yaml'))).toBe(true);
  });

  it('production has higher replica counts than local', () => {
    const prod = fs.readFileSync(path.join(CHARTS_DIR, 'values-production.yaml'), 'utf-8');
    const local = fs.readFileSync(path.join(CHARTS_DIR, 'values-local.yaml'), 'utf-8');
    // Production API replicas >= 2
    expect(prod).toMatch(/api:[\s\S]*?replicas:\s*2/);
    // Local API replicas = 1
    expect(local).toMatch(/api:[\s\S]*?replicas:\s*1/);
  });
});
