import { HealthResultType } from './enums';
import { HealthCheck, HealthPolicy } from './config.types';

// ============================================================
// Health Predicate Evaluation Types (per spec section 10.4)
// ============================================================

export interface HealthCheckResult {
  check: HealthCheck;
  result: HealthResultType;
  detail?: string;              // Optional diagnostic detail
  duration_ms: number;
}

export interface HealthEvaluationResult {
  overall: HealthResultType;
  checks: HealthCheckResult[];
  policy: HealthPolicy;
  evaluated_at: string;         // ISO 8601
}

/**
 * Evaluate health check results according to the configured policy.
 *
 * Policy semantics:
 * - 'all': all checks must PASS
 * - 'any': at least one check must PASS
 * - 'quorum': at least quorum_n checks must PASS
 *
 * Result type priority:
 * - If any check returns AUTH_FAIL, overall is AUTH_FAIL (unless overridden by policy)
 * - If any check returns TRANSIENT_FAIL (and no AUTH_FAIL), overall is TRANSIENT_FAIL
 * - Otherwise PASS
 */
export function evaluateHealthPolicy(
  results: HealthCheckResult[],
  policy: HealthPolicy,
  quorumN?: number,
): HealthResultType {
  if (results.length === 0) {
    return HealthResultType.PASS;
  }

  const passCount = results.filter(r => r.result === HealthResultType.PASS).length;
  const hasAuthFail = results.some(r => r.result === HealthResultType.AUTH_FAIL);
  const hasTransientFail = results.some(r => r.result === HealthResultType.TRANSIENT_FAIL);

  switch (policy) {
    case 'all': {
      if (passCount === results.length) return HealthResultType.PASS;
      if (hasAuthFail) return HealthResultType.AUTH_FAIL;
      return HealthResultType.TRANSIENT_FAIL;
    }
    case 'any': {
      if (passCount > 0) return HealthResultType.PASS;
      if (hasAuthFail) return HealthResultType.AUTH_FAIL;
      return HealthResultType.TRANSIENT_FAIL;
    }
    case 'quorum': {
      const n = quorumN ?? Math.ceil(results.length / 2);
      if (passCount >= n) return HealthResultType.PASS;
      if (hasAuthFail) return HealthResultType.AUTH_FAIL;
      return HealthResultType.TRANSIENT_FAIL;
    }
    default:
      return HealthResultType.TRANSIENT_FAIL;
  }
}
