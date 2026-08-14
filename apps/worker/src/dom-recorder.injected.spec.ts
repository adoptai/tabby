import { domRecorderScript, REC_EVENT_PATH } from './dom-recorder.injected';

/**
 * The recorder runs inside the page, so there is no DOM here — we install a
 * minimal fake `window`/`document` on globalThis, run the script, then drive the
 * capture-phase listeners it registered with synthetic events.
 *
 * The behaviour under test is ORDER: `input` is debounced 500ms, so its payload
 * is built long after the human typed. `seq` and `event_time` are added to carry
 * the interaction itself — `timestamp` keeps its existing flush-time meaning so
 * that consumers reading it (the NoUI login compiler) are untouched.
 */

type Listener = (e: unknown) => void;

interface Harness {
  listeners: Record<string, Listener>;
  emitted: Array<Record<string, any>>;
  teardown: () => void;
}

function installFakeDom(href = 'https://example.com/login'): Harness {
  const listeners: Record<string, Listener> = {};
  const emitted: Array<Record<string, any>> = [];

  const fakeWindow: Record<string, any> = {
    location: { href },
    fetch: (url: string, init: { body: string }) => {
      if (url === REC_EVENT_PATH) emitted.push(JSON.parse(init.body));
      return Promise.resolve();
    },
  };
  const fakeDocument = {
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    removeEventListener: () => undefined,
  };

  const g = globalThis as any;
  const prev = { window: g.window, document: g.document };
  g.window = fakeWindow;
  g.document = fakeDocument;

  return {
    listeners,
    emitted,
    teardown: () => {
      g.window = prev.window;
      g.document = prev.document;
    },
  };
}

/** A stand-in for a DOM element: only the properties the recorder reads. */
function el(props: Record<string, any> = {}): Record<string, any> {
  const attrs: Record<string, string> = props.attrs || {};
  const node: Record<string, any> = {
    tagName: 'INPUT',
    id: '',
    name: '',
    type: 'text',
    value: '',
    className: '',
    placeholder: '',
    textContent: '',
    attributes: [],
    getAttribute: (n: string) => attrs[n] ?? null,
    ...props,
  };
  node.closest = () => node;
  return node;
}

describe('domRecorderScript', () => {
  let h: Harness;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-15T00:00:00.000Z'));
    h = installFakeDom();
    domRecorderScript();
  });

  afterEach(() => {
    h.teardown();
    jest.useRealTimers();
  });

  it('reports the keystroke in event_time and the flush in timestamp', () => {
    const field = el({ id: 'user', name: 'username', value: 'a' });

    h.listeners.input({ target: field });
    jest.advanceTimersByTime(500);

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].event_type).toBe('input');
    expect(h.emitted[0].event_time).toBe('2026-06-15T00:00:00.000Z');
    // `timestamp` is untouched: still the flush, 500ms later. Existing consumers
    // of this field must see exactly what they saw before.
    expect(h.emitted[0].timestamp).toBe('2026-06-15T00:00:00.500Z');
  });

  it('keeps the first keystroke of a burst as the interaction time', () => {
    const field = el({ id: 'user', name: 'username' });

    field.value = 'a';
    h.listeners.input({ target: field });
    jest.advanceTimersByTime(200);
    field.value = 'ab';
    h.listeners.input({ target: field }); // resets the debounce
    jest.advanceTimersByTime(500);

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].value).toBe('ab'); // final value...
    expect(h.emitted[0].event_time).toBe('2026-06-15T00:00:00.000Z'); // ...first keystroke
    expect(h.emitted[0].timestamp).toBe('2026-06-15T00:00:00.700Z'); // ...flushed at 700ms
  });

  it('orders a fill-then-submit inside the debounce window correctly', () => {
    // The regression: typing and clicking submit within 500ms flushed the input
    // AFTER the click, so a timestamp sort reconstructed "click" before "fill".
    const field = el({ id: 'password', name: 'password', type: 'password', value: 'hunter2' });
    const button = el({ tagName: 'BUTTON', id: 'signin', textContent: 'Sign in' });

    h.listeners.input({ target: field });
    jest.advanceTimersByTime(100);
    h.listeners.click({ target: button, clientX: 10, clientY: 20 });
    jest.advanceTimersByTime(400); // input flushes here — after the click

    const byArrival = h.emitted.map((e) => e.event_type);
    expect(byArrival).toEqual(['click', 'input']); // delivery order is still click-first

    const bySeq = [...h.emitted].sort((a, b) => a.seq - b.seq).map((e) => e.event_type);
    expect(bySeq).toEqual(['input', 'click']); // ...but seq recovers the true order

    const input = h.emitted.find((e) => e.event_type === 'input') as Record<string, any>;
    const click = h.emitted.find((e) => e.event_type === 'click') as Record<string, any>;
    expect(input.seq).toBeLessThan(click.seq);
    expect(input.event_time < click.event_time).toBe(true);
    // The premise this whole change exists for: `timestamp` still inverts them,
    // and is deliberately left that way.
    expect(input.timestamp > click.timestamp).toBe(true);
    expect(input.value).toBe('[REDACTED]'); // password redaction still applies
  });

  it('numbers every event type from one strictly increasing counter', () => {
    const field = el({ id: 'user', name: 'username', value: 'x' });
    const box = el({ id: 'remember', type: 'checkbox', checked: true });
    const button = el({ tagName: 'BUTTON', id: 'go', textContent: 'Go' });
    const form = el({ tagName: 'FORM', id: 'login-form' });

    h.listeners.input({ target: field });
    jest.advanceTimersByTime(500);
    h.listeners.change({ target: box });
    h.listeners.click({ target: button, clientX: 1, clientY: 2 });
    h.listeners.submit({ target: form });

    expect(h.emitted.map((e) => e.event_type)).toEqual(['input', 'change', 'click', 'submit']);
    const seqs = h.emitted.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('starts a fresh stamp for the next burst on the same field', () => {
    const field = el({ id: 'otp', name: 'otp', value: '1' });

    h.listeners.input({ target: field });
    jest.advanceTimersByTime(500);
    jest.setSystemTime(new Date('2026-06-15T00:00:10.000Z'));
    field.value = '123456';
    h.listeners.input({ target: field });
    jest.advanceTimersByTime(500);

    expect(h.emitted.map((e) => e.event_time)).toEqual([
      '2026-06-15T00:00:00.000Z',
      '2026-06-15T00:00:10.000Z',
    ]);
    expect(h.emitted.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('emits event_time no later than timestamp on non-debounced events', () => {
    // These handlers emit inline, so the two clock reads are a statement apart.
    // `timestamp` is deliberately still its own original read — not a copy of
    // event_time — so equality is not guaranteed, only ordering.
    const box = el({ id: 'remember', type: 'checkbox', checked: true });
    const button = el({ tagName: 'BUTTON', id: 'go', textContent: 'Go' });
    const form = el({ tagName: 'FORM', id: 'login-form' });

    h.listeners.change({ target: box });
    h.listeners.click({ target: button, clientX: 1, clientY: 2 });
    h.listeners.submit({ target: form });

    expect(h.emitted).toHaveLength(3);
    for (const ev of h.emitted) {
      expect(ev.event_time).toBeTruthy();
      expect(ev.event_time <= ev.timestamp).toBe(true);
    }
  });
});

/**
 * Rich capture: locator candidates + element evidence.
 *
 * The recorder used to emit ONE selector chosen by a fixed ladder, with no idea
 * how many nodes it matched — a decision that could never be revisited, because
 * the page is gone once the recording ends. These assert it now records evidence
 * instead, and that a `login` recording is completely unaffected.
 */
function installRichDom(opts: {
  /** selector -> how many nodes it matches */
  counts?: Record<string, number>;
  /** what document.elementFromPoint returns (occlusion) */
  topAt?: unknown;
  actionableNodes?: unknown[];
} = {}) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const emitted: Array<Record<string, any>> = [];
  const counts = opts.counts || {};

  const fakeWindow: Record<string, any> = {
    location: { href: 'https://bank.test/accounts' },
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    CSS: { escape: (v: string) => v },
    fetch: (url: string, init: { body: string }) => {
      if (url === REC_EVENT_PATH) emitted.push(JSON.parse(init.body));
      return Promise.resolve();
    },
  };
  fakeWindow.top = fakeWindow; // not in an iframe

  const fakeDocument: Record<string, any> = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] = fn;
    },
    removeEventListener: () => undefined,
    getElementById: () => null,
    querySelectorAll: (sel: string) => {
      // The actionable-set query is used for semantic candidate counting.
      if (sel.indexOf('a[href],button') === 0) return opts.actionableNodes || [];
      return { length: counts[sel] ?? 0 };
    },
    elementFromPoint: () => opts.topAt ?? null,
  };

  const g = globalThis as any;
  const prev = { window: g.window, document: g.document };
  g.window = fakeWindow;
  g.document = fakeDocument;

  return {
    listeners,
    emitted,
    teardown: () => {
      g.window = prev.window;
      g.document = prev.document;
      delete (g.window || {}).__tabbyDomRecorder;
    },
  };
}

/** Minimal element the rich helpers can interrogate. */
function node(p: Record<string, any> = {}): Record<string, any> {
  const self: Record<string, any> = {
    nodeType: 1,
    tagName: p.tagName || 'BUTTON',
    id: p.id || '',
    className: p.className || '',
    textContent: p.textContent || '',
    name: p.name || '',
    type: p.type || '',
    attributes: [],
    labels: p.labels,
    parentElement: null,
    hasAttribute: (k: string) => !!(p.attrs && p.attrs[k] != null),
    getAttribute: (k: string) => (p.attrs && p.attrs[k] != null ? p.attrs[k] : null),
    matches: () => p.actionable !== false,
    closest: (sel: string) => {
      if (sel.indexOf('aria-hidden') !== -1) return null;
      if (p.actionableAncestor) return p.actionableAncestor;
      return p.actionable === false ? null : self;
    },
    getBoundingClientRect: () => p.rect || { left: 100, top: 100, width: 80, height: 20 },
    checkVisibility: () => p.visible !== false,
    getRootNode: () => (p.inShadow ? { host: {} } : (globalThis as any).document),
    contains: (o: unknown) => o === self,
  };
  return self;
}

const clickOn = (target: unknown, extra: Record<string, any> = {}) => ({
  target,
  clientX: 140,
  clientY: 110,
  ...extra,
});

describe('domRecorderScript — login mode carries no evidence', () => {
  it('emits neither candidates nor element when rich capture is off', async () => {
    const h = installRichDom();
    domRecorderScript(); // no opts === login
    const btn = node({ tagName: 'BUTTON', id: 'submit', textContent: 'Log on' });
    h.listeners.click(clickOn(btn));
    await Promise.resolve();

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].candidates).toBeUndefined();
    expect(h.emitted[0].element).toBeUndefined();
    // The legacy field the login compiler reads is still there, unchanged.
    expect(h.emitted[0].selector).toBe('#submit');
    h.teardown();
  });

  it('emits nothing extra when rich is explicitly false', async () => {
    const h = installRichDom();
    domRecorderScript({ rich: false });
    h.listeners.click(clickOn(node({ id: 'x' })));
    await Promise.resolve();

    expect(h.emitted[0].candidates).toBeUndefined();
    h.teardown();
  });
});

describe('domRecorderScript — locator candidates', () => {
  it('records how many nodes each candidate matched', async () => {
    // The whole point: a candidate that matched 40 nodes cannot identify this
    // element, and only the count makes that knowable at compile time.
    const h = installRichDom({ counts: { '#login-btn': 1, 'button[name="go"]': 3 } });
    domRecorderScript({ rich: true });
    h.listeners.click(clickOn(node({ tagName: 'BUTTON', id: 'login-btn', name: 'go' })));
    await Promise.resolve();

    const cands = h.emitted[0].candidates;
    expect(cands).toEqual(
      expect.arrayContaining([
        { kind: 'id', value: '#login-btn', match_count: 1 },
        { kind: 'name', value: 'button[name="go"]', match_count: 3 },
      ]),
    );
    h.teardown();
  });

  it('surfaces ambiguous text rather than silently emitting it as a selector', async () => {
    // click_by_text against a page with several "Download" controls is exactly
    // how the HSBCnet skill misclicked.
    const twin = () => node({ tagName: 'A', textContent: 'Download' });
    const h = installRichDom({ actionableNodes: [twin(), twin(), twin()] });
    domRecorderScript({ rich: true });
    h.listeners.click(clickOn(node({ tagName: 'A', textContent: 'Download' })));
    await Promise.resolve();

    const text = h.emitted[0].candidates.find((c: any) => c.kind === 'text');
    expect(text.value).toBe('Download');
    expect(text.match_count).toBe(3);
    h.teardown();
  });

  it('emits a generated-looking id rather than discarding it', async () => {
    // Durability is a judgement, and judgements belong in the compiler where they
    // can be improved. The recorder reports that the id existed.
    const h = installRichDom({ counts: { '#ext-gen1234abcd': 1 } });
    domRecorderScript({ rich: true });
    h.listeners.click(clickOn(node({ id: 'ext-gen1234abcd' })));
    await Promise.resolve();

    expect(h.emitted[0].candidates.some((c: any) => c.kind === 'id')).toBe(true);
    h.teardown();
  });
});

describe('domRecorderScript — element evidence', () => {
  it('describes the actionable ancestor, not the wrapper that was hit', async () => {
    // The legacy walk stops at the nearest element with an id OR ANY CLASS,
    // which on a modern page is usually a span inside the button.
    const button = node({ tagName: 'BUTTON', id: 'pay', textContent: 'Pay now' });
    const span = node({
      tagName: 'SPAN',
      className: 'label',
      textContent: 'Pay now',
      actionable: false,
      actionableAncestor: button,
    });
    const h = installRichDom({ counts: { '#pay': 1 } });
    domRecorderScript({ rich: true });
    h.listeners.click(clickOn(span));
    await Promise.resolve();

    expect(h.emitted[0].element.tag).toBe('button');
    expect(h.emitted[0].element.role).toBe('button');
    expect(h.emitted[0].candidates.some((c: any) => c.value === '#pay')).toBe(true);
    h.teardown();
  });

  it('flags an element covered by an overlay', async () => {
    // The overlay-intercepted click, answered at the only moment it is knowable.
    const overlay = node({ tagName: 'DIV', className: 'cookie-banner' });
    const h = installRichDom({ topAt: overlay });
    domRecorderScript({ rich: true });
    h.listeners.click(clickOn(node({ tagName: 'BUTTON', textContent: 'Accept' })));
    await Promise.resolve();

    expect(h.emitted[0].element.occluded).toBe(true);
    h.teardown();
  });

  it('does not call a scrolled-away element occluded', async () => {
    // Off-screen is not covered, and reporting it as covered would be a lie.
    const h = installRichDom({ topAt: node({ tagName: 'DIV' }) });
    domRecorderScript({ rich: true });
    h.listeners.click(
      clickOn(node({ rect: { left: 5000, top: 9000, width: 40, height: 20 } })),
    );
    await Promise.resolve();

    expect(h.emitted[0].element.occluded).toBe(false);
    h.teardown();
  });

  it('records invisibility instead of leaving the compiler to guess', async () => {
    const h = installRichDom();
    domRecorderScript({ rich: true });
    h.listeners.click(clickOn(node({ visible: false })));
    await Promise.resolve();

    expect(h.emitted[0].element.visible).toBe(false);
    h.teardown();
  });

  it('reaches through a shadow root to the element actually clicked', async () => {
    // A document-level listener retargets e.target to the shadow HOST, so the
    // legacy fields describe the wrong node entirely. composedPath()[0] is real.
    const host = node({ tagName: 'MY-WIDGET', id: 'host' });
    const inner = node({ tagName: 'BUTTON', id: 'inner', inShadow: true });
    const h = installRichDom({ counts: { '#inner': 1 } });
    domRecorderScript({ rich: true });
    h.listeners.click(clickOn(host, { composedPath: () => [inner, host] }));
    await Promise.resolve();

    expect(h.emitted[0].element.in_shadow_dom).toBe(true);
    expect(h.emitted[0].candidates.some((c: any) => c.value === '#inner')).toBe(true);
    h.teardown();
  });
});

it('gives a nav div its own text candidate, not a zero count', async () => {
  // ICICI's SPA nav is divs. actionableList() holds buttons, links and inputs,
  // so counting matches only there returned 0 for a label the element plainly
  // carries — and the compiler reads 0 as "resolves to nothing" and drops it.
  // That left "Cards", "Past" and "download previous statement" with a
  // positional css path and no text to fall back on: exactly the text a
  // hand-written skill used successfully on the same portal.
  const navDiv = node({ tagName: 'DIV', textContent: 'Credit Cards' });
  const h = installRichDom({ actionableNodes: [] });   // nothing "actionable"
  domRecorderScript({ rich: true });
  h.listeners.click(clickOn(navDiv));
  await Promise.resolve();

  const text = h.emitted[0].candidates.find((c: any) => c.kind === 'text');
  expect(text.value).toBe('Credit Cards');
  expect(text.match_count).toBe(1);
  h.teardown();
});

describe('masking survives whatever separator groups the number', () => {
  // The aria-label / accessible-name / data-attr paths mask a raw string, unlike
  // normText which pre-collapses whitespace. A bank that groups a PAN with a
  // non-breaking space, a comma or an underscore must still have it redacted
  // before it lands in the persisted bundle, not just the plain-space case.
  const PAN_DIGITS = '4315';
  for (const [label, sep] of [
    ['plain space', ' '],
    ['non-breaking space', ' '],
    ['thin space', ' '],
    ['comma', ','],
    ['underscore', '_'],
  ] as const) {
    it(`redacts a card number grouped by ${label}`, async () => {
      const pan = `Card ${['4315', '8105', '5762', '5005'].join(sep)}`;
      const btn = node({ tagName: 'BUTTON', id: 'pan', attrs: { 'aria-label': pan } });
      const h = installRichDom();
      domRecorderScript({ rich: true });
      h.listeners.click(clickOn(btn));
      await Promise.resolve();

      const name = h.emitted[0].element.accessible_name as string;
      expect(name).toContain('[REDACTED]');
      expect(name).not.toContain(PAN_DIGITS);
      // ...and the raw number never rides into the selector either: an aria-label
      // that masking changed is excluded from buildRichSelector.
      expect(h.emitted[0].selector).not.toContain(PAN_DIGITS);
      h.teardown();
    });
  }
});

describe('hover that reveals a menu', () => {
  it('records the hover when the click lands on what the hover revealed', async () => {
    // ICICI's top nav opens on hover: hover "Cards", click "Credit Cards".
    // The revealed item is a SIBLING of the trigger, not a descendant -- which
    // is why an el.contains(clicked) test answered false and the hover was
    // never recorded. The compiled skill then clicked "Credit Cards" on a page
    // where that text only exists once the menu is open, and every operation in
    // a live replay died on its first step.
    const item = node({ tagName: 'A', textContent: 'Credit Cards' });
    const trigger = node({ tagName: 'DIV', textContent: 'Cards' });
    (trigger as any).contains = (n: any) => n === trigger;   // NOT the item
    const nav = node({ tagName: 'NAV', textContent: '' });
    (nav as any).contains = (n: any) => n === trigger || n === item;
    (trigger as any).parentElement = nav;

    const h = installRichDom({ actionableNodes: [trigger, item] });
    domRecorderScript({ rich: true });
    h.listeners.mouseover({ target: trigger });
    h.listeners.click(clickOn(item));
    await Promise.resolve();

    const kinds = h.emitted.map((e: any) => e.event_type);
    expect(kinds).toEqual(['hover', 'click']);   // hover FIRST, as replay needs
    expect(h.emitted[0].text_content).toBe('Cards');
    expect(h.emitted[1].text_content).toBe('Credit Cards');
    h.teardown();
  });

  it('does not record a hover the click did not use', async () => {
    // A mouse crossing the page is not a menu. Recording every mouseover would
    // bury the bundle in noise.
    const passed = node({ tagName: 'DIV', textContent: 'Offers' });
    const other = node({ tagName: 'A', textContent: 'Accounts' });
    const box = node({ tagName: 'DIV', textContent: '' });
    (box as any).contains = (n: any) => n === passed;        // not `other`
    (passed as any).parentElement = box;

    const h = installRichDom({ actionableNodes: [passed, other] });
    domRecorderScript({ rich: true });
    h.listeners.mouseover({ target: passed });
    h.listeners.click(clickOn(other));
    await Promise.resolve();

    expect(h.emitted.map((e: any) => e.event_type)).toEqual(['click']);
    h.teardown();
  });

  it('does not treat a body-level parent as a reveal', async () => {
    // Scoping to the body would make every click after any hover a "reveal".
    // A menu portalled to the body is not detectable this way, and saying
    // nothing is better than flagging everything.
    const item = node({ tagName: 'A', textContent: 'Credit Cards' });
    const trigger = node({ tagName: 'DIV', textContent: 'Cards' });
    (trigger as any).contains = () => false;

    const h = installRichDom({ actionableNodes: [trigger, item] });
    (trigger as any).parentElement = (globalThis as any).document.body;
    domRecorderScript({ rich: true });
    h.listeners.mouseover({ target: trigger });
    h.listeners.click(clickOn(item));
    await Promise.resolve();

    expect(h.emitted.map((e: any) => e.event_type)).toEqual(['click']);
    h.teardown();
  });

  it('does not record a hover on the control that was itself clicked', async () => {
    const btn = node({ tagName: 'BUTTON', textContent: 'Download' });
    (btn as any).contains = (n: any) => n === btn;

    const h = installRichDom({ actionableNodes: [btn] });
    domRecorderScript({ rich: true });
    h.listeners.mouseover({ target: btn });
    h.listeners.click(clickOn(btn));
    await Promise.resolve();

    expect(h.emitted.map((e: any) => e.event_type)).toEqual(['click']);
    h.teardown();
  });
});

it('gathers evidence from the labelled element, not an unlabelled container', async () => {
  // ICICI's nav is bare divs, so ACTIONABLE had nothing to stop on and the walk
  // ran from the clicked div.submenu-text up to the whole nav box. Evidence came
  // from the container — which holds several items and has no label — so
  // "Credit Cards" produced NO text candidate, while text_content (taken from
  // the clicked element) said "Credit Cards" all along. The two disagreed about
  // which element was clicked, and the step compiled to a positional path with
  // nothing to fall back on.
  const item = node({ tagName: 'DIV', textContent: 'Credit Cards' });
  const container = node({ tagName: 'DIV', textContent: 'CardsCredit CardsForex Card' });
  (item as any).closest = () => container;          // ACTIONABLE matches the box
  (container as any).matches = () => true;

  const h = installRichDom({ actionableNodes: [container, item] });
  domRecorderScript({ rich: true });
  h.listeners.click(clickOn(item));
  await Promise.resolve();

  const text = h.emitted[0].candidates.find((c: any) => c.kind === 'text');
  expect(text).toBeDefined();
  expect(text.value).toBe('Credit Cards');
  h.teardown();
});

it('marks a dropdown option as opened by the trigger beside it', async () => {
  // ICICI's year widget: the trigger is div:nth-of-type(1) and the option list
  // div:nth-of-type(2), SIBLINGS under one container. A contains() test on the
  // trigger never fired, so the rule was inert on the case it was written for.
  const container = node({ tagName: 'DIV', textContent: '' });
  const trigger = node({ tagName: 'DIV', textContent: 'FY2024-25' });
  const option = node({ tagName: 'A', textContent: 'FY2025-26' });
  (trigger as any).parentElement = container;
  (container as any).contains = (n: any) => n === option || n === trigger;

  const h = installRichDom({ actionableNodes: [trigger, option] });
  domRecorderScript({ rich: true });
  h.listeners.click(clickOn(trigger));
  h.listeners.click(clickOn(option));
  await Promise.resolve();

  expect(h.emitted[0].opened_by_previous).toBeUndefined();   // the trigger opened nothing
  expect(h.emitted[1].opened_by_previous).toBe(true);        // the option was opened by it
  h.teardown();
});

it('does not relate two clicks that merely share a page', async () => {
  const a = node({ tagName: 'A', textContent: 'Accounts' });
  const b = node({ tagName: 'A', textContent: 'Offers' });
  (a as any).parentElement = { contains: () => false };

  const h = installRichDom({ actionableNodes: [a, b] });
  domRecorderScript({ rich: true });
  h.listeners.click(clickOn(a));
  h.listeners.click(clickOn(b));
  await Promise.resolve();

  expect(h.emitted[1].opened_by_previous).toBeUndefined();
  h.teardown();
});
