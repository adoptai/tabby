import { deriveOutcomes, OUTCOME_WINDOW_MS } from './recording-outcomes';
import { stripHarPayloads } from './har-metadata';
import type {
  RecordedInteractionEvent,
  RecordedUrlEvent,
  RecordedDownloadEvent,
  RecordingHar,
} from '@browser-hitl/shared';

const T0 = Date.parse('2026-08-07T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const click = (offsetMs: number, selector = '#go'): RecordedInteractionEvent => ({
  event_type: 'click',
  tag_name: 'BUTTON',
  element_id: null,
  class_name: null,
  selector,
  url: 'https://bank.test/accounts',
  event_time: iso(offsetMs),
  timestamp: iso(offsetMs),
});

const url = (offsetMs: number, to: string): RecordedUrlEvent => ({
  from_url: 'https://bank.test/accounts',
  to_url: to,
  timestamp: iso(offsetMs),
});

const download = (offsetMs: number): RecordedDownloadEvent => ({
  url: 'blob:https://bank.test/1',
  suggested_filename: 'statement.pdf',
  page_url: 'https://bank.test/statements',
  page_id: 0,
  timestamp: iso(offsetMs),
});

const har = (entries: Array<{ at: number; ms: number; url?: string }>): RecordingHar => ({
  log: {
    version: '1.2',
    creator: { name: 't', version: '1' },
    entries: entries.map((e) => ({
      startedDateTime: iso(e.at),
      time: e.ms,
      request: { method: 'GET', url: e.url || 'https://bank.test/api/x' },
      response: { status: 200, content: { mimeType: 'application/json', text: '{}' } },
    })),
  },
});

const EMPTY_HAR = har([]);

describe('deriveOutcomes', () => {
  it('attributes a navigation to the click that preceded it', async () => {
    // Without this the compiler infers causality from bare timestamps, which is
    // why browser_skill.py needed _resolve_nav_chains and a fallback for when it
    // cannot tell.
    const events = [click(0)];
    deriveOutcomes(events, [url(300, 'https://bank.test/statements')], [], EMPTY_HAR);

    expect(events[0].outcome).toEqual(
      expect.objectContaining({ navigated: true, to_url: 'https://bank.test/statements' }),
    );
  });

  it('reports a click that did nothing', async () => {
    // 0 requests and no navigation is how the compiler tells a real state
    // transition from a click that landed on a wrapper div.
    const events = [click(0)];
    deriveOutcomes(events, [], [], EMPTY_HAR);

    expect(events[0].outcome).toEqual({
      navigated: false,
      to_url: null,
      request_count: 0,
      settled_ms: null,
      download: false,
    });
  });

  it('reports when the traffic a click caused actually settled', async () => {
    // The basis for a real wait condition instead of a guessed sleep.
    const events = [click(0)];
    deriveOutcomes(events, [], [], har([{ at: 100, ms: 250 }, { at: 150, ms: 600 }]));

    expect(events[0].outcome?.request_count).toBe(2);
    expect(events[0].outcome?.settled_ms).toBe(750); // 150 + 600
  });

  it('does not credit one click with the next click of the human', async () => {
    // A slow page would otherwise attribute its traffic to every click before it.
    const events = [click(0), click(400)];
    deriveOutcomes(events, [url(900, 'https://bank.test/after')], [], EMPTY_HAR);

    expect(events[0].outcome?.navigated).toBe(false);
    expect(events[1].outcome?.navigated).toBe(true);
  });

  it('ignores what happens long after the interaction', async () => {
    const events = [click(0)];
    deriveOutcomes(
      events,
      [url(OUTCOME_WINDOW_MS + 500, 'https://bank.test/much-later')],
      [],
      EMPTY_HAR,
    );

    expect(events[0].outcome?.navigated).toBe(false);
  });

  it('records the download that a click started', async () => {
    // For most browser skills this is the success condition.
    const events = [click(0)];
    deriveOutcomes(events, [], [download(800)], EMPTY_HAR);

    expect(events[0].outcome?.download).toBe(true);
  });

  it('orders by the interaction, not by when a debounced payload flushed', async () => {
    // A field filled and submitted inside the 500ms debounce flushes its input
    // AFTER the click. Attributing outcomes by `timestamp` would hand the click's
    // navigation to the fill.
    const fill: RecordedInteractionEvent = {
      ...click(0),
      event_type: 'input',
      event_time: iso(0), // first keystroke
      timestamp: iso(500), // flush, after the click below
    };
    const submit = click(200, '#submit');
    const events = [fill, submit];

    deriveOutcomes(events, [url(400, 'https://bank.test/done')], [], EMPTY_HAR);

    expect(fill.outcome?.navigated).toBe(false);
    expect(submit.outcome?.navigated).toBe(true);
  });

  it('leaves no outcome when the interaction has no parsable time', async () => {
    // "Not known" is honest; a zeroed outcome would read as "nothing happened".
    const broken = { ...click(0), event_time: 'not-a-date', timestamp: 'also-bad' };
    const events = [broken];
    deriveOutcomes(events, [url(100, 'https://bank.test/x')], [], EMPTY_HAR);

    expect(events[0].outcome).toBeUndefined();
  });
});

describe('stripHarPayloads', () => {
  const rich: RecordingHar = {
    log: {
      version: '1.2',
      creator: { name: 't', version: '1' },
      entries: [
        {
          startedDateTime: iso(0),
          time: 120,
          request: {
            method: 'POST',
            url: 'https://bank.test/api/accounts?acct=1234567890&sid=abc',
            headers: [{ name: 'Cookie', value: 'SESSION=secret' }],
            queryString: [{ name: 'acct', value: '1234567890' }],
            postData: { text: '{"pan":"AAAPZ1234C"}', mimeType: 'application/json' },
          },
          response: {
            status: 200,
            statusText: 'OK',
            headers: [{ name: 'Set-Cookie', value: 'SESSION=secret' }],
            content: { mimeType: 'application/json', text: '{"balance":"1042300.55"}' },
          },
        },
      ],
    },
  };

  it('keeps the timing and the endpoint', async () => {
    const out = stripHarPayloads(rich) as any;
    const e = out.log.entries[0];

    expect(e.startedDateTime).toBe(iso(0));
    expect(e.time).toBe(120);
    expect(e.request.method).toBe('POST');
    expect(e.request.url).toBe('https://bank.test/api/accounts');
    expect(e.response.status).toBe(200);
    expect(e.response.content.mimeType).toBe('application/json');
  });

  it('drops every payload that could carry customer data or a live token', async () => {
    const serialized = JSON.stringify(stripHarPayloads(rich));

    expect(serialized).not.toContain('1042300.55'); // balance
    expect(serialized).not.toContain('AAAPZ1234C'); // PAN in a request body
    expect(serialized).not.toContain('SESSION=secret'); // auth cookie
    expect(serialized).not.toContain('1234567890'); // account number in the query
  });

  it('keeps the body SHAPE that browser-vs-replay detection depends on', async () => {
    // noui's detect_unreplayable decides whether an app can be a HAR-replay
    // skill at all, by testing whether request bodies are opaque {data,key}
    // encryption envelopes. It needs the top-level field NAMES and whether any
    // value looked like ciphertext — never the values. Dropping the body
    // outright silently disables that decision, and ICICI compiles back into 40
    // operations that all 403.
    const encrypted: RecordingHar = {
      log: {
        version: '1.2',
        creator: { name: 't', version: '1' },
        entries: [
          {
            startedDateTime: iso(0),
            time: 40,
            request: {
              method: 'POST',
              url: 'https://bank.test/api/op',
              postData: {
                mimeType: 'application/json',
                text: JSON.stringify({ data: 'x'.repeat(400), key: 'y'.repeat(64) }),
              },
            },
            response: { status: 200, content: { mimeType: 'application/json', text: '{}' } },
          },
        ],
      },
    };
    const pd = (stripHarPayloads(encrypted) as any).log.entries[0].request.postData;

    expect(pd.keys).toEqual(['data', 'key']);
    expect(pd.long_values).toBe(true);
    expect(JSON.stringify(pd)).not.toContain('xxxx'); // the ciphertext itself is gone
  });

  it('does not mistake a normal API body for an encryption envelope', async () => {
    const normal: RecordingHar = {
      log: {
        version: '1.2',
        creator: { name: 't', version: '1' },
        entries: [
          {
            startedDateTime: iso(0),
            time: 40,
            request: {
              method: 'POST',
              url: 'https://bank.test/api/txns',
              postData: {
                mimeType: 'application/json',
                text: JSON.stringify({ accountId: '00112233445566', fromDate: '2026-01-01' }),
              },
            },
            response: { status: 200, content: { mimeType: 'application/json', text: '[]' } },
          },
        ],
      },
    };
    const pd = (stripHarPayloads(normal) as any).log.entries[0].request.postData;

    expect(pd.keys).toEqual(['accountId', 'fromDate']);
    // Field names are schema; the account number itself is a value and is gone.
    expect(JSON.stringify(pd)).not.toContain('00112233445566');
  });

  it('preserves the HAR 1.2 shape so existing readers do not break', async () => {
    // Fields are emptied rather than deleted, and the envelope is untouched, so
    // anything already reading har.log.entries[].request.url keeps working.
    const out = stripHarPayloads(rich) as any;

    expect(out.log.version).toBe('1.2');
    expect(Array.isArray(out.log.entries[0].request.headers)).toBe(true);
    expect(out.log.entries[0].request.headers).toHaveLength(0);
    expect(out.log.entries[0].response.content.text).toBe('');
    // postData is reduced to a shape rather than emptied — see the body-shape
    // tests above for why. What must be gone is the content.
    expect(out.log.entries[0].request.postData.text).toBeUndefined();
    expect(out.log.entries[0].request.postData.keys).toEqual(['pan']);
  });

  it('survives a malformed entry rather than failing the drain', async () => {
    const broken: RecordingHar = {
      log: { version: '1.2', creator: { name: 't', version: '1' }, entries: [{}, null] as any },
    };
    expect(() => stripHarPayloads(broken)).not.toThrow();
    expect((stripHarPayloads(broken) as any).log.entries).toHaveLength(2);
  });
});
