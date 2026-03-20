// ============================================================
// Login DSL Action Types (15 actions per spec section 10.3)
// ============================================================

export type HumanInputType = 'otp' | 'email' | 'password' | 'captcha' | 'verification_code' | 'url' | 'confirm';

export type DslActionType =
  | 'goto'
  | 'fill'
  | 'type'
  | 'click'
  | 'select'
  | 'wait_for'
  | 'wait_for_url'
  | 'frame'
  | 'main_frame'
  | 'popup'
  | 'keyboard'
  | 'evaluate'
  | 'sleep'
  | 'screenshot'
  | 'reload'
  | 'request_human_input';

export type FailureHandler =
  | { action: 'request_help'; message: string; input_type?: HumanInputType; field_selector?: string; screenshot?: boolean }
  | { action: 'skip' }
  | { action: 'abort' };

export interface BaseDslStep {
  action: DslActionType;
  timeout_ms?: number;        // Default: 30000
  retry_count?: number;       // Default: 1
  sensitive?: boolean;        // Default: false. True for password/OTP steps
  retry_backoff?: 'fixed' | 'exponential';  // Default: 'fixed'
  retry_delay_ms?: number;    // Default: 1000
  retry_max_delay_ms?: number; // Default: 30000 (exponential cap)
  on_failure?: FailureHandler;
}

export interface GotoStep extends BaseDslStep {
  action: 'goto';
  url: string;
}

export interface FillStep extends BaseDslStep {
  action: 'fill';
  selector: string;
  value: string;            // Supports ${USERNAME}, ${PASSWORD} variable interpolation
}

export interface TypeStep extends BaseDslStep {
  action: 'type';
  selector: string;
  value: string;
}

export interface ClickStep extends BaseDslStep {
  action: 'click';
  selector: string;
}

export interface SelectStep extends BaseDslStep {
  action: 'select';
  selector: string;
  value: string;
}

export interface WaitForStep extends BaseDslStep {
  action: 'wait_for';
  selector: string;
  timeout_ms?: number;
}

export interface WaitForUrlStep extends BaseDslStep {
  action: 'wait_for_url';
  pattern: string;          // Regex or glob
  timeout_ms?: number;
}

export interface FrameStep extends BaseDslStep {
  action: 'frame';
  selector: string;
}

export interface MainFrameStep extends BaseDslStep {
  action: 'main_frame';
}

export interface PopupStep extends BaseDslStep {
  action: 'popup';
  timeout_ms?: number;
}

export interface KeyboardStep extends BaseDslStep {
  action: 'keyboard';
  key: string;              // e.g., 'Enter', 'Tab', 'Escape'
}

export interface EvaluateStep extends BaseDslStep {
  action: 'evaluate';
  expression: string;
}

export interface SleepStep extends BaseDslStep {
  action: 'sleep';
  ms: number;
}

export interface ScreenshotStep extends BaseDslStep {
  action: 'screenshot';
}

export interface ReloadStep extends BaseDslStep {
  action: 'reload';
}

export interface RequestHumanInputStep extends BaseDslStep {
  action: 'request_human_input';
  input_type: HumanInputType;
  label: string;
  field_selector?: string;
  submit_selector?: string;
  placeholder?: string;
  sensitive?: boolean;
}

export type DslStep =
  | GotoStep
  | FillStep
  | TypeStep
  | ClickStep
  | SelectStep
  | WaitForStep
  | WaitForUrlStep
  | FrameStep
  | MainFrameStep
  | PopupStep
  | KeyboardStep
  | EvaluateStep
  | SleepStep
  | ScreenshotStep
  | ReloadStep
  | RequestHumanInputStep;

/** Metadata for a pending human input request, stored on session + passed via NATS. */
export interface InputRequest {
  input_type: HumanInputType;
  label: string;
  placeholder?: string;
  sensitive?: boolean;
  step_index: number;
}
