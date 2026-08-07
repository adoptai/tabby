/**
 * The HAR reduction is DESTRUCTIVE, so what gates it matters more than anything
 * else in the recording path.
 *
 * `recording_mode` is the authoring PHASE — sign-in flow vs post-login traversal.
 * `browser_driven` is the skill KIND. They are independent: a workflow recording
 * of an ordinary REST app compiles into a HAR-replay skill, and har_to_tools.py
 * reads exactly the fields the reduction empties (postData, headers,
 * queryString). Gating the reduction on `workflow` gutted the HAR for every
 * replay skill built from a post-login recording, and nothing errored — the
 * skill simply came out unable to call anything.
 *
 * These tests mock the HAR capture so a real entry with a real body reaches
 * drain(); asserting against an empty entry list would pass whatever the gate
 * did.
 */
import type { RecordingHar } from '@browser-hitl/shared';

const CAPTURED_HAR: RecordingHar = {
  log: {
    version: '1.2',
    creator: { name: 'tabby-recording', version: '1.0' },
    entries: [
      {
        startedDateTime: '2026-08-07T10:00:00.000Z',
        time: 30,
        request: {
          method: 'POST',
          url: 'https://app.test/api/list?page=2',
          headers: [{ name: 'X-Token', value: 'abc123' }],
          queryString: [{ name: 'page', value: '2' }],
          postData: { mimeType: 'application/json', text: '{"q":"invoices"}' },
        },
        response: {
          status: 200,
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          content: { mimeType: 'application/json', text: '[{"id":1}]' },
        },
      },
    ],
  },
};

jest.mock('./har-capture', () => ({
  startHarCapture: jest.fn(),
  stopHarCapture: jest.fn(() => ({ har: JSON.parse(JSON.stringify(CAPTURED_HAR)) })),
  cleanupHarListeners: jest.fn(),
}));

import { RecordingRunner } from './recording-runner';

function fakes() {
  const page = {
    url: () => 'https://app.test/home',
    mainFrame: () => ({ url: () => 'https://app.test/home' }),
    on: () => undefined,
    evaluate: jest.fn(async () => undefined),
    removeListener: jest.fn(),
  } as unknown as import('playwright').Page;
  const context = {
    addInitScript: jest.fn(async () => undefined),
    cookies: jest.fn(async () => []),
    on: jest.fn(),
    removeListener: jest.fn(),
  } as unknown as import('playwright').BrowserContext;
  return { page, context };
}

async function drain(mode: 'login' | 'workflow', browserDriven: boolean) {
  const f = fakes();
  const runner = new RecordingRunner(f.page, f.context, 'sess-1', mode, browserDriven);
  await runner.start();
  return runner.drain();
}

const firstRequest = (bundle: { har: RecordingHar }) =>
  (bundle.har.log.entries[0] as any).request;

describe('HAR reduction is gated on the skill kind', () => {
  it('keeps the full HAR for a workflow recording that is NOT browser-driven', async () => {
    // THE regression case: this recording compiles into a HAR-replay skill, and
    // the replay compiler needs every one of these fields.
    const req = firstRequest(await drain('workflow', false));

    expect(req.postData.text).toBe('{"q":"invoices"}');
    expect(req.headers).toEqual([{ name: 'X-Token', value: 'abc123' }]);
    expect(req.queryString).toEqual([{ name: 'page', value: '2' }]);
    expect(req.url).toContain('?page=2');
  });

  it('keeps the full HAR for a login recording, browser-driven or not', async () => {
    // A login recording is how the Tabby profile is built; the HAR is its
    // contract and must never be reduced.
    for (const browserDriven of [false, true]) {
      const req = firstRequest(await drain('login', browserDriven));
      expect(req.postData.text).toBe('{"q":"invoices"}');
    }
  });

  it('reduces the HAR only when the recording is for a browser-driven skill', async () => {
    const bundle = await drain('workflow', true);
    const req = firstRequest(bundle);

    expect(req.postData.text).toBeUndefined();
    expect(req.postData.keys).toEqual(['q']); // shape survives for replay detection
    expect(req.headers).toEqual([]);
    expect(req.queryString).toEqual([]);
    expect(req.url).toBe('https://app.test/api/list'); // query stripped
    expect((bundle.har.log.entries[0] as any).response.content.text).toBe('');
  });

  it('still records the endpoint and timing it reduced', async () => {
    // Metadata-only, not gone: settle timing is what makes a step wait on
    // something real instead of a guessed sleep.
    const entry = (await drain('workflow', true)).har.log.entries[0] as any;

    expect(entry.startedDateTime).toBe('2026-08-07T10:00:00.000Z');
    expect(entry.time).toBe(30);
    expect(entry.request.method).toBe('POST');
    expect(entry.response.status).toBe(200);
  });
});
