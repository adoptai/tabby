import {
  agentProfileAllowed,
  decryptLoginCredentials,
  encryptLoginCredentials,
  harnessCredentialSecretName,
  isHarnessCredentialRef,
  profileBaseName,
} from './login-credentials';
import { validateLoginConfig } from './dsl.validator';

const KEY = '0'.repeat(64);

describe('login-credentials', () => {
  it('round-trips a username/password pair', () => {
    const blob = encryptLoginCredentials({ username: 'provider-1', password: 'p@ss word' }, KEY);
    expect(blob).not.toContain('provider-1');
    expect(blob).not.toContain('p@ss');
    expect(decryptLoginCredentials(blob, KEY)).toEqual({ username: 'provider-1', password: 'p@ss word' });
  });

  it('rejects a blob encrypted under another key', () => {
    const blob = encryptLoginCredentials({ username: 'u', password: 'p' }, KEY);
    expect(() => decryptLoginCredentials(blob, '1'.repeat(64))).toThrow();
  });

  it('derives the template name from a per-account profile id', () => {
    expect(profileBaseName('escstatement@LOC007')).toBe('escstatement');
    expect(profileBaseName('escstatement')).toBe('escstatement');
    expect(profileBaseName('@odd')).toBe('@odd');
  });

  it('allows an agent on the base pattern or the exact id', () => {
    expect(agentProfileAllowed(['escstatement'], 'escstatement@loc007')).toBe(true);
    expect(agentProfileAllowed(['escstatement'], 'escstatement')).toBe(true);
    expect(agentProfileAllowed(['escstatement@loc007'], 'escstatement@loc007')).toBe(true);
    expect(agentProfileAllowed(['escstatement@loc007'], 'escstatement')).toBe(false);
    expect(agentProfileAllowed(['other'], 'escstatement@loc007')).toBe(false);
  });

  it('names the per-session secret from the session id', () => {
    expect(harnessCredentialSecretName('ABC-123')).toBe('harness-creds-abc-123');
  });

  it('recognises the harness: scheme', () => {
    expect(isHarnessCredentialRef('harness:')).toBe(true);
    expect(isHarnessCredentialRef('k8s:secret/x')).toBe(false);
    expect(isHarnessCredentialRef(undefined)).toBe(false);
  });

  it('is accepted by validateLoginConfig', () => {
    const result = validateLoginConfig({
      login_url: 'https://example.test/login',
      credential_ref: 'harness:',
      steps: [{ action: 'goto', url: 'https://example.test/login' }],
    } as any);
    expect(result.errors.filter(e => e.path === 'credential_ref')).toEqual([]);
  });
});
