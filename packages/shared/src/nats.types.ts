// ============================================================
// NATS Subject Definitions (per spec section 11.4)
// ============================================================

/**
 * NATS subject naming: action tokens are single tokens (no dots).
 * Hyphens for compound actions (e.g., otp-requested not otp.requested).
 * All subjects include tenant_id for ACL scoping.
 */
export const NATS_SUBJECTS = {
  /** Artifact export metadata */
  authBundleExported: (tenantId: string, appId: string) =>
    `auth.bundle.exported.${tenantId}.${appId}`,

  /** Session state transitions */
  sessionStateChanged: (tenantId: string, sessionId: string) =>
    `session.state.changed.${tenantId}.${sessionId}`,

  /** HITL request initiated */
  hitlStarted: (tenantId: string, sessionId: string) =>
    `hitl.started.${tenantId}.${sessionId}`,

  /** HITL completed */
  hitlCompleted: (tenantId: string, sessionId: string) =>
    `hitl.completed.${tenantId}.${sessionId}`,

  /** OTP needed from human */
  hitlOtpRequested: (tenantId: string, sessionId: string) =>
    `hitl.otp-requested.${tenantId}.${sessionId}`,
} as const;

// ============================================================
// NATS Event Payloads
// ============================================================

export interface SessionStateChangedEvent {
  type: 'session.state.changed';
  timestamp: string;
  payload: {
    session_id: string;
    tenant_id: string;
    app_id: string;
    old_state: string;
    new_state: string;
  };
}

export interface HitlStartedEvent {
  type: 'hitl.started';
  timestamp: string;
  payload: {
    session_id: string;
    tenant_id: string;
    app_id: string;
    reason: string;
    intervention_id: string;
  };
}

export interface HitlCompletedEvent {
  type: 'hitl.completed';
  timestamp: string;
  payload: {
    session_id: string;
    tenant_id: string;
    app_id: string;
    intervention_id: string;
    outcome: string;
  };
}

export interface HitlOtpRequestedEvent {
  type: 'hitl.otp-requested';
  timestamp: string;
  payload: {
    session_id: string;
    tenant_id: string;
    app_id: string;
    app_name: string;
  };
}

export interface AuthBundleExportedEvent {
  type: 'auth.bundle.exported';
  timestamp: string;
  payload: {
    app_id: string;
    session_id: string;
    tenant_id: string;
    exported_at: string;
    expires_at: string;
    artifact_bundle_ref: string;
    key_version: string;
  };
}

export type NatsEvent =
  | SessionStateChangedEvent
  | HitlStartedEvent
  | HitlCompletedEvent
  | HitlOtpRequestedEvent
  | AuthBundleExportedEvent;
