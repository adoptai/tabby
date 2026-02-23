type RequiredEnvOptions = {
  testDefault?: string;
};

/**
 * Resolve an environment variable in a fail-closed manner.
 * Test environments can opt into an explicit deterministic fallback.
 */
export function requireEnv(name: string, options: RequiredEnvOptions = {}): string {
  const value = (process.env[name] || '').trim();
  if (value.length > 0) {
    return value;
  }

  if ((process.env.NODE_ENV || '').trim() === 'test' && typeof options.testDefault === 'string') {
    return options.testDefault;
  }

  throw new Error(`${name} must be configured`);
}

export type EnvVarSpec = {
  name: string;
  required?: boolean;
  default?: string;
  pattern?: RegExp;
  description?: string;
};

/**
 * Validate a set of environment variables at startup.
 * Collects ALL errors before throwing, so the operator sees every missing var at once.
 * Call this at the top of each service's bootstrap() before any NestJS/Express setup.
 */
export function validateEnv(specs: EnvVarSpec[]): Record<string, string> {
  const isTest = (process.env.NODE_ENV || '').trim() === 'test';
  const errors: string[] = [];
  const resolved: Record<string, string> = {};

  for (const spec of specs) {
    const raw = (process.env[spec.name] || '').trim();
    const value = raw || spec.default || '';

    if (spec.required && !value && !isTest) {
      errors.push(`  ${spec.name}: MISSING${spec.description ? ` — ${spec.description}` : ''}`);
      continue;
    }

    if (value && spec.pattern && !spec.pattern.test(value)) {
      errors.push(`  ${spec.name}: INVALID (must match ${spec.pattern})${spec.description ? ` — ${spec.description}` : ''}`);
      continue;
    }

    resolved[spec.name] = value;
  }

  if (errors.length > 0) {
    throw new Error(
      `Environment validation failed:\n${errors.join('\n')}\n\nSet these variables in .env.local or Helm values before starting.`,
    );
  }

  return resolved;
}

