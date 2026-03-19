import { LoginDslRunner } from './login-dsl-runner';
import { DslStep } from '@browser-hitl/shared';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockLocator(overrides: Record<string, jest.Mock> = {}) {
  return {
    fill: jest.fn().mockResolvedValue(undefined),
    click: jest.fn().mockResolvedValue(undefined),
    selectOption: jest.fn().mockResolvedValue(undefined),
    waitFor: jest.fn().mockResolvedValue(undefined),
    pressSequentially: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockFrameLocator() {
  const locator = createMockLocator();
  return {
    locator: jest.fn().mockReturnValue(locator),
    first: jest.fn(),
    _locator: locator,
  };
}

function createMockPage() {
  const locator = createMockLocator();
  const frameLocatorObj = createMockFrameLocator();
  // first() returns the frameLocator itself (which has .locator method)
  frameLocatorObj.first.mockReturnValue(frameLocatorObj);

  return {
    goto: jest.fn().mockResolvedValue(undefined),
    locator: jest.fn().mockReturnValue(locator),
    frameLocator: jest.fn().mockReturnValue(frameLocatorObj),
    waitForURL: jest.fn().mockResolvedValue(undefined),
    waitForEvent: jest.fn().mockResolvedValue({
      locator: jest.fn().mockReturnValue(locator),
    }),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    keyboard: { press: jest.fn().mockResolvedValue(undefined) },
    evaluate: jest.fn().mockResolvedValue(undefined),
    screenshot: jest.fn().mockResolvedValue(undefined),
    reload: jest.fn().mockResolvedValue(undefined),
    _locator: locator,
    _frameLocatorObj: frameLocatorObj,
  };
}

function createMockBrowserContext() {
  return {};
}

function createMockInputRelay() {
  return {
    waitForOtp: jest.fn().mockResolvedValue('123456'),
    waitForInput: jest.fn().mockResolvedValue({ input_type: 'otp', value: '123456' }),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };
}

function buildRunner(overrides: Record<string, any> = {}) {
  const page = overrides.page ?? createMockPage();
  const context = overrides.context ?? createMockBrowserContext();
  const inputRelay = overrides.otpRelay ?? overrides.inputRelay ?? createMockInputRelay();

  const runner = new LoginDslRunner(
    page as any,
    context as any,
    inputRelay as any,
    'session-1',
    'tenant-1',
    'app-1',
    overrides.options,
  );

  return { runner, page, context, inputRelay };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LoginDslRunner', () => {
  // -----------------------------------------------------------------------
  // Credential interpolation
  // -----------------------------------------------------------------------
  describe('credential interpolation', () => {
    it('replaces ${USERNAME} in fill step value', async () => {
      const { runner, page } = buildRunner();
      const steps: DslStep[] = [
        { action: 'fill', selector: '#email', value: '${USERNAME}' },
      ];

      await runner.execute(steps, { username: 'admin@example.com', password: 'secret' });

      expect(page.locator).toHaveBeenCalledWith('#email');
      expect(page._locator.fill).toHaveBeenCalledWith('admin@example.com', expect.any(Object));
    });

    it('replaces ${PASSWORD} in fill step value', async () => {
      const { runner, page } = buildRunner();
      const steps: DslStep[] = [
        { action: 'fill', selector: '#password', value: '${PASSWORD}', sensitive: true },
      ];

      await runner.execute(steps, { username: 'admin', password: 'my-secret-pw' });

      expect(page._locator.fill).toHaveBeenCalledWith('my-secret-pw', expect.any(Object));
    });

    it('replaces both ${USERNAME} and ${PASSWORD} in the same value', async () => {
      const { runner, page } = buildRunner();
      const steps: DslStep[] = [
        { action: 'fill', selector: '#combo', value: '${USERNAME}:${PASSWORD}' },
      ];

      await runner.execute(steps, { username: 'user1', password: 'pass1' });

      expect(page._locator.fill).toHaveBeenCalledWith('user1:pass1', expect.any(Object));
    });

    it('replaces ${USERNAME} in type step value', async () => {
      const { runner, page } = buildRunner();
      const steps: DslStep[] = [
        { action: 'type', selector: '#email', value: '${USERNAME}' },
      ];

      await runner.execute(steps, { username: 'typed-user', password: 'secret' });

      expect(page._locator.pressSequentially).toHaveBeenCalledWith(
        'typed-user',
        expect.objectContaining({ delay: 50 }),
      );
    });

    it('does not interpolate literal text', async () => {
      const { runner, page } = buildRunner();
      const steps: DslStep[] = [
        { action: 'fill', selector: '#field', value: 'literal-value' },
      ];

      await runner.execute(steps, { username: 'admin', password: 'secret' });

      expect(page._locator.fill).toHaveBeenCalledWith('literal-value', expect.any(Object));
    });
  });

  // -----------------------------------------------------------------------
  // Frame context switching
  // -----------------------------------------------------------------------
  describe('frame context switching', () => {
    it('switches currentFrame when frame action is executed', async () => {
      const page = createMockPage();
      const frameLocatorMock = page._frameLocatorObj;
      const frameInnerLocator = frameLocatorMock._locator;

      const { runner } = buildRunner({ page });

      const steps: DslStep[] = [
        { action: 'frame', selector: '#my-iframe' },
        { action: 'fill', selector: '#inner-input', value: 'hello' },
      ];

      await runner.execute(steps, { username: '', password: '' });

      // frameLocator should have been called with the iframe selector
      expect(page.frameLocator).toHaveBeenCalledWith('#my-iframe');

      // After switching frame, the locator should be called on the frame, not the page
      expect(frameLocatorMock.locator).toHaveBeenCalledWith('#inner-input');
      expect(frameInnerLocator.fill).toHaveBeenCalledWith('hello', expect.any(Object));
    });

    it('switches back to main page with main_frame action', async () => {
      const page = createMockPage();
      const { runner } = buildRunner({ page });

      const steps: DslStep[] = [
        { action: 'frame', selector: '#my-iframe' },
        { action: 'main_frame' },
        { action: 'fill', selector: '#main-input', value: 'world' },
      ];

      await runner.execute(steps, { username: '', password: '' });

      // After main_frame, the fill should be back on the page's locator
      expect(page.locator).toHaveBeenCalledWith('#main-input');
      expect(page._locator.fill).toHaveBeenCalledWith('world', expect.any(Object));
    });
  });

  // -----------------------------------------------------------------------
  // OTP wait detection triggers relay polling
  // -----------------------------------------------------------------------
  describe('OTP wait detection', () => {
    it('triggers OTP relay polling when wait_for step is sensitive', async () => {
      const page = createMockPage();
      const inputRelay = createMockInputRelay();
      inputRelay.waitForOtp.mockResolvedValue('789012');

      const { runner } = buildRunner({ page, inputRelay });

      const steps: DslStep[] = [
        {
          action: 'wait_for',
          selector: '#otp-field',
          sensitive: true,
          timeout_ms: 60000,
        },
      ];

      await runner.execute(steps, { username: '', password: '' });

      // OTP relay should have been polled
      expect(inputRelay.waitForOtp).toHaveBeenCalledWith(60000);

      // OTP value should have been filled into the field
      expect(page._locator.fill).toHaveBeenCalledWith('789012');
    });

    it('invokes OTP wait start callback before polling Redis', async () => {
      const page = createMockPage();
      const inputRelay = createMockInputRelay();
      const onOtpWaitStart = jest.fn().mockResolvedValue(undefined);
      const { runner } = buildRunner({
        page,
        inputRelay,
        options: { onOtpWaitStart },
      });

      const steps: DslStep[] = [
        {
          action: 'wait_for',
          selector: '#otp-field',
          sensitive: true,
          timeout_ms: 60000,
        },
      ];

      await runner.execute(steps, { username: '', password: '' });

      expect(onOtpWaitStart).toHaveBeenCalledTimes(1);
      expect(inputRelay.waitForOtp).toHaveBeenCalledWith(60000);
    });

    it('throws when OTP relay returns null (timeout)', async () => {
      const page = createMockPage();
      const inputRelay = createMockInputRelay();
      inputRelay.waitForOtp.mockResolvedValue(null);

      const { runner } = buildRunner({ page, inputRelay });

      const steps: DslStep[] = [
        {
          action: 'wait_for',
          selector: '#otp-field',
          sensitive: true,
          timeout_ms: 5000,
        },
      ];

      await expect(
        runner.execute(steps, { username: '', password: '' }),
      ).rejects.toThrow('OTP timeout');
    });

    it('does not trigger OTP relay for non-sensitive wait_for', async () => {
      const inputRelay = createMockInputRelay();
      const { runner } = buildRunner({ inputRelay });

      const steps: DslStep[] = [
        { action: 'wait_for', selector: '#some-element', sensitive: false },
      ];

      await runner.execute(steps, { username: '', password: '' });

      expect(inputRelay.waitForOtp).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Step execution
  // -----------------------------------------------------------------------
  describe('step execution', () => {
    it('executes goto step', async () => {
      const page = createMockPage();
      const { runner } = buildRunner({ page });

      await runner.execute(
        [{ action: 'goto', url: 'https://example.com/login' }],
        { username: '', password: '' },
      );

      expect(page.goto).toHaveBeenCalledWith('https://example.com/login', { timeout: 30000 });
    });

    it('executes click step', async () => {
      const page = createMockPage();
      const { runner } = buildRunner({ page });

      await runner.execute(
        [{ action: 'click', selector: '#submit' }],
        { username: '', password: '' },
      );

      expect(page.locator).toHaveBeenCalledWith('#submit');
      expect(page._locator.click).toHaveBeenCalled();
    });

    it('executes keyboard step', async () => {
      const page = createMockPage();
      const { runner } = buildRunner({ page });

      await runner.execute(
        [{ action: 'keyboard', key: 'Enter' }],
        { username: '', password: '' },
      );

      expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
    });

    it('executes sleep step', async () => {
      const page = createMockPage();
      const { runner } = buildRunner({ page });

      await runner.execute(
        [{ action: 'sleep', ms: 2000 }],
        { username: '', password: '' },
      );

      expect(page.waitForTimeout).toHaveBeenCalledWith(2000);
    });

    it('uses custom timeout_ms when provided', async () => {
      const page = createMockPage();
      const { runner } = buildRunner({ page });

      await runner.execute(
        [{ action: 'click', selector: '#btn', timeout_ms: 5000 }],
        { username: '', password: '' },
      );

      expect(page._locator.click).toHaveBeenCalledWith({ timeout: 5000 });
    });

    it('blocks evaluate action by default', async () => {
      const page = createMockPage();
      const { runner } = buildRunner({ page });

      await expect(
        runner.execute(
          [{ action: 'evaluate', expression: 'document.title' } as any],
          { username: '', password: '' },
        ),
      ).rejects.toThrow('DSL evaluate action is disabled by policy');
    });

    it('allows evaluate action when policy explicitly enables it', async () => {
      const page = createMockPage();
      const { runner } = buildRunner({ page, options: { allowEvaluate: true } });

      await runner.execute(
        [{ action: 'evaluate', expression: 'document.title' } as any],
        { username: '', password: '' },
      );

      expect(page.evaluate).toHaveBeenCalledWith('document.title');
    });

    it('throws on unknown DSL action', async () => {
      const { runner } = buildRunner();

      const steps = [{ action: 'fly_to_moon' }] as any;

      await expect(
        runner.execute(steps, { username: '', password: '' }),
      ).rejects.toThrow('Unknown DSL action: fly_to_moon');
    });

    it('retries failed steps up to retry_count', async () => {
      const page = createMockPage();
      let callCount = 0;
      page._locator.click.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.reject(new Error('element not visible'));
        }
        return Promise.resolve();
      });

      const { runner } = buildRunner({ page });

      // retry_count: 1 means 1 initial attempt + 1 retry = 2 total
      const steps: DslStep[] = [
        { action: 'click', selector: '#flaky-btn', retry_count: 1 },
      ];

      await runner.execute(steps, { username: '', password: '' });

      expect(callCount).toBe(2);
    });
  });
});
