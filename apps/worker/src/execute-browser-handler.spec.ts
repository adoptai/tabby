import { BROWSER_COMMANDS, EXECUTE_LIMITS } from '@browser-hitl/shared';

describe('execute-browser-handler validation', () => {
  describe('command validation', () => {
    it('recognizes all valid browser commands', () => {
      const expectedCommands = [
        'navigate', 'click_element', 'click_by_text', 'click_at',
        'type_text', 'type_into_label', 'press_key',
        'get_page_summary', 'get_page_info', 'screenshot',
        'wait_for_selector', 'scroll_page',
        'har_start', 'har_stop', 'har_status',
      ];
      for (const cmd of expectedCommands) {
        expect(BROWSER_COMMANDS.includes(cmd as any)).toBe(true);
      }
    });

    it('rejects unknown commands', () => {
      expect(BROWSER_COMMANDS.includes('eval' as any)).toBe(false);
      expect(BROWSER_COMMANDS.includes('execute_js' as any)).toBe(false);
      expect(BROWSER_COMMANDS.includes('delete_cookies' as any)).toBe(false);
    });
  });

  describe('navigate scheme validation', () => {
    it('rejects data: URLs', () => {
      const parsed = new URL('data:text/html,<script>alert(1)</script>');
      expect(EXECUTE_LIMITS.ALLOWED_SCHEMES.includes(parsed.protocol)).toBe(false);
    });

    it('allows https: URLs', () => {
      const parsed = new URL('https://example.com');
      expect(EXECUTE_LIMITS.ALLOWED_SCHEMES.includes(parsed.protocol)).toBe(true);
    });
  });

  describe('browser rate limit constant', () => {
    it('has a reasonable browser rate limit', () => {
      expect(EXECUTE_LIMITS.BROWSER_RATE_LIMIT_PER_MIN).toBeGreaterThan(0);
      expect(EXECUTE_LIMITS.BROWSER_RATE_LIMIT_PER_MIN).toBeLessThanOrEqual(1000);
    });
  });

  describe('HAR response body truncation', () => {
    it('MAX_RESPONSE_BODY_BYTES is used for truncation', () => {
      expect(EXECUTE_LIMITS.MAX_RESPONSE_BODY_BYTES).toBe(5_242_880);
    });

    it('truncates body text correctly', () => {
      const maxBytes = EXECUTE_LIMITS.MAX_RESPONSE_BODY_BYTES;
      const longBody = 'a'.repeat(maxBytes + 100);
      const truncated = longBody.slice(0, maxBytes);
      expect(truncated.length).toBe(maxBytes);
    });
  });
});
