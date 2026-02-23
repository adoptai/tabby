// ============================================================
// Login DSL Action Types (15 actions per spec section 10.3)
// ============================================================

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
  | 'reload';

export interface BaseDslStep {
  action: DslActionType;
  timeout_ms?: number;      // Default: 30000
  retry_count?: number;     // Default: 1
  sensitive?: boolean;      // Default: false. True for password/OTP steps
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
  | ReloadStep;
