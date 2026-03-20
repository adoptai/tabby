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
    },
  ) {
    this.currentFrame = page;
    this.allowEvaluate = options?.allowEvaluate === true;
    this.onInputRequested = options?.onInputRequested;
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

      console.log(`[DSL] Step ${i} (${step.action})`);

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
            const delay = this.calculateRetryDelay(step, attempt);
            await this.page.waitForTimeout(delay);
          }
        }
      }

      if (lastError) {
        // Check on_failure handler before throwing
        if (step.on_failure) {
          const handled = await this.handleOnFailure(step, i, lastError);
          if (handled === 'skip') continue;
          // 'abort' falls through to throw, 'continue' means help was provided
          if (handled === 'continue') continue;
        }

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

  }

  /**
   * Handle on_failure after all retries are exhausted.
   * Returns 'skip' to continue to next step, 'continue' if help was received,
   * or 'abort' to throw.
   */
  private async handleOnFailure(
    step: DslStep,
    stepIndex: number,
    error: Error,
  ): Promise<'skip' | 'continue' | 'abort'> {
    const handler = step.on_failure!;

    switch (handler.action) {
      case 'skip':
        console.log(`Step ${stepIndex} (${step.action}) failed, skipping per on_failure policy`);
        return 'skip';

      case 'abort':
        console.log(`Step ${stepIndex} (${step.action}) failed, aborting per on_failure policy`);
        return 'abort';

      case 'request_help': {
        console.log(`Step ${stepIndex} (${step.action}) failed, requesting help: "${handler.message}"`);

        // Take screenshot if requested
        if (handler.screenshot && !step.sensitive) {
          try {
            await this.page.screenshot({ path: `/tmp/screenshot-help-${stepIndex}-${Date.now()}.png` });
          } catch {
            // Ignore screenshot errors
          }
        }

        // Reuse the human input infrastructure
        const inputType = handler.input_type || 'confirm';
        const inputRequest: InputRequest = {
          input_type: inputType,
          label: handler.message,
          step_index: stepIndex,
        };

        if (this.onInputRequested) {
          try {
            await this.onInputRequested(inputRequest);
          } catch (err) {
            console.warn(`Failed to report help request: ${err}`);
          }
        }

        // Poll for human response
        const timeoutMs = step.timeout_ms || 120000;
        const response = await this.inputRelay.waitForInput(stepIndex, timeoutMs);

        if (!response) {
          console.warn(`Help request timeout for step ${stepIndex}`);
          return 'abort';
        }

        // Handle the response
        switch (response.input_type) {
          case 'url':
            await this.page.goto(response.value);
            break;
          case 'confirm':
            // Human resolved via VNC
            break;
          default:
            if (handler.field_selector) {
              await this.currentFrame.locator(handler.field_selector).fill(response.value);
            }
            break;
        }

        console.log(`Help received for step ${stepIndex}, resuming from next step`);
        return 'continue';
      }

      default:
        return 'abort';
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
   * Calculate retry delay with optional exponential backoff + jitter.
   */
  private calculateRetryDelay(step: DslStep, attempt: number): number {
    const backoff = step.retry_backoff || 'fixed';
    const baseDelay = step.retry_delay_ms || 1000;
    const maxDelay = step.retry_max_delay_ms || 30000;

    if (backoff === 'exponential') {
      const raw = baseDelay * Math.pow(2, attempt);
      const capped = Math.min(raw, maxDelay);
      // Add 0-20% jitter to prevent thundering herd
      const jitter = capped * (Math.random() * 0.2);
      return Math.round(capped + jitter);
    }

    return baseDelay;
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
