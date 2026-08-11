import { BROWSER_COMMANDS, EXECUTE_LIMITS } from '@browser-hitl/shared';
import { dispatchCommand, registerBrowserHandler, requireVisible, resolveOne } from './execute-browser-handler';

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

/**
 * ICICI's statement form hides its PERIOD_TYPE radios behind styled labels. No
 * command could set them, and `click_by_text("Annual")` reported SUCCESS while
 * the form still said Monthly — so the agent had no way to tell it had failed,
 * and got stuck insisting it had clicked Annual.
 */
describe('set_checked', () => {
  function radio({ checkThrows = 0, checkedAfter = [true] } = {}) {
    let checkCalls = 0;
    let readCalls = 0;
    const target: any = {
      check: jest.fn(async () => {
        if (checkCalls++ < checkThrows) throw new Error('Element is not visible');
      }),
      uncheck: jest.fn(async () => undefined),
      isChecked: jest.fn(async () => checkedAfter[Math.min(readCalls++, checkedAfter.length - 1)]),
      getAttribute: jest.fn(async () => 'PERIOD_TYPE_ANNUAL'),
      click: jest.fn(async () => undefined),
      locator: jest.fn(() => ({ first: () => ({ click: jest.fn(async () => undefined) }) })),
      filter: jest.fn(() => ({ count: async () => 1, first: () => target })),
      first: () => target,
      count: async () => 1,
    };
    const page: any = { locator: jest.fn(() => target), getByLabel: jest.fn(() => target) };
    return { page, target };
  }

  it('sets the control and reports the state it actually holds', async () => {
    const { page, target } = radio();
    const out = await dispatchCommand(page, 'set_checked', { selector: '#annual' }, 5000);

    expect(out).toEqual({ checked: true, verified: true });
    expect(target.check).toHaveBeenCalled();
  });

  it('forces past actionability for an input hidden behind a styled label', async () => {
    // The canonical bank pattern: display:none input, visible label.
    const { page, target } = radio({ checkThrows: 1 });
    const out = await dispatchCommand(page, 'set_checked', { selector: '#annual' }, 5000);

    expect(out.checked).toBe(true);
    expect(target.check).toHaveBeenCalledTimes(2);
    expect(target.check).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
  });

  it('falls back to clicking the label when the input cannot be set at all', async () => {
    const { page, target } = radio({ checkThrows: 2 });
    const out = await dispatchCommand(page, 'set_checked', { selector: '#annual' }, 5000);

    expect(out.checked).toBe(true);
    // Clicked the label a person would click, resolved from the input's id.
    expect(page.locator).toHaveBeenCalledWith('label[for="PERIOD_TYPE_ANNUAL"]');
    expect(target.click).toHaveBeenCalled();
  });

  it('fails loudly when the click lands but the state does not change', async () => {
    // THE bug being fixed: silent success is what left the agent stuck.
    const { page } = radio({ checkedAfter: [false] });

    await expect(
      dispatchCommand(page, 'set_checked', { selector: '#annual' }, 5000),
    ).rejects.toThrow(/state did not change|Could not set/);
  });

  it('requires a way to identify the control', async () => {
    const { page } = radio();
    await expect(dispatchCommand(page, 'set_checked', {}, 5000)).rejects.toThrow(/selector.*label/i);
  });
});

describe('select_option', () => {
  it('matches by value, then by visible label', async () => {
    const target: any = {
      selectOption: jest
        .fn()
        .mockRejectedValueOnce(new Error('no option with value'))
        .mockResolvedValueOnce(['ANNUAL']),
      filter: jest.fn(() => ({ count: async () => 1, first: () => target })),
      first: () => target,
    };
    const page: any = { locator: jest.fn(() => target) };

    const out = await dispatchCommand(page, 'select_option', { selector: '#period', value: 'Annual' }, 5000);

    expect(out).toEqual({ selected: ['ANNUAL'] });
    expect(target.selectOption).toHaveBeenLastCalledWith({ label: 'Annual' }, expect.anything());
  });
});

describe('a control that exists but stays hidden', () => {
  // One ICICI session lost its auth cookie during three of these: 30s of hover,
  // then 30s of click, against a positional selector on a page where the element
  // was hidden. Retrying a click into a re-rendering sidebar is not a no-op.
  const hidden = () => ({
    waitFor: async () => {
      throw new Error('Timeout 3000ms exceeded waiting for visible');
    },
    hover: async () => {
      throw new Error('should never be attempted');
    },
    click: async () => {
      throw new Error('should never be attempted');
    },
    count: async () => 1,
    first() {
      return this;
    },
  });

  it('stops instead of retrying, and says what is likely wrong', async () => {
    const el = hidden();
    await expect(requireVisible(el, 30_000)).rejects.toThrow(/not visible/i);
    await expect(requireVisible(el, 30_000)).rejects.toThrow(/opens on hover|read the page/i);
  });

  it('never waits longer than the grace period, however long the timeout', async () => {
    const started = Date.now();
    await expect(requireVisible(hidden(), 30_000)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000); // the fake throws at once
  });

  it('lets a visible control through untouched', async () => {
    let asked = false;
    const visible = { waitFor: async () => { asked = true; } };
    await expect(requireVisible(visible, 30_000)).resolves.toBeUndefined();
    expect(asked).toBe(true);
  });

  it('does not block a target that cannot be asked', async () => {
    // Not every target is a locator; a missing waitFor must not fail the action.
    await expect(requireVisible({}, 30_000)).resolves.toBeUndefined();
  });
});

describe('the recorded settle decides how long an invisible control gets', () => {
  // ICICI's nav submenu was measured at 4322ms. The flat 3s grace gave up while
  // it was still animating open, so the click after a successful hover failed
  // as "on the page but not visible" — on the one operation that had been
  // passing all along.
  const waited: number[] = [];
  const target = {
    waitFor: async (opts: any) => {
      waited.push(opts.timeout);
    },
  };

  beforeEach(() => (waited.length = 0));

  it('uses the recorded settle when it exceeds the floor', async () => {
    await requireVisible(target, 30_000, 4322);
    expect(waited[0]).toBe(4322);
  });

  it('keeps the floor when the recording is quicker', async () => {
    await requireVisible(target, 30_000, 200);
    expect(waited[0]).toBe(3000);
  });

  it('never waits longer than the command timeout', async () => {
    await requireVisible(target, 2_000, 9_000);
    expect(waited[0]).toBe(2_000);
  });

  it('caps a pathological recording', async () => {
    await requireVisible(target, 60_000, 90_000);
    expect(waited[0]).toBe(15_000);
  });
});

describe('set_checked by role and accessible name', () => {
  // ICICI's Monthly and Annual radios share an id AND a name, so no selector
  // picks one of them. The recorder's only unique candidate was
  // `role_name: radio|Annual`.
  function fakePage() {
    const calls: any[] = [];
    const locator = { first: () => locator, filter: () => locator, count: async () => 1 };
    return {
      calls,
      getByRole: (role: string, opts: any) => {
        calls.push(['getByRole', role, opts]);
        return locator;
      },
      getByLabel: (l: string) => {
        calls.push(['getByLabel', l]);
        return locator;
      },
      locator: (sel: string) => {
        calls.push(['locator', sel]);
        return locator;
      },
    } as any;
  }

  it('resolves a radio by its role and name', async () => {
    const page = fakePage();
    await resolveOne(page, { role: 'radio', name: 'Annual' });
    expect(page.calls[0]).toEqual(['getByRole', 'radio', { name: 'Annual', exact: true }]);
  });

  it('prefers an explicit selector when one is given', async () => {
    const page = fakePage();
    await resolveOne(page, { selector: '#x', role: 'radio', name: 'Annual' });
    expect(page.calls[0][0]).toBe('locator');
  });

  it('says what it accepts when nothing identifies the control', async () => {
    await expect(resolveOne(fakePage(), {})).rejects.toThrow(/role.*name/i);
  });
});
