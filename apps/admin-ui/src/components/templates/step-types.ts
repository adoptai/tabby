export const DSL_ACTIONS = [
  'goto',
  'fill',
  'type',
  'click',
  'select',
  'wait_for',
  'wait_for_url',
  'frame',
  'main_frame',
  'popup',
  'keyboard',
  'evaluate',
  'sleep',
  'screenshot',
  'reload',
  'request_human_input',
] as const;

export type DslAction = (typeof DSL_ACTIONS)[number];

export const ZERO_FIELD_ACTIONS: DslAction[] = ['screenshot', 'reload', 'main_frame', 'popup'];
export const SELECTOR_VALUE_ACTIONS: DslAction[] = ['fill', 'type', 'select'];
export const SELECTOR_ONLY_ACTIONS: DslAction[] = ['click', 'wait_for', 'frame'];
export const ON_FAILURE_ACTIONS: DslAction[] = ['goto', 'fill', 'click', 'wait_for', 'wait_for_url'];

export const HUMAN_INPUT_TYPES = [
  'otp',
  'email',
  'password',
  'captcha',
  'verification_code',
  'url',
  'confirm',
] as const;

export type HumanInputType = (typeof HUMAN_INPUT_TYPES)[number];

export interface StepData {
  action: DslAction;
  [key: string]: unknown;
  _rest?: Record<string, unknown>;
}

export const COMMON_OPTION_KEYS = [
  'timeout_ms',
  'retry_count',
  'sensitive',
  'retry_backoff',
  'retry_delay_ms',
  'retry_max_delay_ms',
] as const;

export const ON_FAILURE_KEY = 'on_failure';

/** Keys that are serialized from StepData directly (not unknown extra keys). */
export const INTERNAL_KEYS = new Set(['action', '_rest']);
