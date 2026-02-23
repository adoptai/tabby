/**
 * Redis health monitoring types (ADR-011: Redis Resilience and Tiered Failure Modes).
 */

/**
 * Health state machine states for Redis connectivity.
 *
 * Transitions:
 * - HEALTHY → DEGRADED: on first probe failure
 * - DEGRADED → DOWN: after REDIS_DOWN_THRESHOLD consecutive failures
 * - DOWN → DEGRADED: on first probe success
 * - DEGRADED → HEALTHY: after REDIS_RECOVERY_THRESHOLD consecutive successes
 */
export enum RedisHealthState {
  HEALTHY = 'HEALTHY',
  DEGRADED = 'DEGRADED',
  DOWN = 'DOWN',
}

/**
 * Failure tier classification for Redis operations (ADR-011).
 *
 * | Tier         | HEALTHY  | DEGRADED             | DOWN                |
 * |--------------|----------|----------------------|---------------------|
 * | SECURITY     | proceed  | proceed (warn)       | deny (fail-closed)  |
 * | CONSISTENCY  | proceed  | skip (safe defaults) | skip (safe defaults) |
 * | AVAILABILITY | proceed  | proceed (warn)       | skip (fail-open)    |
 */
export enum RedisFailureTier {
  /** Fail-closed when DOWN: deny all operations (token blacklist, session locks) */
  SECURITY = 'SECURITY',
  /** Grace period with safe defaults when DEGRADED/DOWN (idempotency, rate limits) */
  CONSISTENCY = 'CONSISTENCY',
  /** Fail-open when DOWN: skip operation (OTP relay, dashboard metrics) */
  AVAILABILITY = 'AVAILABILITY',
}

/**
 * Tier classification for all Redis key categories (ADR-011).
 */
export const REDIS_TIER_CLASSIFICATION: Record<string, RedisFailureTier> = {
  'token:revoked':     RedisFailureTier.SECURITY,
  'stream_token':      RedisFailureTier.SECURITY,
  'artifact_token':    RedisFailureTier.SECURITY,
  'session_lock':      RedisFailureTier.SECURITY,
  'auth_req_lock':     RedisFailureTier.SECURITY,
  'otp':               RedisFailureTier.AVAILABILITY,
  'idempotency':       RedisFailureTier.CONSISTENCY,
  'credential_cache':  RedisFailureTier.CONSISTENCY,
  'rate_limit':        RedisFailureTier.CONSISTENCY,
  'login_queue':       RedisFailureTier.CONSISTENCY,
  'dashboard_metrics': RedisFailureTier.AVAILABILITY,
  'extract_lock':      RedisFailureTier.CONSISTENCY,
};
