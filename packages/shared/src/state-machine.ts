import { SessionState, BatonState } from './enums';

// ============================================================
// Session State Machine (per spec section 9.1)
// ============================================================

/**
 * Valid session state transitions per the spec.
 * Key = from state, Value = set of allowed "to" states.
 * TERMINATED is terminal - no outbound transitions.
 */
export const SESSION_TRANSITIONS: Record<SessionState, SessionState[]> = {
  [SessionState.STARTING]: [
    SessionState.HEALTHY,
    SessionState.LOGIN_NEEDED,
    SessionState.FAILED,
    SessionState.TERMINATED,
  ],
  [SessionState.HEALTHY]: [
    SessionState.UNHEALTHY,
    SessionState.TERMINATED,
  ],
  [SessionState.UNHEALTHY]: [
    SessionState.HEALTHY,
    SessionState.LOGIN_NEEDED,
    SessionState.TERMINATED,
  ],
  [SessionState.LOGIN_NEEDED]: [
    SessionState.LOGIN_IN_PROGRESS,
    SessionState.TERMINATED,
  ],
  [SessionState.LOGIN_IN_PROGRESS]: [
    SessionState.HEALTHY,
    SessionState.FAILED,
    SessionState.TERMINATED,
  ],
  [SessionState.FAILED]: [
    SessionState.STARTING,
    SessionState.TERMINATED,
  ],
  [SessionState.TERMINATED]: [],  // Terminal state - no outbound transitions
};

/**
 * Validate whether a session state transition is allowed.
 */
export function isValidSessionTransition(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================
// HITL Baton State Machine (per spec section 9.2)
// ============================================================

/**
 * Valid baton state transitions per the spec.
 */
export const BATON_TRANSITIONS: Record<BatonState, BatonState[]> = {
  [BatonState.AUTOMATION_CONTROL]: [
    BatonState.HUMAN_REQUESTED,
  ],
  [BatonState.HUMAN_REQUESTED]: [
    BatonState.HUMAN_CONTROL,
    BatonState.AUTOMATION_CONTROL,    // Timeout fallback
  ],
  [BatonState.HUMAN_CONTROL]: [
    BatonState.HUMAN_RELEASED,
  ],
  [BatonState.HUMAN_RELEASED]: [
    BatonState.AUTOMATION_CONTROL,
  ],
};

/**
 * Validate whether a baton state transition is allowed.
 */
export function isValidBatonTransition(from: BatonState, to: BatonState): boolean {
  return BATON_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================
// Timeouts (per spec sections 9.1, 9.2)
// ============================================================

export const SESSION_TIMEOUTS = {
  LOGIN_IN_PROGRESS_TIMEOUT_MS: 10 * 60 * 1000,       // 10 minutes
  UNHEALTHY_ESCALATION_DELAY_MS: 2 * 60 * 1000,       // 2 minutes before LOGIN_NEEDED
  HITL_PAUSE_DURATION_MS: 30 * 60 * 1000,             // 30 minutes pause after 3 failures
  HITL_MAX_ATTEMPTS_BEFORE_PAUSE: 3,
} as const;

export const BATON_TIMEOUTS = {
  HUMAN_REQUESTED_TIMEOUT_MS: 10 * 60 * 1000,         // 10 minutes
  HUMAN_CONTROL_INACTIVITY_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
} as const;

// ============================================================
// Retry Matrix (per spec section 9.4)
// ============================================================

export const RETRY_MATRIX = {
  STARTING: { maxAttempts: 3, backoff: true },
  UNHEALTHY_TRANSIENT: { maxAttempts: 3, backoff: true },
  UNHEALTHY_AUTH: { maxAttempts: 1, backoff: false },
  LOGIN_IN_PROGRESS: { maxAttempts: 3, backoff: true },
  FAILED: { maxAttempts: 0, backoff: false },          // Requires operator acknowledgement
} as const;

export const BACKOFF_DEFAULTS = {
  BASE_DELAY_MS: 30 * 1000,           // 30 seconds
  MULTIPLIER: 2,
  MAX_DELAY_MS: 30 * 60 * 1000,       // 30 minutes
  MAX_LOGIN_ATTEMPTS_PER_HOUR: 5,
} as const;
