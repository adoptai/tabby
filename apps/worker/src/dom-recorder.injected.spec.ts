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
