import { pageSummaryScript } from './page-summary.injected';

/**
 * What `get_page_summary` reports is what the model can act on, so these are
 * written against the two failures that shaped it — both seen on ICICI:
 *
 *  1. Elements came back as bare {text}. With three buttons reading "download",
 *     "convert to emi" and "view more transactions", the agent had nothing to
 *     click with but a string, chose wrong, and ended up in the EMI flow.
 *  2. Hidden elements were dropped entirely (my fix for HSBCnet's phantom
 *     modals). A bank's "past statements" accordion is display:none until
 *     expanded, so the section the agent needed was invisible and it concluded
 *     the feature did not exist.
 *
 * The script runs inside the page, so there is no DOM here — we install a
 * minimal fake and drive it.
 */

interface FakeEl {
  tagName: string;
  id?: string;
  textContent?: string;
  attrs?: Record<string, string>;
  visible?: boolean;
  type?: string;
  name?: string;
  placeholder?: string;
}

function el(e: FakeEl): any {
  const attrs = e.attrs || {};
  const node: any = {
    tagName: e.tagName.toUpperCase(),
    id: e.id || '',
    textContent: e.textContent ?? '',
    type: e.type ?? '',
    name: e.name ?? '',
    placeholder: e.placeholder ?? '',
    getAttribute: (k: string) => (attrs[k] != null ? attrs[k] : k === 'name' ? e.name || null : null),
    closest: () => null,
    checkVisibility: () => e.visible !== false,
    getClientRects: () => [{}],
    offsetWidth: 10,
    offsetHeight: 10,
  };
  return node;
}

/** Install a fake document whose querySelectorAll answers from a fixed page. */
function installDom(page: { sel: string; els: any[] }[], title = 'ICICI Bank- Net Banking') {
  const g = globalThis as any;
  const prev = { window: g.window, document: g.document };

  const lookup = (selector: string): any[] => {
    // Exact match on the group selectors the script uses.
    const group = page.find((p) => p.sel === selector);
    if (group) return group.els;
    // Otherwise treat it as an addressability probe: count elements whose
    // recorded "address" string matches.
    const all = page.flatMap((p) => p.els);
    return all.filter((n: any) => (n.__addresses || []).includes(selector));
  };

  g.document = {
    title,
    querySelectorAll: (s: string) => lookup(s),
  };
  g.window = {
    location: { href: 'https://retailnetbanking.icici.bank.in/credit-card' },
    CSS: { escape: (v: string) => v },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  };
  return () => {
    g.window = prev.window;
    g.document = prev.document;
  };
}

/** Attach the selectors this element should be findable by. */
function addressable(node: any, ...selectors: string[]) {
  node.__addresses = selectors;
  return node;
}

const BUTTONS = 'button, [role="button"], input[type="submit"]';
const LINKS = 'a[href]';
const INPUTS = 'input, textarea, select';
const HEADINGS = 'h1, h2, h3';

describe('get_page_summary — addressability', () => {
  it('gives every element a selector the agent can click with', () => {
    // THE regression: without this the model can only guess at text.
    const download = addressable(
      el({ tagName: 'button', textContent: 'download', attrs: { 'data-testid': 'stmt-dl' } }),
      '[data-testid="stmt-dl"]',
    );
    const emi = addressable(el({ tagName: 'button', textContent: 'convert to emi', id: 'emi-btn' }), '#emi-btn');
    const restore = installDom([
      { sel: BUTTONS, els: [download, emi] },
      { sel: LINKS, els: [] },
      { sel: INPUTS, els: [] },
      { sel: HEADINGS, els: [] },
    ]);

    const out = pageSummaryScript();
    restore();

    expect(out.buttons[0]).toMatchObject({
      text: 'download',
      selector: '[data-testid="stmt-dl"]',
      selector_kind: 'testid',
    });
    expect(out.buttons[1]).toMatchObject({ selector: '#emi-btn', selector_kind: 'id' });
    // Unambiguous, so no count is reported — a count means "disambiguate me".
    expect(out.buttons[0].match_count).toBeUndefined();
  });

  it('prefers a test-id over an id, most durable first', () => {
    const both = addressable(
      el({ tagName: 'button', textContent: 'Pay', id: 'pay', attrs: { 'data-testid': 'pay-now' } }),
      '[data-testid="pay-now"]',
      '#pay',
    );
    const restore = installDom([
      { sel: BUTTONS, els: [both] },
      { sel: LINKS, els: [] },
      { sel: INPUTS, els: [] },
      { sel: HEADINGS, els: [] },
    ]);

    const out = pageSummaryScript();
    restore();
    expect(out.buttons[0].selector_kind).toBe('testid');
  });

  it('reports an ambiguous selector with its count instead of presenting it as an address', () => {
    // Two rows sharing an id is malformed but common. Silently handing the model
    // "#row" would make it click whichever came first.
    const a = addressable(el({ tagName: 'button', textContent: 'Download', id: 'row' }), '#row');
    const b = addressable(el({ tagName: 'button', textContent: 'Download', id: 'row' }), '#row');
    const restore = installDom([
      { sel: BUTTONS, els: [a, b] },
      { sel: LINKS, els: [] },
      { sel: INPUTS, els: [] },
      { sel: HEADINGS, els: [] },
    ]);

    const out = pageSummaryScript();
    restore();
    expect(out.buttons[0].match_count).toBe(2);
  });

  it('omits a selector entirely when the element cannot be addressed', () => {
    // Better to say nothing than to hand over something that will not resolve.
    const plain = el({ tagName: 'button', textContent: 'Anonymous' });
    const restore = installDom([
      { sel: BUTTONS, els: [plain] },
      { sel: LINKS, els: [] },
      { sel: INPUTS, els: [] },
      { sel: HEADINGS, els: [] },
    ]);

    const out = pageSummaryScript();
    restore();
    expect(out.buttons[0].selector).toBeUndefined();
    expect(out.buttons[0].text).toBe('Anonymous');
  });
});

describe('get_page_summary — hidden content', () => {
  it('reports a collapsed section instead of pretending it does not exist', () => {
    // The ICICI failure: "past statements" is display:none until expanded, so the
    // agent decided the portal only offered the current statement.
    const shown = addressable(el({ tagName: 'button', textContent: 'download', id: 'dl' }), '#dl');
    const collapsed = addressable(
      el({ tagName: 'button', textContent: 'PDF XLS download', id: 'past-dl', visible: false }),
      '#past-dl',
    );
    const restore = installDom([
      { sel: BUTTONS, els: [shown, collapsed] },
      { sel: LINKS, els: [] },
      { sel: INPUTS, els: [] },
      { sel: HEADINGS, els: [] },
    ]);

    const out = pageSummaryScript();
    restore();

    expect(out.buttons.map((b: any) => b.text)).toEqual(['download']);
    expect(out.hidden.buttons[0]).toMatchObject({ text: 'PDF XLS download', selector: '#past-dl' });
  });

  it('keeps hidden elements OUT of the main lists so phantom modals are not chased', () => {
    // The behaviour the visibility filter was added for must survive: the default
    // reading of the summary is still visible-only.
    const ghost = el({ tagName: 'button', textContent: 'Accept cookies', visible: false });
    const restore = installDom([
      { sel: BUTTONS, els: [ghost] },
      { sel: LINKS, els: [] },
      { sel: INPUTS, els: [] },
      { sel: HEADINGS, els: [] },
    ]);

    const out = pageSummaryScript();
    restore();
    expect(out.buttons).toEqual([]);
    expect(out.hidden.buttons).toHaveLength(1);
  });
});

describe('get_page_summary — truncation', () => {
  it('says so when it dropped elements', () => {
    // A silent cap reads to the model as "that is the whole page".
    const many = Array.from({ length: 70 }, (_, i) =>
      addressable(el({ tagName: 'a', textContent: `row ${i}`, id: `r${i}` }), `#r${i}`),
    );
    const restore = installDom([
      { sel: LINKS, els: many },
      { sel: BUTTONS, els: [] },
      { sel: INPUTS, els: [] },
      { sel: HEADINGS, els: [] },
    ]);

    const out = pageSummaryScript();
    restore();

    expect(out.links).toHaveLength(50);
    expect(out.truncated).toBe(true);
    expect(out.truncated_count).toBe(20);
  });

  it('reports no truncation when everything fits', () => {
    const restore = installDom([
      { sel: LINKS, els: [addressable(el({ tagName: 'a', textContent: 'Home', id: 'h' }), '#h')] },
      { sel: BUTTONS, els: [] },
      { sel: INPUTS, els: [] },
      { sel: HEADINGS, els: [] },
    ]);

    const out = pageSummaryScript();
    restore();
    expect(out.truncated).toBe(false);
    expect(out.truncated_count).toBe(0);
  });
});

describe('get_page_summary — shape', () => {
  it('still reports the page identity and inputs the old callers rely on', () => {
    const input = addressable(
      el({ tagName: 'input', type: 'text', name: 'q', id: 'search', placeholder: 'Search' }),
      '#search',
    );
    const restore = installDom([
      { sel: INPUTS, els: [input] },
      { sel: LINKS, els: [] },
      { sel: BUTTONS, els: [] },
      { sel: HEADINGS, els: [el({ tagName: 'h1', textContent: 'Credit Card' })] },
    ]);

    const out = pageSummaryScript();
    restore();

    expect(out.title).toBe('ICICI Bank- Net Banking');
    expect(out.url).toContain('/credit-card');
    expect(out.inputs[0]).toMatchObject({ type: 'text', name: 'q', id: 'search', placeholder: 'Search' });
    expect(out.headings[0]).toMatchObject({ level: 'H1', text: 'Credit Card' });
  });
});
