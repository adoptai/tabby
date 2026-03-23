import { readFile } from 'fs/promises';
import { join } from 'path';

export interface ResolvedCredentials {
  username: string;
  password: string;
}

/**
 * Resolve credentials from a credential_ref string.
 * Formats:
 *   k8s:secret/{secret-name} — read from mounted K8s secret files
 *   manual:                  — no pre-provisioned creds; DSL must use request_human_input steps to collect and fill credentials
 */
export async function resolveCredentials(credentialRef: string): Promise<ResolvedCredentials> {
  if (credentialRef.startsWith('manual:')) {
    return { username: '', password: '' };
  }

  const secretName = credentialRef.replace('k8s:secret/', '').trim();
  if (!secretName) {
    throw new Error(`Invalid credential_ref: ${credentialRef}`);
  }

  const mountRoot = process.env.CREDENTIALS_MOUNT_PATH || '/var/run/secrets/browser-hitl';
  const mountDir = join(mountRoot, secretName);

  // Primary path: mounted secret files (username/password)
  const usernameFromFile = await readOptionalTrimmedFile(join(mountDir, 'username'));
  const passwordFromFile = await readOptionalTrimmedFile(join(mountDir, 'password'));
  if (usernameFromFile && passwordFromFile) {
    return { username: usernameFromFile, password: passwordFromFile };
  }

  const allowEnvFallback = (process.env.WORKER_ALLOW_ENV_CREDENTIAL_FALLBACK || '')
    .trim()
    .toLowerCase() === 'true';
  if (!allowEnvFallback) {
    throw new Error(
      `Credentials not found for ${credentialRef}. Expected mounted files at ${mountDir}/{username,password}.`,
    );
  }

  // Explicit opt-in fallback for local development only.
  const username = process.env[`${secretName}_USERNAME`] || '';
  const password = process.env[`${secretName}_PASSWORD`] || '';

  if (!username || !password) {
    throw new Error(
      `Credentials not found for ${credentialRef}. Checked ${mountDir}/{username,password} and explicit env fallback.`,
    );
  }

  return { username, password };
}

async function readOptionalTrimmedFile(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, 'utf8');
    const value = content.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
