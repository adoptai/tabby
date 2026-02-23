// ============================================================
// API Request/Response Types (per spec section 11.1, 11.2)
// ============================================================

// Standard paginated response wrapper
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// Standard error response
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// Error codes
export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

// ============================================================
// Auth
// ============================================================

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  expires_at: string;
}

// ============================================================
// Tenants
// ============================================================

export interface CreateTenantRequest {
  name: string;
}

export interface CreateTenantResponse {
  tenant_id: string;
}

// ============================================================
// Users
// ============================================================

export interface CreateUserRequest {
  email: string;
  password: string;
  role: string;
  tenant_id: string;
}

export interface CreateUserResponse {
  user_id: string;
}

// ============================================================
// Applications
// ============================================================

export interface CreateAppRequest {
  name: string;
  target_urls: string[];
  login_config: Record<string, unknown>;
  keepalive_config: Record<string, unknown>;
  export_policy: Record<string, unknown>;
  notification_config: Record<string, unknown>;
  desired_session_count?: number;
  browser_policy?: Record<string, unknown>;
}

export interface CreateAppResponse {
  app_id: string;
}

// ============================================================
// Sessions
// ============================================================

export interface ScaleSessionsRequest {
  desired_sessions: number;
}

// ============================================================
// HITL
// ============================================================

export interface StreamResponse {
  url: string;
  expires_at: string;
}

export interface TakeoverResponse {
  baton_state: string;
  expires_at: string;
}

export interface ReleaseResponse {
  baton_state: string;
}

export interface OtpRequest {
  otp_value: string;
}

export interface OtpResponse {
  status: 'delivered';
}

export interface AcknowledgeResponse {
  state: string;
}

// ============================================================
// Artifacts
// ============================================================

export interface ArtifactResponse {
  presigned_url: string;
  download_url?: string;
  token_id: string;
  expires_at: string;
}

// ============================================================
// WebSocket Events (per spec section 11.6)
// ============================================================

export interface WsEvent {
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
