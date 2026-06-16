import type { BrowserContext, Page } from 'playwright';
import type {
  RecordingBundle,
  RecordingMode,
  RecordedInteractionEvent,
  RecordedUrlEvent,
} from '@browser-hitl/shared';
import { startHarCapture, stopHarCapture, cleanupHarListeners } from './har-capture';
import { REC_BEACON, REC_INSTALL_PATH, domRecorderScript } from './dom-recorder.injected';
import { sanitizeHar } from './har-sanitizer';

/**
 * Drives server-side capture for a human-operated VNC recording session:
 *  - ambient HAR (network) capture for the whole session
 *  - DOM interaction capture via an injected recorder + exposed binding
 *  - main-frame URL transition capture
 *
 * On drain() it assembles a RecordingBundle (HAR 1.2 + interaction events +
 * URL events) for the API to persist and NoUI to compile. All listeners are
 * passive — they do not navigate or mutate the page, so they never conflict
 * with the human driving via VNC.
 */
export class RecordingRunner {
  private readonly events: RecordedInteractionEvent[] = [];
  private readonly urlEvents: RecordedUrlEvent[] = [];
  private lastUrl = '';
  private readonly startedAt: string;
  private onRequest: ((req: any) => void) | null = null;
  private onFrameNavigated: ((frame: any) => void) | null = null;
  private onDomReady: (() => void) | null = null;
  private started = false;
  private installSeen = false;

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly sessionId: string,
    private readonly recordingMode: RecordingMode,
  ) {
    this.startedAt = new Date().toISOString();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Network capture for the whole session.
    startHarCapture(this.page);

    // DOM interaction capture: the injected recorder POSTs each event as a
    // sentinel fetch() to REC_BEACON. We read them off page.on('request') +
    // postData() — the same network-capture path HAR uses, which is the only
    // CDP channel that survives the stealth Chromium build (exposeBinding and
    // console forwarding are both suppressed). The beacon never reaches the
    // network (host doesn't resolve); the request-initiation event is enough.
    this.onRequest = (req: any) => {
      let url: string;
      try {
        url = typeof req?.url === 'function' ? req.url() : '';
      } catch {
        return;
      }
      if (!url.startsWith(REC_BEACON)) return;
      if (url.startsWith(REC_INSTALL_PATH)) {
        if (!this.installSeen) {
          this.installSeen = true;
          console.log('[Recording] DOM recorder installed in page');
        }
        return;
      }
      try {
        const body = typeof req.postData === 'function' ? req.postData() : '';
        if (!body) return;
        const ev = JSON.parse(body) as RecordedInteractionEvent;
        if (ev && typeof ev === 'object') this.events.push(ev);
      } catch {
        /* malformed beacon — ignore */
      }
    };
    this.page.on('request', this.onRequest);

    // Inject the recorder two ways for resilience against stealth Chromium:
    //  1. addInitScript — runs at document-start IF the build honors
    //     Page.addScriptToEvaluateOnNewDocument (anti-detect builds often don't).
    //  2. page.evaluate on every domcontentloaded — uses Runtime.evaluate, which
    //     cloak preserves. The recorder's idempotency guard makes double-inject
    //     a no-op, so whichever path works wins.
    await this.context.addInitScript(domRecorderScript);
    this.onDomReady = () => {
      this.page.evaluate(domRecorderScript).catch(() => {
        /* page navigating/closed — next domcontentloaded re-injects */
      });
    };
    this.page.on('domcontentloaded', this.onDomReady);
    this.onDomReady(); // cover the current document too

    // URL transition capture (main frame only).
    this.lastUrl = this.page.url();
    this.onFrameNavigated = (frame: any) => {
      try {
        if (frame !== this.page.mainFrame()) return;
        const to = frame.url();
        if (!to || to === this.lastUrl) return;
        this.urlEvents.push({
          from_url: this.lastUrl,
          to_url: to,
          timestamp: new Date().toISOString(),
        });
        this.lastUrl = to;
      } catch {
        /* frame detached mid-navigation — ignore */
      }
    };
    this.page.on('framenavigated', this.onFrameNavigated);

    console.log(`[Recording] started: session=${this.sessionId}, mode=${this.recordingMode}`);
  }

  /** Assemble and return the bundle. Detaches listeners (idempotent). */
  async drain(): Promise<RecordingBundle> {
    // Capture session cookies before tearing down so a workflow recording can
    // reuse this authenticated session (seeded via context.addCookies()). Best
    // effort — never fail the drain over cookies.
    let cookies: RecordingBundle['cookies'];
    try {
      cookies = (await this.context.cookies()) as RecordingBundle['cookies'];
    } catch {
      cookies = undefined;
    }

    const harResult = stopHarCapture(this.page);
    this.detach();

    const rawHar = harResult.har ?? {
      log: { version: '1.2', creator: { name: 'tabby-recording', version: '1.0' }, entries: [] },
    };

    // Drop our own sentinel beacon requests so they never reach the bundle.
    if (rawHar.log?.entries?.length) {
      rawHar.log.entries = rawHar.log.entries.filter(
        (e: any) => !String(e?.request?.url || '').startsWith(REC_BEACON),
      );
    }

    // Compliance: scrub credential material from HAR request bodies IN-POD,
    // before the bundle crosses the drain boundary. Cross-reference the field
    // names the DOM recorder flagged as password/otp.
    const sensitiveNames = new Set<string>();
    for (const ev of this.events) {
      if (ev.is_redacted || ev.field_role === 'password' || ev.field_role === 'otp') {
        if (ev.field_name) sensitiveNames.add(ev.field_name);
      }
    }
    const har = sanitizeHar(rawHar, sensitiveNames);

    console.log(
      `[Recording] drained: session=${this.sessionId}, ` +
        `har_entries=${har.log.entries.length}, events=${this.events.length}, urls=${this.urlEvents.length}, ` +
        `cookies=${cookies?.length ?? 0}, recorder_installed=${this.installSeen}`,
    );

    return {
      session_id: this.sessionId,
      recording_mode: this.recordingMode,
      started_at: this.startedAt,
      stopped_at: new Date().toISOString(),
      har,
      click_events: this.events,
      url_events: this.urlEvents,
      cookies,
    };
  }

  /** Detach all listeners. Safe to call on SIGTERM and after drain(). */
  detach(): void {
    if (this.onFrameNavigated) {
      this.page.removeListener('framenavigated', this.onFrameNavigated);
      this.onFrameNavigated = null;
    }
    if (this.onRequest) {
      this.page.removeListener('request', this.onRequest);
      this.onRequest = null;
    }
    if (this.onDomReady) {
      this.page.removeListener('domcontentloaded', this.onDomReady);
      this.onDomReady = null;
    }
    cleanupHarListeners(this.page);
  }
}
