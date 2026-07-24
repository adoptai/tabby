// ============================================================
// Chromium Hardening Flags (per spec section 13.2)
// ============================================================

export const CHROMIUM_FLAGS = [
  '--no-sandbox',
  '--no-first-run',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--metrics-recording-only',
  '--disable-default-apps',
  '--mute-audio',
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9222',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--enable-automation',
  '--password-store=basic',
  '--disable-component-extensions-with-background-pages',
  '--disable-client-side-phishing-detection',
  '--disable-dev-tools',
] as const;

// ============================================================
// Ports (per spec section 15.3)
// ============================================================

export const PORTS = {
  API: Number(process.env.API_PORT || 8000),
  API_WS: Number(process.env.API_PORT || 8000),  // Same server, upgraded connection at /events
  CONTROLLER_HEALTH: 8090,
  WORKER_HEALTH: 8091,
  NOVNC: 6080,
  VNC: 5900,              // localhost within pod only
  X11VNC: 5900,           // bound to 127.0.0.1
} as const;

// ============================================================
// CDP (Chrome DevTools Protocol) Ports
// ============================================================

export const CDP_PORTS = {
  CDP_RELAY: 9223,        // Worker-internal relay exposed to API
  CDP_INTERNAL: 9222,     // Chromium's debugging port (localhost only)
} as const;

// ============================================================
// CDP Screencast Limits (security: prevent parameter exhaustion)
// ============================================================

export const CDP_LIMITS = {
  MAX_FRAME_SIZE_BYTES: 65536,
  SCREENCAST_MAX_QUALITY: 80,
  SCREENCAST_MAX_WIDTH: 1920,
  SCREENCAST_MAX_HEIGHT: 1080,
  SCREENCAST_MIN_EVERY_NTH_FRAME: 1,
} as const;

// ============================================================
// Redis Key Patterns
// ============================================================

export const REDIS_KEYS = {
  humanInput: (sessionId: string, stepIndex: number) => `human_input:${sessionId}:${stepIndex}`,
  streamToken: (jti: string) => `stream_token:${jti}`,
  artifactToken: (tokenId: string) => `artifact_token:${tokenId}`,
  authReqLock: (tenantId: string, appId: string) => `auth_req_lock:${tenantId}:${appId}`,
  extractLock: (tenantId: string, profileId: string, credSetId: string) => `extract_lock:${tenantId}:${profileId}:${credSetId}`,
  extractRequest: (sessionId: string) => `extract_request:${sessionId}`,
  extractDone: (sessionId: string) => `extract_done:${sessionId}`,
  executeBrowserLock: (sessionId: string) => `execute_browser_lock:${sessionId}`,
  otp: (sessionId: string) => `otp:${sessionId}`,
  oauthState: (state: string) => `oauth:state:${state}`,
  vncShortLink: (shortId: string) => `vnc:short:${shortId}`,
  tokenRevoked: (jti: string) => `token:revoked:${jti}`,
  agentIdempotency: (tenantId: string, key: string) => `idempotency:agent:run-url:${tenantId}:${key}`,
  streamRevoked: (sessionId: string) => `stream_revoked:${sessionId}`,
  hitlAutoResolved: (sessionId: string) => `hitl_auto_resolved:${sessionId}`,
} as const;

export const REDIS_TTL = {
  HUMAN_INPUT_SECONDS: 300,
  STREAM_TOKEN_SECONDS: Number(process.env.STREAM_TTL_SECONDS) || 600,
  ARTIFACT_TOKEN_SECONDS: 600,
  EXTRACT_REQUEST_SECONDS: 60,
  EXTRACT_DONE_SECONDS: 10,
  EXECUTE_BROWSER_LOCK_SECONDS: 65,
  OTP_SECONDS: 300,
  OAUTH_STATE_SECONDS: 300,
  VNC_SHORT_LINK_SECONDS: Number(process.env.STREAM_TTL_SECONDS) || 600,
} as const;

// ============================================================
// Default Configuration Values
// ============================================================

export const DEFAULTS = {
  KEEPALIVE_INTERVAL_SECONDS: 300,
  EXPORT_TTL_SECONDS: 3600,
  EXPORT_REFRESH_INTERVAL_SECONDS: 3600,
  RECONCILE_INTERVAL_SECONDS: 15,
  MAX_SESSION_AGE_HOURS: 24,
  MEMORY_WATERMARK_GB: 2.5,
  STREAM_TTL_SECONDS: 600,
  BACKOFF_BASE_SECONDS: 30,
  JWT_TTL_HOURS: 24,
  BCRYPT_COST: 12,
  MIN_PASSWORD_LENGTH: 12,
  PAGINATION_LIMIT: 50,
  PAGINATION_OFFSET: 0,
  AUDIT_RETENTION_DAYS: 90,
  CREDENTIAL_ROTATION_REMINDER_DAYS: 90,
  MAX_SESSIONS_PER_TENANT: 10,
  ACCOUNT_LOCKOUT_THRESHOLD: 5,      // Lock after N consecutive failed logins
  ACCOUNT_LOCKOUT_DURATION_MINUTES: 15, // Lock duration in minutes
  AGENT_TOKEN_TTL_SECONDS: 3600,       // 1 hour default for agent tokens (ADR-010)
  AGENT_TOKEN_MAX_TTL_SECONDS: 86400,  // 24 hour max for agent tokens
  AGENT_TOKEN_MIN_TTL_SECONDS: 300,    // 5 minute min for agent tokens
  AGENT_RATE_LIMIT_PER_MINUTE: 30,     // Per-agent request rate limit
  AGENT_CLIENT_ID_PREFIX: 'agent_cl_',
  AGENT_SECRET_PREFIX: 'secret_sk_',
  AGENT_SECRET_LENGTH: 64,
  REDIS_PROBE_INTERVAL_MS: 5000,       // Health probe interval (ADR-011)
  REDIS_PROBE_TIMEOUT_MS: 2000,        // Probe timeout
  REDIS_DOWN_THRESHOLD: 3,             // Consecutive failures before DOWN
  REDIS_RECOVERY_THRESHOLD: 2,         // Consecutive successes before HEALTHY
  MIN_LOGIN_INTERVAL_MS: 60000,        // Barrier 3: minimum interval between logins (ADR-012)
  LOGIN_LOCK_TTL_MS: 300000,           // Barrier 1: Redis lock TTL (5 min = login_timeout + buffer)
  AUTH_REQUEST_STALE_MS: 600000,       // Auth requests older than 10 min are stale
  GLOBAL_MAX_CONCURRENT_LOGINS: 5,     // ADR-015 LIMIT 1: system-wide concurrency cap
  MAX_CONCURRENT_PER_DOMAIN: 3,        // ADR-015 LIMIT 2: per-target-domain cap (RT-06 amendment)
  QUEUE_PROCESS_INTERVAL_MS: 5000,     // Queue processing fallback polling interval
  STARTUP_STAGGER_MS: 10000,           // Delay before queue processing on startup (ADR-015)
  EXTRACT_COALESCE_WAIT_MS: 15000,     // Max wait for coalesced extraction (ADR-013)
  EXTRACT_LOCK_TTL_SECONDS: 30,        // Extract lock TTL (ADR-013 RT-11)
  CANARY_MIN_REQUESTS: 5,              // Minimum requests before canary promotion (ADR-014)
  CANARY_ERROR_RATE_THRESHOLD: 0.20,   // Max error rate for canary promotion (ADR-014)
  CANARY_MIN_SAMPLE_SIZE: 3,           // Minimum sample size for canary evaluation (ADR-014)
  PROFILE_RETENTION_DAYS: 30,          // Retired profile retention (ADR-014)
} as const;

/**
 * Warm recording-session pool. A single GLOBAL pool of pre-warmed recording pods
 * (browser up, sitting on about:blank) that a recording request claims + binds
 * in place of cold-starting a pod — cutting link provisioning from ~1-2min to
 * seconds. The pool app + its warm spares live under a well-known system tenant
 * (SYSTEM_TENANT_ID); a claim reassigns a spare to the requesting tenant's shell
 * app AND rebinds the session's tenant_id to that tenant in one transaction, so
 * the exported bundle persists to the correct per-tenant MinIO bucket.
 *
 * Cross-tenant reuse is safe: the bundle encryption key is process-wide (not
 * per-tenant), the bucket is derived from the session's tenant_id at persist
 * time, and a spare is single-use (claimed -> becomes a real recording ->
 * terminated, never re-pooled), so no data from one tenant is ever visible to
 * another. The feature is opt-in via RECORDING_POOL_TENANTS (empty = off); that
 * list now gates only WHICH tenants may claim from the shared pool — the pool
 * itself is warmed once, globally, at boot.
 */
export const RECORDING_POOL = {
  /** Well-known app name the controller/API use to find the global pool app. */
  APP_NAME: '__recording_pool__',
  /**
   * Well-known app name for the global RESIDENTIAL warm pool. Its spares boot
   * with residential_proxy_enabled so their egress is chained through the
   * residential proxy while they warm and after they're claimed. A recording
   * request that asks for residential egress claims from this pool; all other
   * requests claim from APP_NAME. Kept as a separate app (not a flag on one pool)
   * so each flavor has its own desired_session_count / warm capacity.
   */
  RESIDENTIAL_APP_NAME: '__recording_pool_residential__',
  /**
   * Sentinel tenant that owns the global pool app(s) and their unclaimed warm
   * spares. Seeded by migration 033. A claim rebinds the spare's tenant_id to the
   * real requesting tenant, so this id only ever appears on unclaimed spares.
   */
  SYSTEM_TENANT_ID: '00000000-0000-0000-0000-000000000000',
  WARM: 'WARM',
  CLAIMED: 'CLAIMED',
} as const;

/**
 * Password complexity rules (C2 remediation).
 * Minimum 12 chars, at least one uppercase, lowercase, digit, and special character.
 */
export const PASSWORD_RULES = {
  MIN_LENGTH: 12,
  REQUIRE_UPPERCASE: true,
  REQUIRE_LOWERCASE: true,
  REQUIRE_DIGIT: true,
  REQUIRE_SPECIAL: true,
  PATTERN: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{12,}$/,
  DESCRIPTION: 'Password must be at least 12 characters with uppercase, lowercase, digit, and special character',
} as const;

// ============================================================
// Rate Limits (per spec section 13.1)
// ============================================================

export const RATE_LIMITS = {
  LOGIN: { max: 5, windowSeconds: 60 },           // 5/min per IP
  STREAM: { max: 3, windowSeconds: 60 },           // 3/min per user
  DEFAULT: { max: 60, windowSeconds: 60 },          // 60/min per user
} as const;
