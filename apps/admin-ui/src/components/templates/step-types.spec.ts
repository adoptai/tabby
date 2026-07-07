import { describe, it, expect } from 'vitest';
import { DSL_ACTIONS, ZERO_FIELD_ACTIONS, ON_FAILURE_ACTIONS, SELECTOR_VALUE_ACTIONS } from './step-types';

describe('step-types', () => {
  it('has 16 action types', () => {
    expect(DSL_ACTIONS).toHaveLength(16);
  });

  it('zero-field actions are subset of all actions', () => {
    for (const a of ZERO_FIELD_ACTIONS) {
      expect(DSL_ACTIONS).toContain(a);
    }
  });

  it('on-failure actions are subset of all actions', () => {
    for (const a of ON_FAILURE_ACTIONS) {
      expect(DSL_ACTIONS).toContain(a);
    }
  });

  it('selector-value actions are fill, type, select', () => {
    expect(SELECTOR_VALUE_ACTIONS).toEqual(['fill', 'type', 'select']);
  });
});
