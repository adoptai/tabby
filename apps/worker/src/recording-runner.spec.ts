import { RecordingRunner } from './recording-runner';
import { RECORDING_SCHEMA_VERSION, type RecordedInteractionEvent } from '@browser-hitl/shared';

/**
 * Fakes for Playwright Page/Context. We capture the console + framenavigated
 * listeners so the test can drive synthetic events (the recorder now emits over
 * the browser console, not an exposeBinding binding), then assert drain()
 * assembles a well-formed RecordingBundle.
 */
function makeFakes(initialUrl: string) {
  let requestListener: ((req: unknown) => void) | null = null;
  let navListener: ((frame: unknown) => void) | null = null;
  let downloadListener: ((d: unknown) => void) | null = null;
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
      if (event === 'download') downloadListener = fn as typeof downloadListener;
      // 'domcontentloaded' (recorder re-injection) is accepted and ignored.
    },
    evaluate: jest.fn(async () => undefined),
    removeListener: jest.fn(),
  } as unknown as import('playwright').Page;

  let pageListener: ((p: unknown) => void) | null = null;
  const context = {
    addInitScript: jest.fn(async () => undefined),
    cookies: jest.fn(async () => []),
    on: jest.fn((event: string, fn: (arg: unknown) => void) => {
      if (event === 'page') pageListener = fn as typeof pageListener;
    }),
    removeListener: jest.fn(),
  } as unknown as import('playwright').BrowserContext;

  // Simulate the sentinel fetch() beacon the injected recorder would issue.
  const beaconReq = (url: string, body: string | null) => ({ url: () => url, postData: () => body });

  /** A popup/new tab, driven the same way as the main page. */
  function makePopup(popupUrl: string) {
    let popRequest: ((req: unknown) => void) | null = null;
    let popNav: ((frame: unknown) => void) | null = null;
    let popDownload: ((d: unknown) => void) | null = null;
    let url = popupUrl;
    const frame = { url: () => url };
    const p = {
      url: () => url,
      mainFrame: () => frame,
      on: (event: string, fn: (arg: unknown) => void) => {
        if (event === 'request') popRequest = fn as typeof popRequest;
        if (event === 'framenavigated') popNav = fn as typeof popNav;
        if (event === 'download') popDownload = fn as typeof popDownload;
      },
      evaluate: jest.fn(async () => undefined),
      removeListener: jest.fn(),
    } as unknown as import('playwright').Page;
    return {
      page: p,
      emit: (ev: RecordedInteractionEvent) =>
        popRequest?.(beaconReq('https://tabby-rec.local/e', JSON.stringify(ev))),
      navigate: (to: string) => {
        url = to;
        popNav?.(frame);
      },
      download: (name: string, dlUrl: string) =>
        popDownload?.({ url: () => dlUrl, suggestedFilename: () => name }),
      removeListener: p.removeListener as unknown as jest.Mock,
    };
  }

  return {
    page,
    context,
    emit: (ev: RecordedInteractionEvent) =>
      requestListener?.(beaconReq('https://tabby-rec.local/e', JSON.stringify(ev))),
    install: () => requestListener?.(beaconReq('https://tabby-rec.local/i', 'https://example.com/login')),
    navigate: (to: string) => {
      currentUrl = to;
      navListener?.(mainFrame);
    },
    download: (name: string, dlUrl: string) =>
      downloadListener?.({ url: () => dlUrl, suggestedFilename: () => name }),
    hasDownloadListener: () => downloadListener !== null,
    /** Simulate the browser opening a popup, as context.on('page') would. */
    openPopup: (popupUrl: string) => {
      const popup = makePopup(popupUrl);
      pageListener?.(popup.page);
      return popup;
    },
    hasPageListener: () => pageListener !== null,
  };
}

const clickEvent: RecordedInteractionEvent = {
  event_type: 'click',
  tag_name: 'BUTTON',
  element_id: 'submit',
  class_name: null,
  selector: '#submit',
  url: 'https://example.com/login',
  seq: 1,
  event_time: '2026-06-15T00:00:00.000Z',
  timestamp: '2026-06-15T00:00:00.000Z',
};

/** A page-side event carrying the per-document ordinal the recorder assigned. */
const pageEvent = (seq: number, selector: string): RecordedInteractionEvent => ({
  ...clickEvent,
  selector,
  seq,
});

/**
 * The ordinal of a drained event. `seq` is optional on the wire — bundles from
 * before schema_version 2 have none — but RecordingRunner assigns one to every
 * event it drains, so -1 here means the guarantee broke and the assertion fails
 * rather than silently comparing undefined.
 */
const seqOf = (e: { seq?: number }): number => e.seq ?? -1;

describe('RecordingRunner', () => {
  it('injects the recorder on start', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();

    expect(f.context.addInitScript).toHaveBeenCalledTimes(1);
  });

  /**
   * Rich capture (locator candidates, element evidence) follows browser_driven,
   * NOT the recording mode.
   *
   * A COMBINED capture — login and workflow recorded in one session, the default
   * the harness uses — is provisioned as a `login` session on purpose, so its
   * HAR stays whole for App Template registration. Gating rich capture on the
   * mode therefore turned the evidence pipeline off for exactly the captures
   * that feed browser skills, and the compiler had nothing but generated CSS
   * paths to work with.
   */
  it('captures rich evidence for a browser-driven login-mode recording', async () => {
    const f = makeFakes('https://bank.test/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login', true);
    await runner.start();

    expect(f.context.addInitScript).toHaveBeenCalledWith(expect.any(Function), { rich: true });
  });

  it('leaves a plain login recording exactly as it was', async () => {
    // The hard constraint: the non-browser recorder must not change at all.
    const f = makeFakes('https://bank.test/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();

    expect(f.context.addInitScript).toHaveBeenCalledWith(expect.any(Function), { rich: false });
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
    // Stamped with the current contract revision. Asserted against the constant
    // rather than a literal: the point is that drain() stamps what the worker
    // actually produced, and pinning a number here just breaks on every bump.
    expect(bundle.schema_version).toBe(RECORDING_SCHEMA_VERSION);
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

  it('rebases per-document ordinals onto one increasing session-global order', async () => {
    // A two-page login: the recorder's counter restarts at 1 on the second
    // document, so the raw ordinals alone would interleave the pages.
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();

    f.emit(pageEvent(1, '#user'));
    f.emit(pageEvent(2, '#next'));
    f.navigate('https://example.com/login/password');
    f.emit(pageEvent(1, '#password')); // new document — counter restarted
    f.emit(pageEvent(2, '#signin'));

    const bundle = await runner.drain();

    // `seq` is optional on the wire (pre-schema_version-2 bundles have none), so
    // assert the producer guarantee before relying on it to sort.
    const all = [...bundle.click_events, ...bundle.url_events];
    expect(all.every((e) => typeof e.seq === 'number')).toBe(true);

    const timeline = [...all].sort((a, b) => seqOf(a) - seqOf(b));
    expect(timeline.map((e) => ('selector' in e ? e.selector : e.to_url))).toEqual([
      '#user',
      '#next',
      'https://example.com/login/password',
      '#password',
      '#signin',
    ]);
    const seqs = timeline.map(seqOf);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('falls back to arrival order for events with no page-side ordinal', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();

    f.emit({ ...clickEvent, seq: undefined, selector: '#a' });
    f.emit(pageEvent(1, '#b'));

    const bundle = await runner.drain();
    expect(bundle.click_events.map((e: RecordedInteractionEvent) => e.selector)).toEqual([
      '#a',
      '#b',
    ]);
    // The runner still numbers it, from arrival order.
    expect(seqOf(bundle.click_events[0])).toBeLessThan(seqOf(bundle.click_events[1]));
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

/**
 * The login / HAR-replay recording path is frozen. Everything the workflow
 * capture adds is gated on recording_mode, and a login bundle must come out with
 * exactly the keys it always had — so the existing login compiler needs no
 * branch and cannot regress.
 */
describe('RecordingRunner — login mode is untouched', () => {
  it('attaches no popup or download listeners', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();

    expect(f.hasPageListener()).toBe(false);
    expect(f.hasDownloadListener()).toBe(false);
    expect(f.context.on).not.toHaveBeenCalled();
  });

  it('drains a bundle with no workflow-only keys', async () => {
    // schema_version IS present on login bundles — it describes what the worker
    // produced, not which mode ran, and `seq`/`event_time` were added to both
    // paths additively (with `timestamp` frozen in value and meaning). What must
    // never appear on a login bundle is a workflow-only collection.
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();
    f.emit(clickEvent);
    f.navigate('https://example.com/dashboard');

    const bundle = await runner.drain();

    expect('download_events' in bundle).toBe(false);
    expect(Object.keys(bundle).sort()).toEqual(
      ['click_events', 'cookies', 'har', 'recording_mode', 'schema_version', 'session_id', 'started_at', 'stopped_at', 'url_events'].sort(),
    );
  });

  it('does not stamp page_id on url events', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();
    f.navigate('https://example.com/dashboard');

    const bundle = await runner.drain();
    expect(bundle.url_events[0].page_id).toBeUndefined();
  });
});

describe('RecordingRunner — workflow capture', () => {
  const workflowRunner = (f: ReturnType<typeof makeFakes>) =>
    new RecordingRunner(f.page, f.context, 'sess-w', 'workflow');

  it('records downloads, the terminal step most browser skills need', async () => {
    // A blob: download never touches the network, so HAR cannot see it and the
    // click that triggered it looks like any other click.
    const f = makeFakes('https://bank.test/statements');
    const runner = workflowRunner(f);
    await runner.start();
    f.download('statement-jan.pdf', 'blob:https://bank.test/9f2c');

    const bundle = await runner.drain();

    expect(bundle.download_events).toEqual([
      expect.objectContaining({
        suggested_filename: 'statement-jan.pdf',
        url: 'blob:https://bank.test/9f2c',
        page_url: 'https://bank.test/statements',
        page_id: 0,
      }),
    ]);
  });

  it('captures interactions and navigations inside a popup', async () => {
    // Bank portals routinely open statements in a new window. Without this the
    // compiled skill stops at the click that opened it.
    const f = makeFakes('https://bank.test/accounts');
    const runner = workflowRunner(f);
    await runner.start();

    const popup = f.openPopup('https://bank.test/statement-viewer');
    popup.emit({ ...clickEvent, selector: '#export', url: 'https://bank.test/statement-viewer' });
    popup.navigate('https://bank.test/statement-viewer?fmt=pdf');
    popup.download('jan.pdf', 'https://bank.test/dl/jan.pdf');

    const bundle = await runner.drain();

    expect(bundle.click_events.map(e => e.selector)).toContain('#export');
    expect(bundle.url_events).toContainEqual(
      expect.objectContaining({ to_url: 'https://bank.test/statement-viewer?fmt=pdf', page_id: 1 }),
    );
    expect(bundle.download_events).toEqual([expect.objectContaining({ page_id: 1 })]);
  });

  it('numbers popups in open order so the compiler can tell them apart', async () => {
    const f = makeFakes('https://bank.test/accounts');
    const runner = workflowRunner(f);
    await runner.start();

    const first = f.openPopup('https://bank.test/a');
    const second = f.openPopup('https://bank.test/b');
    first.navigate('https://bank.test/a2');
    second.navigate('https://bank.test/b2');

    const bundle = await runner.drain();
    expect(bundle.url_events.find(e => e.to_url === 'https://bank.test/a2')?.page_id).toBe(1);
    expect(bundle.url_events.find(e => e.to_url === 'https://bank.test/b2')?.page_id).toBe(2);
  });

  it('stamps a schema version so old and new recordings stay distinguishable', async () => {
    const f = makeFakes('https://bank.test/accounts');
    const runner = workflowRunner(f);
    await runner.start();

    const bundle = await runner.drain();
    expect(bundle.schema_version).toBe(RECORDING_SCHEMA_VERSION);
  });

  it('detaches popup listeners on drain', async () => {
    const f = makeFakes('https://bank.test/accounts');
    const runner = workflowRunner(f);
    await runner.start();
    const popup = f.openPopup('https://bank.test/a');

    await runner.drain();

    expect(f.context.removeListener).toHaveBeenCalledWith('page', expect.any(Function));
    expect(popup.removeListener).toHaveBeenCalledWith('request', expect.any(Function));
    expect(popup.removeListener).toHaveBeenCalledWith('download', expect.any(Function));
  });

  it('drops popup capture on reset so a warm spare cannot pollute the bundle', async () => {
    const f = makeFakes('https://bank.test/accounts');
    const runner = workflowRunner(f);
    await runner.start();
    f.download('warmup.pdf', 'https://bank.test/warmup.pdf');

    runner.reset();
    const bundle = await runner.drain();

    expect(bundle.download_events).toEqual([]);
  });
});

describe('RecordingRunner — interaction outcomes', () => {
  it('attaches what happened next to a workflow interaction', async () => {
    const f = makeFakes('https://bank.test/accounts');
    const runner = new RecordingRunner(f.page, f.context, 'sess-w', 'workflow');
    await runner.start();

    // Stamped now, not with the shared fixture's fixed date: outcomes are
    // attributed within a window of the interaction, and f.navigate() stamps the
    // url event with the current clock.
    const now = new Date().toISOString();
    f.emit({ ...clickEvent, url: 'https://bank.test/accounts', event_time: now, timestamp: now });
    f.navigate('https://bank.test/statements');

    const bundle = await runner.drain();

    expect(bundle.click_events[0].outcome).toEqual(
      expect.objectContaining({ navigated: true, to_url: 'https://bank.test/statements' }),
    );
  });

  it('leaves login interactions without an outcome', async () => {
    // Derivation is workflow-only; the login compiler sees the event shape it
    // always has.
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();

    f.emit(clickEvent);
    f.navigate('https://example.com/dashboard');

    const bundle = await runner.drain();

    expect(bundle.click_events[0].outcome).toBeUndefined();
  });
});

/**
 * Warm-pool spares boot from a shared pool app hardcoded to
 * `recording_mode: 'login'`, so a session provisioned as `workflow` arrived at
 * the worker as a login one. The bundle came back mislabelled — noui carries
 * regression cover for exactly that — and, worse, every workflow-only capture
 * stayed switched off. The label was recoverable downstream; the missing capture
 * was not.
 */
describe('RecordingRunner — adopting the requested mode at bind', () => {
  it('turns on workflow capture for a spare that booted as login', async () => {
    const f = makeFakes('https://bank.test/warm');
    const runner = new RecordingRunner(f.page, f.context, 'sess-w', 'login');
    await runner.start();

    expect(f.hasPageListener()).toBe(false); // booted as login: nothing armed
    expect(f.hasDownloadListener()).toBe(false);

    runner.adoptMode('workflow');

    expect(f.hasPageListener()).toBe(true);
    expect(f.hasDownloadListener()).toBe(true);
  });

  it('stamps the bundle with the adopted mode, not the booted one', async () => {
    const f = makeFakes('https://bank.test/warm');
    const runner = new RecordingRunner(f.page, f.context, 'sess-w', 'login');
    await runner.start();
    runner.adoptMode('workflow');

    const bundle = await runner.drain();

    expect(bundle.recording_mode).toBe('workflow');
    expect(bundle.download_events).toEqual([]); // present, i.e. workflow-shaped
  });

  it('captures downloads that arrive after the mode is adopted', async () => {
    // The point of the fix: a statement download on a warm-pool session was
    // invisible, because the listener was never attached.
    const f = makeFakes('https://bank.test/warm');
    const runner = new RecordingRunner(f.page, f.context, 'sess-w', 'login');
    await runner.start();
    runner.adoptMode('workflow');

    f.download('statement.pdf', 'blob:https://bank.test/9');
    const bundle = await runner.drain();

    expect(bundle.download_events).toEqual([
      expect.objectContaining({ suggested_filename: 'statement.pdf' }),
    ]);
  });

  it('re-injects the recorder so the page upgrades to rich capture', async () => {
    const f = makeFakes('https://bank.test/warm');
    const runner = new RecordingRunner(f.page, f.context, 'sess-w', 'login');
    await runner.start();
    (f.page.evaluate as jest.Mock).mockClear();

    runner.adoptMode('workflow');

    expect(f.page.evaluate).toHaveBeenCalledWith(expect.any(Function), { rich: true });
  });

  it('is a no-op when the mode already matches', async () => {
    // A cold-path session is constructed correctly; bind must not disturb it.
    const f = makeFakes('https://bank.test/cold');
    const runner = new RecordingRunner(f.page, f.context, 'sess-w', 'workflow');
    await runner.start();
    (f.page.evaluate as jest.Mock).mockClear();

    runner.adoptMode('workflow');

    expect(f.page.evaluate).not.toHaveBeenCalled();
    expect((f.context.on as jest.Mock).mock.calls.filter((c) => c[0] === 'page')).toHaveLength(1);
  });

  it('never downgrades a workflow recording to login', async () => {
    const f = makeFakes('https://bank.test/cold');
    const runner = new RecordingRunner(f.page, f.context, 'sess-w', 'workflow');
    await runner.start();

    runner.adoptMode('login');
    const bundle = await runner.drain();

    // Downgrading would silently discard capture already taken under workflow.
    expect(bundle.recording_mode).toBe('login');
    expect(bundle.download_events).toBeUndefined();
  });
});
