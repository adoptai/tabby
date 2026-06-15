import type { BrowserContext, Page } from 'playwright';
import type {
  RecordingBundle,
  RecordingMode,
  RecordedInteractionEvent,
  RecordedUrlEvent,
} from '@browser-hitl/shared';
import { startHarCapture, stopHarCapture, cleanupHarListeners } from './har-capture';
import { RECORD_BINDING, domRecorderScript } from './dom-recorder.injected';
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
  private bindingRegistered = false;
  private onFrameNavigated: ((frame: any) => void) | null = null;
  private started = false;

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

    // DOM interaction capture: expose the binding first, then inject the
    // recorder so the binding exists when the script runs (all frames + future
    // navigations).
    await this.context.exposeBinding(RECORD_BINDING, (_source, ev: RecordedInteractionEvent) => {
      if (ev && typeof ev === 'object') this.events.push(ev);
    });
    this.bindingRegistered = true;
    await this.context.addInitScript(domRecorderScript);

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
  drain(): RecordingBundle {
    const harResult = stopHarCapture(this.page);
    this.detach();

    const rawHar = harResult.har ?? {
      log: { version: '1.2', creator: { name: 'tabby-recording', version: '1.0' }, entries: [] },
    };

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
        `har_entries=${har.log.entries.length}, events=${this.events.length}, urls=${this.urlEvents.length}`,
    );

    return {
      session_id: this.sessionId,
      recording_mode: this.recordingMode,
      started_at: this.startedAt,
      stopped_at: new Date().toISOString(),
      har,
      click_events: this.events,
      url_events: this.urlEvents,
    };
  }

  /** Detach all listeners. Safe to call on SIGTERM and after drain(). */
  detach(): void {
    if (this.onFrameNavigated) {
      this.page.removeListener('framenavigated', this.onFrameNavigated);
      this.onFrameNavigated = null;
    }
    cleanupHarListeners(this.page);
  }
}
