import { SessionState, BatonState } from './enums';
import {
  isValidSessionTransition,
  isValidBatonTransition,
  SESSION_TRANSITIONS,
  BATON_TRANSITIONS,
} from './state-machine';

describe('Session State Machine', () => {
  // All 11 valid transitions per spec section 9.1
  const validTransitions: [SessionState, SessionState][] = [
    [SessionState.STARTING, SessionState.HEALTHY],
    [SessionState.STARTING, SessionState.LOGIN_NEEDED],
    [SessionState.STARTING, SessionState.FAILED],
    [SessionState.HEALTHY, SessionState.UNHEALTHY],
    [SessionState.UNHEALTHY, SessionState.HEALTHY],
    [SessionState.UNHEALTHY, SessionState.LOGIN_NEEDED],
    [SessionState.LOGIN_NEEDED, SessionState.LOGIN_IN_PROGRESS],
    [SessionState.LOGIN_IN_PROGRESS, SessionState.HEALTHY],
    [SessionState.LOGIN_IN_PROGRESS, SessionState.FAILED],
    [SessionState.FAILED, SessionState.STARTING],
    // Any -> TERMINATED (counted as individual transitions)
    [SessionState.STARTING, SessionState.TERMINATED],
    [SessionState.HEALTHY, SessionState.TERMINATED],
    [SessionState.UNHEALTHY, SessionState.TERMINATED],
    [SessionState.LOGIN_NEEDED, SessionState.TERMINATED],
    [SessionState.LOGIN_IN_PROGRESS, SessionState.TERMINATED],
    [SessionState.FAILED, SessionState.TERMINATED],
  ];

  it.each(validTransitions)(
    'allows transition from %s to %s',
    (from, to) => {
      expect(isValidSessionTransition(from, to)).toBe(true);
    },
  );

  // TERMINATED is terminal - no outbound transitions
  it('TERMINATED has no outbound transitions', () => {
    expect(SESSION_TRANSITIONS[SessionState.TERMINATED]).toEqual([]);
    for (const state of Object.values(SessionState)) {
      expect(isValidSessionTransition(SessionState.TERMINATED, state)).toBe(false);
    }
  });

  // Invalid transitions
  const invalidTransitions: [SessionState, SessionState][] = [
    [SessionState.HEALTHY, SessionState.STARTING],
    [SessionState.HEALTHY, SessionState.FAILED],
    [SessionState.HEALTHY, SessionState.LOGIN_NEEDED],
    [SessionState.STARTING, SessionState.LOGIN_IN_PROGRESS],
    [SessionState.FAILED, SessionState.HEALTHY],
    [SessionState.LOGIN_NEEDED, SessionState.HEALTHY],
    [SessionState.LOGIN_NEEDED, SessionState.FAILED],
  ];

  it.each(invalidTransitions)(
    'rejects transition from %s to %s',
    (from, to) => {
      expect(isValidSessionTransition(from, to)).toBe(false);
    },
  );
});

describe('Baton State Machine', () => {
  // All 6 valid transitions per spec section 9.2
  const validTransitions: [BatonState, BatonState][] = [
    [BatonState.AUTOMATION_CONTROL, BatonState.HUMAN_REQUESTED],
    [BatonState.HUMAN_REQUESTED, BatonState.HUMAN_CONTROL],
    [BatonState.HUMAN_REQUESTED, BatonState.AUTOMATION_CONTROL],
    [BatonState.HUMAN_CONTROL, BatonState.HUMAN_RELEASED],
    [BatonState.HUMAN_RELEASED, BatonState.AUTOMATION_CONTROL],
  ];

  it.each(validTransitions)(
    'allows transition from %s to %s',
    (from, to) => {
      expect(isValidBatonTransition(from, to)).toBe(true);
    },
  );

  // Invalid transitions
  const invalidTransitions: [BatonState, BatonState][] = [
    [BatonState.AUTOMATION_CONTROL, BatonState.HUMAN_CONTROL],
    [BatonState.AUTOMATION_CONTROL, BatonState.HUMAN_RELEASED],
    [BatonState.HUMAN_CONTROL, BatonState.AUTOMATION_CONTROL],
    [BatonState.HUMAN_CONTROL, BatonState.HUMAN_REQUESTED],
    [BatonState.HUMAN_RELEASED, BatonState.HUMAN_REQUESTED],
    [BatonState.HUMAN_RELEASED, BatonState.HUMAN_CONTROL],
  ];

  it.each(invalidTransitions)(
    'rejects transition from %s to %s',
    (from, to) => {
      expect(isValidBatonTransition(from, to)).toBe(false);
    },
  );
});
