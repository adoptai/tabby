/**
 * Service Profile Version State Machine (ADR-014).
 *
 * Follows the same pattern as SESSION_TRANSITIONS in state-machine.ts.
 *
 * Lifecycle: STAGING → CANARY → ACTIVE → RETIRED
 *
 * Rollback paths:
 *   CANARY → STAGING  (reset counters, demote)
 *   ACTIVE → RETIRED  (rollback to parent version)
 */

import { ProfileVersionState } from './enums';

// ============================================================
// State Transitions
// ============================================================

export const PROFILE_VERSION_TRANSITIONS: Record<ProfileVersionState, ProfileVersionState[]> = {
  [ProfileVersionState.STAGING]: [
    ProfileVersionState.CANARY,
  ],
  [ProfileVersionState.CANARY]: [
    ProfileVersionState.ACTIVE,
    ProfileVersionState.STAGING,   // Rollback
  ],
  [ProfileVersionState.ACTIVE]: [
    ProfileVersionState.RETIRED,
  ],
  [ProfileVersionState.RETIRED]: [], // Terminal state
};

/**
 * Validate whether a profile version state transition is allowed.
 */
export function isValidProfileTransition(from: ProfileVersionState, to: ProfileVersionState): boolean {
  return PROFILE_VERSION_TRANSITIONS[from]?.includes(to) ?? false;
}
