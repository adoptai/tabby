import type { BrowserContext, Page } from 'playwright';
import type {
  RecordingBundle,
  RecordingMode,
  RecordedInteractionEvent,
  RecordedUrlEvent,
  RecordedDownloadEvent,
} from '@browser-hitl/shared';
import { RECORDING_SCHEMA_VERSION } from '@browser-hitl/shared';
import { startHarCapture, stopHarCapture, cleanupHarListeners } from './har-capture';
import { REC_BEACON, REC_INSTALL_PATH, domRecorderScript } from './dom-recorder.injected';
import { sanitizeHar } from './har-sanitizer';
import { stripHarPayloads } from './har-metadata';
import { deriveOutcomes } from './recording-outcomes';

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
/**
 * Rewrite every event's `seq` as 1..N in the order the rebase established.
 *
 * Ordering is preserved exactly -- this only removes the holes that
 * `seqBase + raw` leaves behind when a document does not use its whole local
 * range. Events with no usable seq keep their place at the end rather than
 * being renumbered into the middle of the run.
 */
function renumberDensely(...streams: Array<Array<{ seq?: unknown }> | undefined>): void {
  const all: Array<{ seq?: unknown }> = [];
  for (const stream of streams) {
    for (const ev of stream || []) {
      if (ev && typeof ev.seq === 'number' && Number.isFinite(ev.seq)) all.push(ev);
    }
  }
  all.sort((a, b) => (a.seq as number) - (b.seq as number));
  // old (global) seq -> new (dense) seq, so anything REFERENCING a seq can be
  // remapped alongside the seqs themselves.
  const remap = new Map<number, number>();
  for (let i = 0; i < all.length; i++) {
    remap.set(all[i].seq as number, i + 1);
    all[i].seq = i + 1;
  }
  // `supersedes` references other events by seq; compact those too, or the
  // reference survives the renumber pointing at the wrong event.
  for (const stream of streams) {
    for (const ev of stream || []) {
      const sup = (ev as any)?.supersedes;
      if (Array.isArray(sup)) {
        (ev as any).supersedes = sup
          .map((sq: unknown) => (typeof sq === 'number' ? remap.get(sq) : undefined))
          .filter((sq: unknown): sq is number => typeof sq === 'number');
      }
    }
  }
}

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

  // Session-global event ordering. The injected recorder numbers events per
  // DOCUMENT — its counter dies with the page — so a two-page login (username
  // page, then password page) would restart at 1 and a global sort on the raw
  // ordinal would interleave the pages. Each document's run is rebased onto a
  // running counter here: a raw ordinal that fails to advance means a new
  // document (or a subframe's recorder), so the base moves past everything
  // numbered so far. URL events draw from the same counter, giving consumers one
  // total order over interactions and navigations.
  //
  // Popups make documents CONCURRENT rather than sequential, which the rebase
  // handles but only down to arrival order: each switch between the main page
  // and a popup looks like a restarted counter and moves the base forward, so
  // seq stays strictly increasing and still totally orders the bundle — it just
  // orders by when the worker saw the event rather than by any cross-document
  // clock. There is no better answer available; the two documents share no
  // counter.
  private seqMax = 0;
  private seqBase = 0;
  private lastRawSeq = 0;

  // --- workflow-mode capture -------------------------------------------------
  // Only armed when recordingMode === 'workflow'. In 'login' mode none of these
  // listeners are attached and no workflow-only key reaches the bundle.
  private readonly downloadEvents: RecordedDownloadEvent[] = [];
  /** Popup pages and their listeners, so detach() can unwind them. */
  private readonly popupTeardowns: Array<() => void> = [];
  private onPopup: ((page: Page) => void) | null = null;
  /** 0 is the page the human started on; popups get 1, 2, ... in open order. */
  private nextPageId = 1;

  private get isWorkflow(): boolean {
    return this.recordingMode === 'workflow';
  }

  /**
   * Capture locator candidates and element evidence, not just the bare click.
   *
   * NOT `isWorkflow`. A COMBINED capture — one session recording the login and
   * the workflow together, which is the default the harness uses — is
   * provisioned as a `login` session on purpose: its HAR must stay whole,
   * because that is what registers the App Template (see the drain, where the
   * HAR reduction is deliberately `browserDriven && isWorkflow`). Gating rich
   * capture on the mode therefore switched the entire evidence pipeline OFF for
   * exactly the captures that need it most, and a browser skill compiled from
   * one had nothing to work with but generated CSS paths like
   * `.tabMenu>li>ul>COMPOSITE#T_WORK_LOGIN…` — no role, no text, no fallback.
   * Replay then missed, improvised, and wandered.
   *
   * `browserDriven` is the honest signal: it means "browser steps will be
   * compiled from this recording's DOM evidence", which is precisely when the
   * evidence is needed. A plain login recording leaves it false and records
   * exactly what it always did.
   */
  private get richCapture(): boolean {
    return this.isWorkflow || this.browserDriven;
  }

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly sessionId: string,
    private recordingMode: RecordingMode,
    /**
     * Build a BROWSER-DRIVEN skill from this recording. Controls only the HAR
     * reduction — see BrowserPolicy.browser_driven for why this is separate from
     * recordingMode. Defaults false: full HAR, unchanged from before it existed.
     */
    private browserDriven = false,
  ) {
    this.startedAt = new Date().toISOString();
  }

  /** Next session-global ordinal, for events we number ourselves (URL transitions). */
  private nextSeq(): number {
    this.seqMax += 1;
    // Force the next page-side ordinal to rebase past this one, whatever it is.
    this.seqBase = this.seqMax;
    this.lastRawSeq = Number.MAX_SAFE_INTEGER;
    return this.seqMax;
  }

  /** Map a page-local ordinal onto the session-global one. See seqMax/seqBase. */
  private rebaseSeq(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
      // A recorder too old to number its events, or a mangled beacon: fall back
      // to arrival order so the event still sorts where it landed.
      return this.nextSeq();
    }
    if (raw <= this.lastRawSeq) this.seqBase = this.seqMax; // counter restarted
    this.lastRawSeq = raw;
    const seq = this.seqBase + raw;
    if (seq > this.seqMax) this.seqMax = seq;
    return seq;
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
    this.onRequest = this.makeBeaconHandler();
    this.page.on('request', this.onRequest);

    // Inject the recorder two ways for resilience against stealth Chromium:
    //  1. addInitScript — runs at document-start IF the build honors
    //     Page.addScriptToEvaluateOnNewDocument (anti-detect builds often don't).
    //  2. page.evaluate on every domcontentloaded — uses Runtime.evaluate, which
    //     cloak preserves. The recorder's idempotency guard makes double-inject
    //     a no-op, so whichever path works wins.
    // Rich capture (locator candidates + element evidence) is workflow-only, so
    // the mode has to reach the page. Passed as an argument rather than read
    // from a global: the function body is serialized into the page context and
    // closes over nothing.
    // A transport CSP cannot refuse.
    //
    // The recorder's fallback is a sentinel fetch, and a frame served with
    // `connect-src 'self'` -- how banks serve their embedded apps -- blocks it,
    // so every click inside that frame was lost. A binding is installed by the
    // browser in every frame of every page and is not a network request, so a
    // page's own policy has no say in it.
    try {
      await this.context.exposeBinding('__tabbyRecEmit', (_source: any, body: string) => {
        if (typeof body === 'string' && body) this.ingest(body);
      });
    } catch {
      // Already exposed (a reused context), or unsupported: the beacon still
      // works everywhere a strict CSP is not in force.
    }
    await this.context.addInitScript(domRecorderScript, { rich: this.richCapture });
    this.onDomReady = () => {
      // Opts are read HERE, not captured at start(): a warm-pool spare boots as
      // a login recording and adopts its real mode at bind, so every re-injection
      // after that must carry the new one.
      this.page.evaluate(domRecorderScript, { rich: this.richCapture }).catch(() => {
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
          seq: this.nextSeq(),
          timestamp: new Date().toISOString(),
        });
        this.lastUrl = to;
      } catch {
        /* frame detached mid-navigation — ignore */
      }
    };
    this.page.on('framenavigated', this.onFrameNavigated);

    // Workflow-only capture. A browser skill's terminal step is usually "a file
    // arrived" or "the thing opened in a new tab", and neither is visible to the
    // capture above: a blob: download never touches the network, and every
    // listener so far is bound to a single Page.
    // richCapture, NOT isWorkflow. A combined capture is provisioned as a
    // 'login' session so its HAR stays whole, so gating downloads and popups on
    // the mode meant the default capture recorded neither. A fixture recording
    // of a click that downloads a file came back with download_events: [] and no
    // outcomes at all -- which is why no bank recording ever compiled a download
    // operation, whatever the attribution window said.
    if (this.richCapture) {
      this.attachDownloadCapture(this.page, 0);
      this.onPopup = (popup: Page) => this.attachPopupCapture(popup);
      this.context.on('page', this.onPopup);
    }

    console.log(`[Recording] started: session=${this.sessionId}, mode=${this.recordingMode}`);
  }

  /**
   * Handler for the injected recorder's sentinel-fetch beacon. Built per page so
   * popups report through the same channel as the main page — the events land in
   * one ordered list, which is what the compiler needs to reconstruct the path.
   */
  private makeBeaconHandler(): (req: any) => void {
    return (req: any) => {
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
        this.ingest(body);
      } catch {
        /* malformed beacon — ignore */
      }
    };
  }

  /** Take one serialized interaction from either transport. */
  private ingest(body: string): void {
    try {
      const ev = JSON.parse(body) as RecordedInteractionEvent;
      if (ev && typeof ev === 'object') {
        // Rebase the page-local ordinal onto the session-global counter. Runs
        // for popups as well as the main page, so one total order covers every
        // document in the recording.
        const rawSeq = ev.seq;
        ev.seq = this.rebaseSeq(rawSeq);
        // `supersedes` holds page-local ordinals from the SAME document (the
        // clicks that drove a dropdown, captured just before its change), so
        // they rebase by the SAME offset. Without this they stayed page-local
        // while everything else went global, and a select's supersedes pointed
        // at whatever unrelated events happened to hold those low numbers -- a
        // period dropdown claimed two login-page buttons.
        if (Array.isArray((ev as any).supersedes) && typeof rawSeq === 'number') {
          const delta = ev.seq - rawSeq;
          (ev as any).supersedes = (ev as any).supersedes.map((sq: unknown) =>
            typeof sq === 'number' ? sq + delta : sq,
          );
        }
        this.events.push(ev);
      }
    } catch {
      /* malformed event — ignore */
    }
  }

  /**
   * Record downloads as metadata, without awaiting the transfer.
   *
   * Deliberately never touches download.path() or .failure(): both wait for the
   * transfer to finish, and a recorder must never make the human wait or hold a
   * handle on a file the human may cancel. Name + URL + origin page is all the
   * compiler needs to emit a success condition.
   */
  private attachDownloadCapture(page: Page, pageId: number): void {
    const handler = (download: any) => {
      try {
        this.downloadEvents.push({
          url: typeof download?.url === 'function' ? download.url() : '',
          suggested_filename:
            typeof download?.suggestedFilename === 'function' ? download.suggestedFilename() : '',
          page_url: this.safeUrl(page),
          page_id: pageId,
          timestamp: new Date().toISOString(),
        });
      } catch {
        /* a download object that won't answer is not worth failing a recording */
      }
    };
    page.on('download', handler);
    this.popupTeardowns.push(() => page.removeListener('download', handler));
  }

  /**
   * Attach the full capture set to a popup / new tab.
   *
   * Bank portals routinely open statements, confirmations and secondary flows in
   * a new window. Without this the human's clicks there are invisible and the
   * compiled skill simply stops at the click that opened it.
   */
  private attachPopupCapture(popup: Page): void {
    const pageId = this.nextPageId++;

    const beacon = this.makeBeaconHandler();
    popup.on('request', beacon);
    this.popupTeardowns.push(() => popup.removeListener('request', beacon));

    // The recorder reaches popups via context.addInitScript, but stealth builds
    // do not reliably honour it — mirror the main page's re-inject on every
    // document.
    const domReady = () => {
      // Popups only exist in workflow mode, so rich capture is unconditional here.
      popup.evaluate(domRecorderScript, { rich: true }).catch(() => undefined);
    };
    popup.on('domcontentloaded', domReady);
    this.popupTeardowns.push(() => popup.removeListener('domcontentloaded', domReady));
    domReady();

    let lastUrl = this.safeUrl(popup);
    const navigated = (frame: any) => {
      try {
        if (frame !== popup.mainFrame()) return;
        const to = frame.url();
        if (!to || to === lastUrl) return;
        this.urlEvents.push({
          from_url: lastUrl,
          to_url: to,
          // Same session-global counter as the main page, so interactions and
          // navigations across every document stay in one total order.
          seq: this.nextSeq(),
          timestamp: new Date().toISOString(),
          page_id: pageId,
        });
        lastUrl = to;
      } catch {
        /* frame detached mid-navigation — ignore */
      }
    };
    popup.on('framenavigated', navigated);
    this.popupTeardowns.push(() => popup.removeListener('framenavigated', navigated));

    this.attachDownloadCapture(popup, pageId);

    console.log(`[Recording] popup attached: page_id=${pageId}, url=${lastUrl}`);
  }

  private safeUrl(page: Page): string {
    try {
      return page.url();
    } catch {
      return '';
    }
  }

  /**
   * Discard everything captured so far and start fresh. Called when a warm-pool
   * spare is bound to its real target: the spare booted + navigated to the pool
   * placeholder URL (RECORDING_POOL_WARM_URL, e.g. about:blank/example.com) while
   * warming, and that pre-bind activity would otherwise pollute the bundle —
   * most visibly, the first url_event's to_url is the placeholder, which the NoUI
   * login compiler picks as the login_url. Resetting here makes a warm capture
   * indistinguishable from a cold one (recording starts at the real target).
   *
   * lastUrl is cleared (not set to the current placeholder page) so the imminent
   * navigation to the real start_url is recorded as the first url_event.
   */
  /**
   * Adopt the mode this recording was actually requested as.
   *
   * A pooled spare boots from the shared pool app, which is hardcoded
   * `recording_mode: 'login'`, so every warm-pool session was constructed as a
   * login recording regardless of what the caller asked for. The bundle came
   * back stamped `login` — noui has regression cover for exactly that — and
   * every workflow-only capture stayed off: locator candidates, element
   * evidence, outcomes, downloads, popups, the metadata HAR reduction. The cold
   * path was always right; only the fast path lied.
   *
   * Called from bind, before the pod navigates to the real target, so nothing
   * captured under the wrong mode survives (reset() clears the pre-bind capture
   * moments later). Listeners that only exist in workflow mode are attached
   * here, since start() ran before the mode was known.
   */
  adoptMode(mode: RecordingMode | undefined, browserDriven?: boolean): void {
    const modeChanged = Boolean(mode && mode !== this.recordingMode);
    const drivenChanged =
      typeof browserDriven === 'boolean' && browserDriven !== this.browserDriven;

    // Nothing to adopt. Kept as an early return so a bind that changes nothing
    // does not tear down and reinstall the recorder in the live page.
    if (!modeChanged && !drivenChanged) return;

    if (drivenChanged) {
      this.browserDriven = browserDriven as boolean;
      console.log(`[Recording] browser_driven adopted at bind: ${browserDriven}`);
    }
    const previous = this.recordingMode;
    if (modeChanged) this.recordingMode = mode as RecordingMode;

    // Gate the rich attach on richCapture BECOMING true, not on the mode
    // changing. `browser_driven` alone turns it on -- a combined capture stays
    // in 'login' mode throughout -- and returning early on an unchanged mode
    // meant those recordings never attached download or popup capture.
    if (this.started) {
      if (this.richCapture && !this.onPopup) {
        this.attachDownloadCapture(this.page, 0);
        this.onPopup = (popup: Page) => this.attachPopupCapture(popup);
        this.context.on('page', this.onPopup);
      } else if (!this.richCapture && this.onPopup) {
        // Downgrade: a rich-warmed pool spare (browser_driven=true from boot) was
        // claimed for a login/api recording, so bind flips browser_driven off.
        // Tear the rich listeners back down so the recording is byte-identical to
        // one that booted lean -- otherwise the download/popup handlers keep
        // firing into a bundle that discards them.
        this.detachRichCapture();
      }
    }
    // The recorder in the CURRENT document was installed with the old flag. The
    // imminent navigation to the real target gets a fresh one via addInitScript /
    // domcontentloaded, but re-inject now too so a bind that does not navigate
    // (already on the target) is still upgraded — the script tears down and
    // reinstalls when `rich` differs.
    this.page.evaluate(domRecorderScript, { rich: this.richCapture }).catch(() => undefined);

    console.log(`[Recording] mode adopted at bind: ${previous} -> ${mode}`);
  }

  reset(): void {
    if (!this.started) return;
    this.events.length = 0;
    this.urlEvents.length = 0;
    this.downloadEvents.length = 0;
    this.lastUrl = '';
    this.seqMax = 0;
    this.seqBase = 0;
    this.lastRawSeq = 0;
    // Re-arm HAR capture: startHarCapture detaches the existing listeners and
    // installs fresh ones over a new (empty) entries buffer, dropping any
    // placeholder-page requests captured while the spare was warm.
    startHarCapture(this.page);
    console.log(`[Recording] reset at bind: session=${this.sessionId} (dropped pre-bind capture)`);
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
    let har = sanitizeHar(rawHar, sensitiveNames);

    // Two INDEPENDENT decisions, deliberately not merged:
    //
    // The HAR reduction is destructive and is gated on browser_driven alone. A
    // browser skill never replays a request, so the wire payloads are pure cost
    // and, on a bank portal, a serious liability. But a WORKFLOW recording of an
    // ordinary REST app compiles into a HAR-replay skill, and that compiler reads
    // exactly what the reduction empties (postData, headers, queryString) —
    // gating this on `workflow` produced silently broken replay skills.
    //
    // Outcomes are additive (a new optional field per interaction) and cost a
    // replay skill nothing, so they follow the recording mode.
    // AND isWorkflow, not browserDriven alone. A login recording's HAR is the
    // contract for building the Tabby profile — the auth plan and login_config
    // are derived from those very requests — so it must never be reduced, no
    // matter what the caller asked for. A caller building a browser skill for a
    // bank will reasonably set browser_driven on BOTH of its recordings; that
    // must not quietly destroy the login one.
    if (this.browserDriven && this.isWorkflow) {
      har = stripHarPayloads(har);
    }
    if (this.richCapture) {
      // Derived from whatever har we are actually shipping, so the outcomes and
      // the entries always agree about which requests exist.
      deriveOutcomes(this.events, this.urlEvents, this.downloadEvents, har);
    }

    console.log(
      `[Recording] drained: session=${this.sessionId}, ` +
        `har_entries=${har.log.entries.length}, events=${this.events.length}, urls=${this.urlEvents.length}, ` +
        `cookies=${cookies?.length ?? 0}, recorder_installed=${this.installSeen}`,
    );

    // Close the gaps before anyone reads this.
    //
    // `rebaseSeq` numbers a page-local ordinal as `seqBase + raw`, which orders
    // events correctly even when beacons arrive out of order -- but it skips
    // every local number a document did not use. The recorder restarts at 1 in
    // each document AND each subframe, so a long journey through a login, a
    // portal and an embedded app leaves dozens of unused numbers: one ICICI
    // capture had 25 holes in 52. Consumers cannot tell those from an event
    // that was observed and lost, which made the sequence useless as a signal
    // that a recording is incomplete -- and cost real time reading structural
    // holes as missing interactions.
    //
    // Renumbering here, not at allocation: the ordering the rebase produces is
    // the thing worth keeping, and it is only fully known once every beacon has
    // arrived. So order by the rebased value, then hand out 1..N densely.
    // Downloads carry no ordinal of their own -- they are attributed to an
    // interaction by time, not by sequence -- so they are not renumbered.
    renumberDensely(this.events, this.urlEvents);

    const bundle: RecordingBundle = {
      schema_version: RECORDING_SCHEMA_VERSION,
      session_id: this.sessionId,
      recording_mode: this.recordingMode,
      started_at: this.startedAt,
      stopped_at: new Date().toISOString(),
      har,
      click_events: this.events,
      url_events: this.urlEvents,
      cookies,
    };

    // Workflow-only addition. A 'login' bundle never carries download_events, so
    // the login compiler sees no new collection to reason about.
    if (this.richCapture) {
      bundle.download_events = this.downloadEvents;
    }

    return bundle;
  }

  /** Detach all listeners. Safe to call on SIGTERM and after drain(). */
  /**
   * Tear down ONLY the rich-capture listeners — the `context.on('page')` popup
   * handler and every download handler (main page + any popups) tracked in
   * `popupTeardowns` — leaving the base recorder (DOM events, URL transitions,
   * HAR) intact.
   *
   * Shared by detach() (full teardown at stop) and by adoptMode() when a
   * rich-warmed pool spare is claimed for a login/api recording and downgrades:
   * without this the download/popup handlers would linger, firing into a bundle
   * that (correctly) discards them, so a downgraded spare would not be
   * byte-identical to one that booted lean.
   */
  private detachRichCapture(): void {
    if (this.onPopup) {
      this.context.removeListener('page', this.onPopup);
      this.onPopup = null;
    }
    // Popup + download listeners, including the main page's download handler.
    while (this.popupTeardowns.length > 0) {
      try {
        this.popupTeardowns.pop()?.();
      } catch {
        /* page already closed — its listeners died with it */
      }
    }
  }

  detach(): void {
    this.detachRichCapture();
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
