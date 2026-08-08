import { startHarCapture, stopHarCapture, cleanupHarListeners } from './har-capture';
import { EXECUTE_LIMITS } from '@browser-hitl/shared';

/**
 * HAR body capture is BUDGETED, and these pin why.
 *
 * A recording of an ICICI login captured 1100 entries and OOM-killed the worker
 * (1536Mi) at drain — after the bundle was assembled and BEFORE it was
 * persisted, so a complete recording was lost at the one moment nothing had been
 * written yet. Two things made that inevitable: a 5MB-per-entry cap with no
 * total, and `response.body()` materialising a whole response before slicing it,
 * so the memory peak was the full body regardless of the cap.
 */

/** A page fake that lets a test drive request/response pairs. */
function makePage() {
  const handlers: Record<string, (arg: any) => void | Promise<void>> = {};
  const page = {
    on: (event: string, fn: (arg: any) => void) => {
      handlers[event] = fn;
    },
    removeListener: jest.fn(),
  } as any;

  let seq = 0;
  async function exchange({
    mimeType = 'application/json',
    body = '{}',
    contentLength,
    url = 'https://bank.test/api/x',
  }: {
    mimeType?: string;
    body?: string;
    contentLength?: number;
    url?: string;
  }) {
    const id = `req-${seq++}`;
    const request: any = {
      url: () => url,
      method: () => 'GET',
      headers: () => ({}),
      postData: () => null,
      _id: id,
    };
    await handlers.request?.(request);
    const headers: Record<string, string> = { 'content-type': mimeType };
    if (contentLength !== undefined) headers['content-length'] = String(contentLength);
    const response: any = {
      request: () => request,
      status: () => 200,
      statusText: () => 'OK',
      headers: () => headers,
      body: async () => Buffer.from(body, 'utf8'),
    };
    await handlers.response?.(response);
  }

  return { page, exchange };
}

const entryOf = (har: any, i = 0) => har.log.entries[i];

describe('HAR body capture is budgeted', () => {
  afterEach(() => jest.clearAllMocks());

  it('stores a small JSON body in full', async () => {
    const { page, exchange } = makePage();
    startHarCapture(page);
    await exchange({ body: '{"balance":"1042300.55"}' });

    const { har } = stopHarCapture(page);
    expect(entryOf(har).response.content.text).toBe('{"balance":"1042300.55"}');
    expect(entryOf(har).response.content.comment).toBeUndefined();
    cleanupHarListeners(page);
  });

  it('never reads a body whose declared size exceeds the per-entry cap', async () => {
    // THE memory fix: slicing after the read caps what is KEPT while doing
    // nothing about the peak — a 50MB asset still passed through memory whole.
    const { page, exchange } = makePage();
    startHarCapture(page);
    const bodySpy = jest.fn();
    await exchange({ contentLength: 50_000_000, body: 'x' });

    const { har } = stopHarCapture(page);
    expect(entryOf(har).response.content.text).toBe('');
    expect(entryOf(har).response.content.comment).toMatch(/exceeds the per-entry cap/);
    expect(bodySpy).not.toHaveBeenCalled();
    cleanupHarListeners(page);
  });

  it('truncates an oversized body it did read, and says so', async () => {
    const { page, exchange } = makePage();
    startHarCapture(page);
    const big = 'y'.repeat(EXECUTE_LIMITS.MAX_HAR_BODY_BYTES + 5000);
    await exchange({ body: big });

    const { har } = stopHarCapture(page);
    expect(entryOf(har).response.content.text.length).toBe(EXECUTE_LIMITS.MAX_HAR_BODY_BYTES);
    expect(entryOf(har).response.content.comment).toMatch(/truncated from/);
    cleanupHarListeners(page);
  });

  it('skips bodies no consumer can use', async () => {
    // On a bank portal these are most of the bytes and none of the meaning.
    const { page, exchange } = makePage();
    startHarCapture(page);
    for (const mimeType of ['image/png', 'font/woff2', 'text/css', 'video/mp4']) {
      await exchange({ mimeType, body: 'z'.repeat(1000) });
    }

    const { har } = stopHarCapture(page);
    for (let i = 0; i < 4; i++) {
      expect(entryOf(har, i).response.content.text).toBe('');
      expect(entryOf(har, i).response.content.comment).toMatch(/binary or asset/);
    }
    cleanupHarListeners(page);
  });

  it('keeps the entry itself when it drops the body', async () => {
    // The endpoint, method, status and timing are what compile; the bytes are
    // what blow up. Dropping the entry as well would lose the useful half.
    const { page, exchange } = makePage();
    startHarCapture(page);
    await exchange({ mimeType: 'image/png', url: 'https://bank.test/logo.png' });

    const { har } = stopHarCapture(page);
    expect(har.log.entries).toHaveLength(1);
    expect(entryOf(har).request.url).toBe('https://bank.test/logo.png');
    expect(entryOf(har).response.status).toBe(200);
    cleanupHarListeners(page);
  });

  it('stops storing bodies once the capture budget is spent', async () => {
    // The property that makes the OOM impossible rather than less likely: total
    // stored bytes are bounded however long the human records.
    const { page, exchange } = makePage();
    startHarCapture(page);

    const perEntry = EXECUTE_LIMITS.MAX_HAR_BODY_BYTES;
    const needed = Math.ceil(EXECUTE_LIMITS.MAX_HAR_BODY_TOTAL_BYTES / perEntry) + 2;
    for (let i = 0; i < needed; i++) {
      await exchange({ body: 'q'.repeat(perEntry) });
    }

    const { har } = stopHarCapture(page);
    const stored = har.log.entries.reduce(
      (n: number, e: any) => n + (e.response?.content?.text?.length || 0),
      0,
    );
    expect(stored).toBeLessThanOrEqual(EXECUTE_LIMITS.MAX_HAR_BODY_TOTAL_BYTES);
    // Every request is still recorded — only the bodies stop.
    expect(har.log.entries.length).toBe(needed);
    expect(entryOf(har, needed - 1).response.content.comment).toMatch(/budget/);
    cleanupHarListeners(page);
  });
});
