import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * `credential_ref` scheme for apps whose portal username/password arrive with
 * `POST /credentials/request` (the Adopt harness resolves them from the org
 * secret vault). The API stores the pair encrypted on the app row, the
 * controller mints a per-session K8s Secret from it, and the worker reads that
 * Secret exactly like a `k8s:secret/` mount. The login DSL is unchanged.
 */
export const HARNESS_CREDENTIAL_REF = 'harness:';

export interface LoginCredentials {
  username: string;
  password: string;
}

export function isHarnessCredentialRef(ref: unknown): boolean {
  return typeof ref === 'string' && ref.startsWith(HARNESS_CREDENTIAL_REF);
}

/** The per-session Secret the controller creates before the worker pod and deletes with it. */
export function harnessCredentialSecretName(sessionId: string): string {
  return `harness-creds-${sessionId.toLowerCase()}`;
}

/**
 * `escstatement@loc007` → `escstatement`. A per-account profile id falls back to
 * the template whose `profile_name_pattern` is the part before `@`, so one
 * template serves every account of a portal.
 */
export function profileBaseName(profileId: string): string {
  const at = profileId.indexOf('@');
  return at > 0 ? profileId.slice(0, at) : profileId;
}

// Layout: iv(12) + tag(16) + ciphertext, base64url — same as oauth-provider.service.ts.
export function encryptLoginCredentials(creds: LoginCredentials, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify({ username: creds.username, password: creds.password });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function decryptLoginCredentials(blob: string, keyHex: string): LoginCredentials {
  const key = Buffer.from(keyHex, 'hex');
  const buf = Buffer.from(blob, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const json = decipher.update(buf.subarray(28)) + decipher.final('utf8');
  const parsed = JSON.parse(json) as Partial<LoginCredentials>;
  if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
    throw new Error('Stored login credentials are malformed');
  }
  return { username: parsed.username, password: parsed.password };
}
