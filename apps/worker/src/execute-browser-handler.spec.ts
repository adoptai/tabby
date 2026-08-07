import { BROWSER_COMMANDS, EXECUTE_LIMITS } from '@browser-hitl/shared';
import { dispatchCommand, registerBrowserHandler } from './execute-browser-handler';

// A minimal Playwright Locator/Page mock that records how click_by_text resolves
// its target. getByText → filter({visible}) → nth → click is the chain we assert.
function makeLocator(overrides: Record<string, any> = {}): any {
  const loc: any = {
    click: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(overrides.count ?? 1),
    filter: jest.fn(),
    nth: jest.fn(),
    getByText: jest.fn(),
    first: jest.fn(),
    scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(undefined),
    dispatchEvent: jest.fn().mockResolvedValue(undefined),
  };
  loc.filter.mockImplementation((opts: any) => {
    loc._lastFilter = opts;
    return overrides.filtered ?? loc;
  });
  loc.first.mockImplementation(() => loc);
  loc.nth.mockImplementation((i: number) => {
    loc._lastNth = i;
    return loc;
  });
  return loc;
}

describe('execute-browser-handler click_by_text resolution', () => {
  it('prefers an EXACT match by default, and clicks the first VISIBLE one', async () => {
    // Defaulting straight to substring silently widened every already-compiled
    // skill that omits `exact`: a sidebar with "Log out" and "Log out of all
    // devices" made click_by_text('Log out') ambiguous, and nth(0) then picks DOM
    // order. Exact is tried first; substring is only a rescue (below).
    const visible = makeLocator({ count: 1 });
    const matches = makeLocator({ count: 3, filtered: visible });
    const page: any = { getByText: jest.fn().mockReturnValue(matches) };

    await dispatchCommand(page, 'click_by_text', { text: 'Cards' }, 30000);

    expect(page.getByText).toHaveBeenCalledWith('Cards', { exact: true });
    // duplicate matches → filter to visible, take the first, then click
    expect(matches.filter).toHaveBeenCalledWith({ visible: true });
    expect(visible.nth).toHaveBeenCalledWith(0);
    expect(visible.click).toHaveBeenCalledTimes(1);
  });

  it('falls back to substring when no exact match exists (near-miss labels)', async () => {
    // The reason substring matching exists: a skill records "Credit Cards" but
    // the DOM says "Credit Card".
    const visible = makeLocator({ count: 1 });
    const exactMatches = makeLocator({ count: 0 });
    const looseMatches = makeLocator({ count: 2, filtered: visible });
    const page: any = {
      getByText: jest.fn().mockImplementation((_t: string, opts: any) =>
        opts?.exact ? exactMatches : looseMatches,
      ),
    };

    await dispatchCommand(page, 'click_by_text', { text: 'Credit Cards' }, 30000);

    expect(page.getByText).toHaveBeenCalledWith('Credit Cards', { exact: true });
    expect(page.getByText).toHaveBeenCalledWith('Credit Cards', { exact: false });
    expect(visible.click).toHaveBeenCalledTimes(1);
  });

  it('click_element prefers visible matches and clicks through an overlay', async () => {
    const visible = makeLocator({ count: 1 });
    visible.click.mockRejectedValueOnce(
      new Error('locator.click: Timeout 30000ms exceeded.\n<div class="newsNotification"> intercepts pointer events'),
    );
    const all = makeLocator({ count: 3, filtered: visible });
    const page: any = { locator: jest.fn().mockReturnValue(all) };

    await dispatchCommand(page, 'click_element', { selector: '.stmt a.dl' }, 30000);

    expect(all.filter).toHaveBeenCalledWith({ visible: true });
    expect(visible.dispatchEvent).toHaveBeenCalledWith('click');
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

  it('falls back to a DOM-dispatched click when a real click is intercepted by an overlay', async () => {
    // Regression for the HSBCnet statement "Download": a sticky news/service-update
    // banner obscured the link's click point, so Playwright refused the real click
    // ("intercepts pointer events") and no download ever fired. The DOM-level
    // dispatch bypasses the overlay hit-test, mirroring a manual click.
    const visible = makeLocator({ count: 1 });
    visible.click.mockRejectedValueOnce(
      new Error('locator.click: Timeout 30000ms exceeded.\n<div class="newsNotification"> intercepts pointer events'),
    );
    const matches = makeLocator({ count: 3, filtered: visible });
    const page: any = { getByText: jest.fn().mockReturnValue(matches) };

    await dispatchCommand(page, 'click_by_text', { text: 'Download' }, 30000);

    expect(visible.click).toHaveBeenCalledTimes(1);
    expect(visible.scrollIntoViewIfNeeded).toHaveBeenCalledTimes(1);
    expect(visible.dispatchEvent).toHaveBeenCalledWith('click');
  });

  it('rethrows a non-interception click error instead of dispatching (a genuine failure still surfaces)', async () => {
    const visible = makeLocator({ count: 1 });
    visible.click.mockRejectedValueOnce(new Error('locator.click: strict mode violation'));
    const matches = makeLocator({ count: 1, filtered: visible });
    const page: any = { getByText: jest.fn().mockReturnValue(matches) };

    await expect(dispatchCommand(page, 'click_by_text', { text: 'Download' }, 30000)).rejects.toThrow(
      /strict mode violation/,
    );
    expect(visible.dispatchEvent).not.toHaveBeenCalled();
  });

  it('rethrows a plain not-found timeout without dispatching (wrong label ≠ overlay)', async () => {
    // A bare "Timeout exceeded" (no "intercepts pointer events") means the target
    // text simply isn't on the page (e.g. a wrong recorded label). A DOM dispatch
    // can't help and would just burn a second 30s — so it must re-throw fast.
    const visible = makeLocator({ count: 1 });
    visible.click.mockRejectedValueOnce(
      new Error('locator.click: Timeout 30000ms exceeded.\nwaiting for getByText(\'Last Month Statement\')'),
    );
    const matches = makeLocator({ count: 1, filtered: visible });
    const page: any = { getByText: jest.fn().mockReturnValue(matches) };

    await expect(dispatchCommand(page, 'click_by_text', { text: 'Last Month Statement' }, 30000)).rejects.toThrow(
      /Timeout 30000ms exceeded/,
    );
    expect(visible.dispatchEvent).not.toHaveBeenCalled();
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

/**
 * `navigate` is a RELOAD, and refresh-sensitive portals destroy the session on
 * one — the next call lands on their signed-out screen and the human is asked to
 * sign in again mid-task. SKILL.md tells the agent never to navigate; in the
 * observed ICICI run the agent got stuck and did it anyway, ending the session.
 * Prose is not a guardrail.
 */
describe('execute-browser-handler navigate blocking', () => {
  const req = (command: string, params: Record<string, unknown> = {}) => ({
    body: { command, params },
  });
  function harness(blockNavigate: boolean) {
    let handler: any;
    const app: any = { post: (_p: string, h: any) => { handler = h; } };
    const page: any = {
      goto: jest.fn(async () => undefined),
      url: () => 'https://bank.test/accounts',
      title: async () => 'Accounts',
    };
    registerBrowserHandler(app, page, { blockNavigate });
    return { run: (r: any) => new Promise<any>((resolve) => {
      handler(r, { json: resolve, status: () => ({ json: resolve }) });
    }), page };
  }

  it('refuses navigate when the app cannot survive a reload', async () => {
    const h = harness(true);
    const out = await h.run(req('navigate', { url: 'https://bank.test/statements' }));

    expect(out.success).toBe(false);
    expect(h.page.goto).not.toHaveBeenCalled();
  });

  it('names the alternative, so the refusal is actionable', async () => {
    // A refusal an agent cannot act on is just a different dead end.
    const h = harness(true);
    const out = await h.run(req('navigate', { url: 'https://bank.test/x' }));

    expect(out.error).toMatch(/click_element|click_by_text/);
    expect(out.error).toMatch(/session/i);
  });

  it('leaves every other command alone', async () => {
    const h = harness(true);
    const out = await h.run(req('get_page_info'));
    expect(out.success).toBe(true);
  });

  it('allows navigate by default, which most apps need', async () => {
    const h = harness(false);
    const out = await h.run(req('navigate', { url: 'https://bank.test/statements' }));

    expect(out.success).toBe(true);
    expect(h.page.goto).toHaveBeenCalled();
  });
});
