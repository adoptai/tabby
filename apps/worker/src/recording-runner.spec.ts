import { RecordingRunner } from './recording-runner';
import type { RecordedInteractionEvent } from '@browser-hitl/shared';

/**
 * Fakes for Playwright Page/Context. We capture the console + framenavigated
 * listeners so the test can drive synthetic events (the recorder now emits over
 * the browser console, not an exposeBinding binding), then assert drain()
 * assembles a well-formed RecordingBundle.
 */
function makeFakes(initialUrl: string) {
  let requestListener: ((req: unknown) => void) | null = null;
  let navListener: ((frame: unknown) => void) | null = null;
  let currentUrl = initialUrl;

  const mainFrame = {
    url: () => currentUrl,
  };

  const page = {
    url: () => currentUrl,
    mainFrame: () => mainFrame,
    on: (event: string, fn: (arg: unknown) => void) => {
      if (event === 'framenavigated') navListener = fn as typeof navListener;
      if (event === 'request') requestListener = fn as typeof requestListener;
      // 'domcontentloaded' (recorder re-injection) is accepted and ignored.
    },
    evaluate: jest.fn(async () => undefined),
    removeListener: jest.fn(),
  } as unknown as import('playwright').Page;

  const context = {
    addInitScript: jest.fn(async () => undefined),
    cookies: jest.fn(async () => []),
    route: jest.fn(async () => undefined),
    unroute: jest.fn(async () => undefined),
  } as unknown as import('playwright').BrowserContext;

  // Simulate the sentinel fetch() beacon the injected recorder would issue. The
  // recorder posts it SAME-ORIGIN so a connect-src CSP can't refuse it, so the
  // beacon's host is the page's own host, not a fixed sentinel domain.
  const beaconReq = (url: string, body: string | null) => ({ url: () => url, postData: () => body });
  const origin = new URL(initialUrl).origin;

  return {
    page,
    context,
    emit: (ev: RecordedInteractionEvent) =>
      requestListener?.(beaconReq(`${origin}/__tabby_rec__/e`, JSON.stringify(ev))),
    install: () =>
      requestListener?.(beaconReq(`${origin}/__tabby_rec__/i`, 'https://example.com/login')),
    navigate: (to: string) => {
      currentUrl = to;
      navListener?.(mainFrame);
    },
  };
}

const clickEvent: RecordedInteractionEvent = {
  event_type: 'click',
  tag_name: 'BUTTON',
  element_id: 'submit',
  class_name: null,
  selector: '#submit',
  url: 'https://example.com/login',
  timestamp: '2026-06-15T00:00:00.000Z',
};

describe('RecordingRunner', () => {
  it('injects the recorder on start', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();

    expect(f.context.addInitScript).toHaveBeenCalledTimes(1);
  });

  it('captures interaction events emitted over the request beacon channel', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();

    f.install();
    f.emit(clickEvent);
    const bundle = await runner.drain();
    expect(bundle.click_events).toHaveLength(1);
    expect(bundle.click_events[0].selector).toBe('#submit');
  });

  // Regression: an off-origin beacon is refused by any page declaring a
  // connect-src CSP, which silently produced captures with zero interaction
  // events — indistinguishable downstream from "the human never signed in".
  it('reads the beacon from any origin, not a fixed sentinel host', async () => {
    const f = makeFakes('https://app.adopt.ai/account/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-csp', 'login');
    await runner.start();

    f.install();
    f.emit(clickEvent);
    const bundle = await runner.drain();

    expect(bundle.click_events).toHaveLength(1);
  });

  it('aborts beacon requests so they never reach the page origin server', async () => {
    const f = makeFakes('https://app.adopt.ai/account/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-csp', 'login');
    await runner.start();

    expect(f.context.route).toHaveBeenCalledWith('**/__tabby_rec__/**', expect.any(Function));

    const abort = jest.fn(async () => undefined);
    (f.context.route as jest.Mock).mock.calls[0][1]({ abort });
    expect(abort).toHaveBeenCalled();
  });

  it('keeps beacon requests out of the drained HAR', async () => {
    const f = makeFakes('https://app.adopt.ai/account/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-csp', 'login');
    await runner.start();

    f.emit(clickEvent);
    const bundle = await runner.drain();

    const urls = (bundle.har.log.entries as Array<{ request?: { url?: string } }>).map(
      (e) => e.request?.url ?? '',
    );
    expect(urls.some((u) => u.includes('/__tabby_rec__/'))).toBe(false);
  });

  it('warns when traffic was captured but no interaction events were', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const f = makeFakes('https://app.adopt.ai/account/login');
      const runner = new RecordingRunner(f.page, f.context, 'sess-csp', 'login');
      await runner.start();

      // Traffic happened (two navigations) but the recorder emitted nothing.
      f.navigate('https://app.adopt.ai/oauth/callback');
      f.navigate('https://app.adopt.ai/');
      const bundle = await runner.drain();

      expect(bundle.click_events).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('NO DOM interaction events captured'),
      );
      expect(warn.mock.calls[0][0]).toContain('Content-Security-Policy');
    } finally {
      warn.mockRestore();
    }
  });

  it('drains a bundle with captured interaction + url events', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();

    f.emit(clickEvent);
    f.navigate('https://example.com/dashboard');

    const bundle = await runner.drain();

    expect(bundle.session_id).toBe('sess-1');
    expect(bundle.recording_mode).toBe('login');
    expect(bundle.click_events).toHaveLength(1);
    expect(bundle.click_events[0].selector).toBe('#submit');
    expect(bundle.url_events).toEqual([
      expect.objectContaining({
        from_url: 'https://example.com/login',
        to_url: 'https://example.com/dashboard',
      }),
    ]);
    expect(bundle.har.log.version).toBe('1.2');
    expect(bundle.started_at).toBeTruthy();
    expect(bundle.stopped_at).toBeTruthy();
  });

  it('reset() drops pre-bind capture so the bundle starts at the real target', async () => {
    // A warm spare warms on the pool placeholder page, then bind resets + navigates.
    const f = makeFakes('https://example.com/');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();

    // Pre-bind (warm-up) activity on the placeholder that must NOT leak.
    f.emit(clickEvent);
    f.navigate('https://example.com/warmup');

    // Bind: reset, then navigate to the real target.
    runner.reset();
    f.navigate('https://www.airbnb.com/');

    const bundle = await runner.drain();

    // Placeholder click + url events are gone.
    expect(bundle.click_events).toHaveLength(0);
    // First url_event is the real target, with from_url cleared by reset — so the
    // NoUI login compiler resolves login_url to the target, not the placeholder.
    expect(bundle.url_events).toEqual([
      expect.objectContaining({ from_url: '', to_url: 'https://www.airbnb.com/' }),
    ]);
  });

  it('does not record a url event when the url is unchanged', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'workflow');
    await runner.start();

    f.navigate('https://example.com/login'); // same url
    const bundle = await runner.drain();

    expect(bundle.url_events).toHaveLength(0);
  });

  it('drain detaches the framenavigated listener', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();
    await runner.drain();

    expect(f.page.removeListener).toHaveBeenCalledWith('framenavigated', expect.any(Function));
  });
});
