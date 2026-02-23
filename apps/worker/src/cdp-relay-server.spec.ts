import {
  CDP_ALLOWED_COMMANDS,
  CDP_ALLOWED_EVENTS,
  CDP_LIMITS,
  sanitizeScreencastParams,
} from '@browser-hitl/shared';

describe('CDP Whitelist', () => {
  describe('CDP_ALLOWED_COMMANDS', () => {
    it('allows Page.startScreencast', () => {
      expect(CDP_ALLOWED_COMMANDS.has('Page.startScreencast')).toBe(true);
    });

    it('allows Page.stopScreencast', () => {
      expect(CDP_ALLOWED_COMMANDS.has('Page.stopScreencast')).toBe(true);
    });

    it('allows Page.screencastFrameAck', () => {
      expect(CDP_ALLOWED_COMMANDS.has('Page.screencastFrameAck')).toBe(true);
    });

    it('allows Input.dispatchKeyEvent', () => {
      expect(CDP_ALLOWED_COMMANDS.has('Input.dispatchKeyEvent')).toBe(true);
    });

    it('allows Input.dispatchMouseEvent', () => {
      expect(CDP_ALLOWED_COMMANDS.has('Input.dispatchMouseEvent')).toBe(true);
    });

    it('allows Input.dispatchTouchEvent', () => {
      expect(CDP_ALLOWED_COMMANDS.has('Input.dispatchTouchEvent')).toBe(true);
    });

    it('blocks Runtime.evaluate', () => {
      expect(CDP_ALLOWED_COMMANDS.has('Runtime.evaluate')).toBe(false);
    });

    it('blocks Target.attachToTarget', () => {
      expect(CDP_ALLOWED_COMMANDS.has('Target.attachToTarget')).toBe(false);
    });

    it('blocks Network.enable', () => {
      expect(CDP_ALLOWED_COMMANDS.has('Network.enable')).toBe(false);
    });

    it('blocks DOM.getDocument', () => {
      expect(CDP_ALLOWED_COMMANDS.has('DOM.getDocument')).toBe(false);
    });
  });

  describe('CDP_ALLOWED_EVENTS', () => {
    it('allows Page.screencastFrame', () => {
      expect(CDP_ALLOWED_EVENTS.has('Page.screencastFrame')).toBe(true);
    });

    it('allows Page.screencastVisibilityChanged', () => {
      expect(CDP_ALLOWED_EVENTS.has('Page.screencastVisibilityChanged')).toBe(true);
    });

    it('blocks Page.loadEventFired', () => {
      expect(CDP_ALLOWED_EVENTS.has('Page.loadEventFired')).toBe(false);
    });

    it('blocks Network.requestWillBeSent', () => {
      expect(CDP_ALLOWED_EVENTS.has('Network.requestWillBeSent')).toBe(false);
    });
  });

  describe('sanitizeScreencastParams', () => {
    it('clamps quality to max 80', () => {
      const result = sanitizeScreencastParams({ quality: 100 });
      expect(result.quality).toBe(80);
    });

    it('preserves quality within limits', () => {
      const result = sanitizeScreencastParams({ quality: 50 });
      expect(result.quality).toBe(50);
    });

    it('clamps quality minimum to 1', () => {
      const result = sanitizeScreencastParams({ quality: 0 });
      expect(result.quality).toBe(1);
    });

    it('defaults quality to 60 when not a number', () => {
      const result = sanitizeScreencastParams({ quality: 'high' });
      expect(result.quality).toBe(60);
    });

    it('clamps maxWidth to 1920', () => {
      const result = sanitizeScreencastParams({ maxWidth: 3840 });
      expect(result.maxWidth).toBe(1920);
    });

    it('clamps maxHeight to 1080', () => {
      const result = sanitizeScreencastParams({ maxHeight: 2160 });
      expect(result.maxHeight).toBe(1080);
    });

    it('enforces everyNthFrame minimum of 1', () => {
      const result = sanitizeScreencastParams({ everyNthFrame: 0 });
      expect(result.everyNthFrame).toBe(1);
    });

    it('preserves valid everyNthFrame', () => {
      const result = sanitizeScreencastParams({ everyNthFrame: 3 });
      expect(result.everyNthFrame).toBe(3);
    });

    it('forces format to jpeg', () => {
      const result = sanitizeScreencastParams({ format: 'png' });
      expect(result.format).toBe('jpeg');
    });

    it('applies defaults for missing params', () => {
      const result = sanitizeScreencastParams({});
      expect(result.quality).toBe(60);
      expect(result.maxWidth).toBe(CDP_LIMITS.SCREENCAST_MAX_WIDTH);
      expect(result.maxHeight).toBe(CDP_LIMITS.SCREENCAST_MAX_HEIGHT);
      expect(result.everyNthFrame).toBe(CDP_LIMITS.SCREENCAST_MIN_EVERY_NTH_FRAME);
      expect(result.format).toBe('jpeg');
    });
  });

  describe('Frame size limits', () => {
    it('has a 64KB max frame size', () => {
      expect(CDP_LIMITS.MAX_FRAME_SIZE_BYTES).toBe(65536);
    });
  });
});
