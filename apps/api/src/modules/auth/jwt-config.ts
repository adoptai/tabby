const TEST_FALLBACK_SIGNING_KEY = 'test-jwt-signing-key-minimum-32-characters-long';

/**
 * Resolve JWT signing key in a fail-closed way.
 * Test environments receive an explicit stable key to keep unit tests hermetic.
 */
export function resolveJwtSigningKey(): string {
  const configured = (process.env.JWT_SIGNING_KEY || '').trim();
  if (configured) {
    return configured;
  }

  if ((process.env.NODE_ENV || '').trim() === 'test') {
    return TEST_FALLBACK_SIGNING_KEY;
  }

  throw new Error('JWT_SIGNING_KEY must be configured');
}

