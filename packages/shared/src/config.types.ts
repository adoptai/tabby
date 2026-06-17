import { DslStep } from './dsl.types';

// ============================================================
// Application Configuration Types (per spec sections 10.2, 10.5)
// ============================================================

export interface ScreenshotPolicy {
  capture_on_error: boolean;    // Default: true
  redact_sensitive?: boolean;   // Default: true
}

export interface OtpPrompt {
  method: 'chat';
  field_selector: string;
  timeout_ms?: number;          // Default: 120000 (2 minutes)
}

export interface LoginConfig {
  login_url: string;
  credential_ref: string;       // Format: k8s:secret/{secret-name} | manual: (human provides creds via HITL)
  screenshot_policy?: ScreenshotPolicy;
  steps: DslStep[];
  otp_prompt?: OtpPrompt;
}

// ============================================================
// Health Check Types (per spec section 10.4)
// ============================================================

export interface UrlCheck {
  type: 'url_check';
  url: string;
  expect_status: number;
}

export interface DomCheck {
  type: 'dom_check';
  selector: string;
  exists: boolean;
}

export interface NetworkCheck {
  type: 'network_check';
  url: string;
  expect_status: number;
  body_contains?: string;
}

export type HealthCheck = UrlCheck | DomCheck | NetworkCheck;

export type HealthPolicy = 'all' | 'any' | 'quorum';

export interface KeepaliveConfig {
  interval_seconds: number;     // Must be >= 60
  actions: DslStep[];
  health_checks: HealthCheck[];
  policy?: HealthPolicy;        // Default: 'all'
  quorum_n?: number;            // Required when policy = 'quorum'
}

// ============================================================
// Export Policy Types (per spec section 10.5)
// ============================================================

export type ArtifactType =
  | 'cookies'
  | 'headers'
  | 'csrf_token'
  | 'local_storage'
  | 'session_storage';

export interface EncryptionConfig {
  algo: 'AES-256-GCM';
  key_ref: string;              // Format: k8s:secret/{secret-name}
}

export interface ExportPolicy {
  artifact_types: ArtifactType[];
  encryption: EncryptionConfig;
  ttl_seconds: number;                    // Must be >= 300
  refresh_interval_seconds?: number;      // Default: 3600
  header_allowlist?: string[];            // Response headers (captured via page.on('response'))
  request_header_allowlist?: string[];    // Outbound request headers (captured via page.on('request'))
}

// ============================================================
// Notification Config Types (per spec section 10.5)
// ============================================================

export interface EscalationConfig {
  after_minutes: number;
  notify: string[];             // Format: {provider}:{reference}
}

export interface NotificationConfig {
  channels?: string[];           // Format: {provider}:{reference}. Empty/omitted = silent/poll-only.
  escalation?: EscalationConfig;
}

// ============================================================
// Browser Policy Types (per spec section 7.16)
// ============================================================

export interface BrowserPolicy {
  downloads: boolean;           // Default: false
  clipboard: boolean;           // Default: false
  file_chooser: boolean;        // Default: false
  /**
   * When set, the worker runs in VNC recording mode: ambient HAR + DOM
   * interaction capture for a human-driven session, keepalive actions are
   * suppressed, and POST /recording/stop drains a RecordingBundle.
   * Undefined for normal (non-recording) sessions.
   */
  recording_mode?: 'login' | 'workflow';
}

export const DEFAULT_BROWSER_POLICY: BrowserPolicy = {
  downloads: false,
  clipboard: false,
  file_chooser: false,
};
