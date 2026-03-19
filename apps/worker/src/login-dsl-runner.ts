import { Page, BrowserContext, Frame, FrameLocator } from 'playwright';
import { DslStep, RequestHumanInputStep, InputRequest } from '@browser-hitl/shared';
import { InputRelay } from './input-relay';

/**
 * Login DSL Runner - executes all DSL actions per spec section 10.3.
 * Steps execute sequentially and are blocking.
 * Frame context persists across steps until explicitly changed.
 */
export class LoginDslRunner {
  private currentFrame: Page | Frame | FrameLocator;
  private readonly allowEvaluate: boolean;
  private readonly onInputRequested: ((request: InputRequest) => Promise<void> | void) | undefined;
  /** @deprecated Use onInputRequested instead */
  private readonly onOtpWaitStart: (() => Promise<void> | void) | undefined;

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly inputRelay: InputRelay,
    private readonly sessionId: string,
    private readonly tenantId: string,
    private readonly appId: string,
    options?: {
      allowEvaluate?: boolean;
      onInputRequested?: (request: InputRequest) => Promise<void> | void;
      /** @deprecated Use onInputRequested instead */
      onOtpWaitStart?: () => Promise<void> | void;
    },
  ) {
    this.currentFrame = page;
    this.allowEvaluate = options?.allowEvaluate === true;
    this.onInputRequested = options?.onInputRequested;
    this.onOtpWaitStart = options?.onOtpWaitStart;
  }

  /**
   * Execute a sequence of DSL steps with credential interpolation.
   */
  async execute(
    steps: DslStep[],
    credentials: { username: string; password: string },
  ): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const timeout = step.timeout_ms || 30000;
      const retries = step.retry_count ?? 1;

      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          await this.executeStep(step, i, credentials, timeout);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error as Error;
          console.warn(`Step ${i} (${step.action}) attempt ${attempt + 1} failed: ${error}`);

          if (attempt < retries) {
            await this.page.waitForTimeout(1000); // Brief pause before retry
          }
        }
      }

      if (lastError) {
        // Capture error screenshot only if non-sensitive and policy allows
        if (!step.sensitive) {
          try {
            // Screenshot capture would go here if screenshot_policy.capture_on_error
            // Per spec: sensitive steps NEVER persist screenshots
          } catch {
            // Ignore screenshot errors
          }
        }
        throw new Error(`DSL step ${i} (${step.action}) failed after ${retries + 1} attempts: ${lastError.message}`);
      }
    }
  }

  private async executeStep(
    step: DslStep,
    stepIndex: number,
    credentials: { username: string; password: string },
    timeout: number,
  ): Promise<void> {
    switch (step.action) {
      case 'goto':
        await this.page.goto(step.url, { timeout });
        break;

      case 'fill': {
        const value = this.interpolate(step.value, credentials);
        await this.currentFrame.locator(step.selector).fill(value, { timeout });
        break;
      }

      case 'type': {
        const value = this.interpolate(step.value, credentials);
        await this.currentFrame.locator(step.selector).pressSequentially(value, { delay: 50, timeout });
        break;
      }

      case 'click':
        await this.currentFrame.locator(step.selector).click({ timeout });
        break;

      case 'select':
        await this.currentFrame.locator(step.selector).selectOption(step.value, { timeout });
        break;

      case 'wait_for':
        await this.currentFrame.locator(step.selector).waitFor({ timeout: step.timeout_ms || timeout });
        break;

      case 'wait_for_url':
        await this.page.waitForURL(step.pattern, { timeout: step.timeout_ms || timeout });
        break;

      case 'frame':
        this.currentFrame = this.page.frameLocator(step.selector).first();
        break;

      case 'main_frame':
        this.currentFrame = this.page;
        break;

      case 'popup': {
        const popup = await this.page.waitForEvent('popup', { timeout: step.timeout_ms || timeout });
        this.currentFrame = popup;
        break;
      }

      case 'keyboard':
        await this.page.keyboard.press(step.key);
        break;

      case 'evaluate':
        if (!this.allowEvaluate) {
          throw new Error('DSL evaluate action is disabled by policy');
        }
        await this.page.evaluate(step.expression);
        break;

      case 'sleep':
        await this.page.waitForTimeout(step.ms);
        break;

      case 'screenshot':
        // Screenshot stored in MinIO if enabled
        await this.page.screenshot({ path: `/tmp/screenshot-${Date.now()}.png` });
        break;

      case 'reload':
        await this.page.reload({ timeout });
        break;

      case 'request_human_input':
        await this.handleHumanInputRequest(step, stepIndex);
        break;

      default:
        throw new Error(`Unknown DSL action: ${(step as any).action}`);
    }

    // Legacy: check if this is an OTP wait step (sensitive wait_for)
    if (step.action === 'wait_for' && step.sensitive) {
      await this.handleOtpWait(step.selector, step.timeout_ms || 120000);
    }
  }

  /**
   * Handle a generic human input request step.
   * Signals controller, polls Redis for the response, then acts on it.
   */
  private async handleHumanInputRequest(
    step: RequestHumanInputStep,
    stepIndex: number,
  ): Promise<void> {
    console.log(`Human input requested: type=${step.input_type}, label="${step.label}"`);

    const inputRequest: InputRequest = {
      input_type: step.input_type,
      label: step.label,
      placeholder: step.placeholder,
      sensitive: step.sensitive,
      step_index: stepIndex,
    };

    // Signal the controller via callback
    if (this.onInputRequested) {
      try {
        await this.onInputRequested(inputRequest);
      } catch (error) {
        console.warn(`Failed to report input request: ${error}`);
      }
    }

    // Poll for human input
    const timeoutMs = step.timeout_ms || 120000;
    const response = await this.inputRelay.waitForInput(stepIndex, timeoutMs);

    if (!response) {
      throw new Error(`Human input timeout - no value received for "${step.label}"`);
    }

    // Handle the response based on input_type
    switch (response.input_type) {
      case 'url':
        await this.page.goto(response.value);
        break;
      case 'confirm':
        // Human resolved via VNC, nothing to do
        break;
      default:
        // Fill the value into the field
        if (step.field_selector) {
          await this.currentFrame.locator(step.field_selector).fill(response.value);
          if (step.submit_selector) {
            await this.currentFrame.locator(step.submit_selector).click();
          }
        }
        break;
    }

    console.log(`Human input received and processed: type=${response.input_type}`);
  }

  /**
   * Handle OTP wait: poll Redis for OTP value, fill field when received.
   * Per spec section 9.7.
   */
  private async handleOtpWait(fieldSelector: string, timeoutMs: number): Promise<void> {
    console.log('OTP wait detected, starting relay polling');
    if (this.onOtpWaitStart) {
      try {
        await this.onOtpWaitStart();
      } catch (error) {
        console.warn(`Failed to report OTP wait start: ${error}`);
      }
    }

    const otpValue = await this.inputRelay.waitForOtp(timeoutMs);
    if (otpValue) {
      await this.currentFrame.locator(fieldSelector).fill(otpValue);
      console.log('OTP filled successfully');
    } else {
      throw new Error('OTP timeout - no value received');
    }
  }

  /**
   * Interpolate ${USERNAME} and ${PASSWORD} in step values.
   * Credential values are resolved in worker process memory only.
   * Never serialized to logs, audit events, or screenshots.
   */
  private interpolate(value: string, credentials: { username: string; password: string }): string {
    return value
      .replace('${USERNAME}', credentials.username)
      .replace('${PASSWORD}', credentials.password);
  }
}
