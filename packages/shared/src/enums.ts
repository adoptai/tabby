// ============================================================
// Session & Baton State Enums
// ============================================================

export enum SessionState {
  STARTING = 'STARTING',
  HEALTHY = 'HEALTHY',
  UNHEALTHY = 'UNHEALTHY',
  LOGIN_NEEDED = 'LOGIN_NEEDED',
  LOGIN_IN_PROGRESS = 'LOGIN_IN_PROGRESS',
  FAILED = 'FAILED',
  TERMINATED = 'TERMINATED',
}

export enum BatonState {
  AUTOMATION_CONTROL = 'AUTOMATION_CONTROL',
  HUMAN_REQUESTED = 'HUMAN_REQUESTED',
  HUMAN_CONTROL = 'HUMAN_CONTROL',
  HUMAN_RELEASED = 'HUMAN_RELEASED',
}

export enum HealthResultType {
  PASS = 'PASS',
  TRANSIENT_FAIL = 'TRANSIENT_FAIL',
  AUTH_FAIL = 'AUTH_FAIL',
}

// ============================================================
// User & Role Enums
// ============================================================

export enum UserRole {
  ADMIN = 'Admin',
  OPERATOR = 'Operator',
  VIEWER = 'Viewer',
  AGENT = 'Agent',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

// ============================================================
// Intervention Enums
// ============================================================

export enum InterventionType {
  OTP = 'OTP',
  CAPTCHA = 'CAPTCHA',
  MANUAL = 'MANUAL',
  OTHER = 'OTHER',
}

export enum InterventionOutcome {
  SUCCESS = 'SUCCESS',
  FAIL = 'FAIL',
  TIMEOUT = 'TIMEOUT',
}

// ============================================================
// Identity & Storage Enums
// ============================================================

export enum IdentityProvider {
  SLACK = 'slack',
  TEAMS = 'teams',
}

export enum StorageBackend {
  MINIO = 'minio',
}

export enum ArtifactAccessMethod {
  PRESIGNED_URL = 'presigned_url',
  NATS = 'nats',
  API_ENVELOPE = 'api_envelope',
}

export enum AuditActorType {
  SYSTEM = 'system',
  HUMAN = 'human',
}

// ============================================================
// Login Serialization Enums (ADR-012)
// ============================================================

export enum AuthRequestState {
  RECEIVED = 'RECEIVED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

// ============================================================
// Login Queue Enums (ADR-015)
// ============================================================

export enum LoginQueueState {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  DONE = 'DONE',
  FAILED = 'FAILED',
}

// ============================================================
// Credential Contract Enums (ADR-013)
// ============================================================

export enum CredentialFreshness {
  CACHED = 'CACHED',
  EXTRACTED = 'EXTRACTED',
  ON_DEMAND = 'ON_DEMAND',
  DEGRADED = 'DEGRADED',
}

export enum CredentialVolatility {
  STABLE = 'STABLE',
  SEMI_STABLE = 'SEMI_STABLE',
  VOLATILE = 'VOLATILE',
}

// ============================================================
// Profile Version Enums (ADR-014)
// ============================================================

export enum ProfileVersionState {
  STAGING = 'STAGING',
  CANARY = 'CANARY',
  ACTIVE = 'ACTIVE',
  RETIRED = 'RETIRED',
}

// ============================================================
// Streaming Mode Enums
// ============================================================

export enum StreamingMode {
  VNC = 'vnc',
  CDP = 'cdp',
}
