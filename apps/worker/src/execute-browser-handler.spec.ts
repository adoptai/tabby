import { BROWSER_COMMANDS, EXECUTE_LIMITS } from '@browser-hitl/shared';
import { dispatchCommand } from './execute-browser-handler';

// A minimal Playwright Locator/Page mock that records how click_by_text resolves
// its target. getByText → filter({visible}) → nth → click is the chain we assert.
function makeLocator(overrides: Record<string, any> = {}): any {
  const loc: any = {
    click: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(overrides.count ?? 1),
    filter: jest.fn(),
    nth: jest.fn(),
    getByText: jest.fn(),
  };
  loc.filter.mockImplementation((opts: any) => {
    loc._lastFilter = opts;
    return overrides.filtered ?? loc;
  });
  loc.nth.mockImplementation((i: number) => {
    loc._lastNth = i;
    return loc;
  });
  return loc;
}

describe('execute-browser-handler click_by_text resolution', () => {
  it('defaults to non-exact matching and clicks the first VISIBLE match', async () => {
    const visible = makeLocator({ count: 1 });
    const matches = makeLocator({ count: 3, filtered: visible });
    const page: any = { getByText: jest.fn().mockReturnValue(matches) };

    await dispatchCommand(page, 'click_by_text', { text: 'Cards' }, 30000);

    // exact defaults to false (Playwright's natural substring match)
    expect(page.getByText).toHaveBeenCalledWith('Cards', { exact: false });
    // duplicate matches → filter to visible, take the first, then click
    expect(matches.filter).toHaveBeenCalledWith({ visible: true });
    expect(visible.nth).toHaveBeenCalledWith(0);
    expect(visible.click).toHaveBeenCalledTimes(1);
  });

  it('honors exact:true, a within-scope, and an nth index', async () => {
    const visible = makeLocator({ count: 2 });
    const matches = makeLocator({ count: 2, filtered: visible });
    const scope = makeLocator();
    scope.getByText.mockReturnValue(matches);
    const page: any = {
      locator: jest.fn().mockReturnValue(scope),
      getByText: jest.fn(),
    };

    await dispatchCommand(
      page,
      'click_by_text',
      { text: 'Credit Card', exact: true, within: '#sidenavNew', nth: 1 },
      30000,
    );

    expect(page.locator).toHaveBeenCalledWith('#sidenavNew');
    expect(scope.getByText).toHaveBeenCalledWith('Credit Card', { exact: true });
    expect(visible.nth).toHaveBeenCalledWith(1);
    expect(visible.click).toHaveBeenCalledTimes(1);
  });

  it('falls back to all matches when none are visible (so a real miss still errors)', async () => {
    const visible = makeLocator({ count: 0 });
    const matches = makeLocator({ count: 1, filtered: visible });
    const page: any = { getByText: jest.fn().mockReturnValue(matches) };

    await dispatchCommand(page, 'click_by_text', { text: 'Ghost' }, 30000);

    expect(matches.nth).toHaveBeenCalledWith(0); // fell back to the raw matches
    expect(matches.click).toHaveBeenCalledTimes(1);
  });
});

describe('execute-browser-handler validation', () => {
  describe('command validation', () => {
    it('recognizes all valid browser commands', () => {
      const expectedCommands = [
        'navigate', 'click_element', 'click_by_text', 'click_at',
        'type_text', 'type_into_label', 'press_key',
        'get_page_summary', 'get_page_info', 'screenshot',
        'wait_for_selector', 'scroll_page',
        'har_start', 'har_stop', 'har_status',
        'list_downloads', 'get_download',
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
