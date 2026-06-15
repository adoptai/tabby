import { RecordingRunner } from './recording-runner';
import type { RecordedInteractionEvent } from '@browser-hitl/shared';

/**
 * Fakes for Playwright Page/Context. We capture the exposed binding and the
 * framenavigated listener so the test can drive synthetic events, then assert
 * drain() assembles a well-formed RecordingBundle.
 */
function makeFakes(initialUrl: string) {
  let bindingFn: ((source: unknown, ev: RecordedInteractionEvent) => void) | null = null;
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
    },
    removeListener: jest.fn(),
    // har-capture attaches request/response listeners; accept and ignore.
  } as unknown as import('playwright').Page;

  const context = {
    exposeBinding: jest.fn(async (_name: string, fn: typeof bindingFn) => {
      bindingFn = fn;
    }),
    addInitScript: jest.fn(async () => undefined),
  } as unknown as import('playwright').BrowserContext;

  return {
    page,
    context,
    emit: (ev: RecordedInteractionEvent) => bindingFn?.(null, ev),
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
  it('exposes the binding and injects the recorder on start', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();

    expect(f.context.exposeBinding).toHaveBeenCalledWith('__tabbyRecordEvent', expect.any(Function));
    expect(f.context.addInitScript).toHaveBeenCalledTimes(1);
  });

  it('drains a bundle with captured interaction + url events', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();

    f.emit(clickEvent);
    f.navigate('https://example.com/dashboard');

    const bundle = runner.drain();

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

  it('does not record a url event when the url is unchanged', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'workflow');
    await runner.start();

    f.navigate('https://example.com/login'); // same url
    const bundle = runner.drain();

    expect(bundle.url_events).toHaveLength(0);
  });

  it('drain detaches the framenavigated listener', async () => {
    const f = makeFakes('https://example.com/login');
    const runner = new RecordingRunner(f.page, f.context, 'sess-1', 'login');
    await runner.start();
    runner.drain();

    expect(f.page.removeListener).toHaveBeenCalledWith('framenavigated', expect.any(Function));
  });
});
