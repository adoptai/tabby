import { Page } from 'playwright';
import { EXECUTE_LIMITS } from '@browser-hitl/shared';

/**
 * Server-side HAR 1.2 capture via Playwright page listeners.
 *
 * Extracted from execute-browser-handler.ts so both the /execute/browser
 * `har_start`/`har_stop` commands and the VNC RecordingRunner share one
 * implementation. Behavior is identical to the original inline version.
 */

export interface HarEntry {
  startedDateTime: string;
  request: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    postData: Record<string, any>;
  };
  response: {
    status: number;
    statusText: string;
    headers: Array<{ name: string; value: string }>;
    content: { mimeType: string; text: string };
  };
  time: number;
}

interface HarCapture {
  entries: HarEntry[];
  requestIdMap: WeakMap<any, string>;
  pendingRequests: Map<string, { startTime: number; entry: Partial<HarEntry> }>;
  nextId: number;
  onRequest: (request: any) => void;
  onResponse: (response: any) => void;
}

const activeHarByPage = new WeakMap<Page, HarCapture>();

/** Detach any active HAR listeners on the page (idempotent). */
export function cleanupHarListeners(page: Page): void {
  const capture = activeHarByPage.get(page);
  if (capture) {
    page.removeListener('request', capture.onRequest);
    page.removeListener('response', capture.onResponse);
    activeHarByPage.delete(page);
  }
}

/** Begin capturing. Idempotent: detaches any prior listeners first. */
/**
 * Content types whose bodies no consumer of a bundle can use.
 *
 * On a bank portal these are most of the bytes and none of the meaning: an
 * image or a font tells a compiler nothing about how to drive the app, and a
 * stylesheet is the largest single response on many pages.
 */
function isUncompilableBody(mimeType: string): boolean {
  const m = (mimeType || '').toLowerCase();
  return (
    m.startsWith('image/') ||
    m.startsWith('font/') ||
    m.startsWith('video/') ||
    m.startsWith('audio/') ||
    m.startsWith('text/css') ||
    m.includes('font-woff') ||
    m.includes('octet-stream')
  );
}

export function startHarCapture(page: Page): { status: string; entry_count: number } {
  cleanupHarListeners(page);

  const entries: HarEntry[] = [];
  // Body bytes still allowed for THIS capture. Per-capture rather than global:
  // two concurrent captures should not starve each other, and the memory that
  // matters is what one drain has to stringify.
  let bodyBudgetRemaining = EXECUTE_LIMITS.MAX_HAR_BODY_TOTAL_BYTES;
  const requestIdMap = new WeakMap<any, string>();
  const pendingRequests = new Map<string, { startTime: number; entry: Partial<HarEntry> }>();
  let nextId = 0;

  const onRequest = (request: any) => {
    const url: string = request.url();
    const startTime = Date.now();
    const headers: Array<{ name: string; value: string }> = [];
    const reqHeaders = request.headers();
    for (const [name, value] of Object.entries(reqHeaders)) {
      headers.push({ name, value: String(value) });
    }

    const queryString: Array<{ name: string; value: string }> = [];
    try {
      const parsed = new URL(url);
      parsed.searchParams.forEach((v, k) => queryString.push({ name: k, value: v }));
    } catch { /* ignore invalid URLs */ }

    const postData: Record<string, any> = {};
    if (request.postData()) {
      postData.text = request.postData();
      postData.mimeType = reqHeaders['content-type'] || '';
    }

    const partial: Partial<HarEntry> = {
      startedDateTime: new Date(startTime).toISOString(),
      request: { method: request.method(), url, headers, queryString, postData },
    };
    const id = String(nextId++);
    requestIdMap.set(request, id);
    pendingRequests.set(id, { startTime, entry: partial });
  };

  const onResponse = async (response: any) => {
    const request = response.request();
    const id = requestIdMap.get(request);
    if (id === undefined) return;

    const match = pendingRequests.get(id);
    if (!match) return;
    pendingRequests.delete(id);

    const respHeaders: Array<{ name: string; value: string }> = [];
    const rawHeaders = response.headers();
    for (const [name, value] of Object.entries(rawHeaders)) {
      respHeaders.push({ name, value: String(value) });
    }

    // Body capture is BUDGETED. Holding every response of a session in memory and
    // then stringifying the lot at drain is what OOM-killed a worker mid-export,
    // losing a complete ICICI recording at the one moment nothing had been
    // written yet. What a compiler needs is the shape of a request and its
    // response; a rendered page or a webpack bundle contributes nothing and
    // costs the most.
    let bodyText = '';
    let omitted: string | undefined;
    const mimeType = rawHeaders['content-type'] || '';

    if (isUncompilableBody(mimeType)) {
      // Images, fonts, media, stylesheets: the bulk of a bank portal's traffic
      // by size and of no use to any consumer of this bundle.
      omitted = 'binary or asset body not captured';
    } else if (bodyBudgetRemaining <= 0) {
      omitted = 'body budget for this capture is spent';
    } else {
      // Consult content-length BEFORE reading. response.body() materialises the
      // whole thing, so slicing afterwards caps what we KEEP while doing nothing
      // about the peak — a 50MB asset still passed through memory in full.
      const declared = Number(rawHeaders['content-length'] || '');
      if (Number.isFinite(declared) && declared > EXECUTE_LIMITS.MAX_HAR_BODY_BYTES) {
        omitted = `body of ${declared} bytes exceeds the per-entry cap`;
      } else {
        try {
          const buf = await response.body();
          const keep = Math.min(EXECUTE_LIMITS.MAX_HAR_BODY_BYTES, bodyBudgetRemaining);
          bodyText = buf.toString('utf8').slice(0, keep);
          if (buf.length > keep) omitted = `truncated from ${buf.length} bytes`;
          bodyBudgetRemaining -= Buffer.byteLength(bodyText, 'utf8');
        } catch { /* streaming or consumed — store empty */ }
      }
    }

    const entry: HarEntry = {
      ...(match.entry as HarEntry),
      response: {
        status: response.status(),
        statusText: response.statusText(),
        headers: respHeaders,
        content: {
          mimeType,
          text: bodyText,
          // Say WHY a body is absent. Without this an omitted body and an
          // genuinely empty one look identical, and a compiler cannot tell
          // whether it is looking at the truth or at a budget decision.
          ...(omitted ? { comment: omitted } : {}),
        },
      },
      time: Date.now() - match.startTime,
    };
    entries.push(entry);
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  activeHarByPage.set(page, { entries, requestIdMap, pendingRequests, nextId, onRequest, onResponse });

  return { status: 'started', entry_count: 0 };
}

/** Stop capturing and return the assembled HAR 1.2 log (null if not active). */
export function stopHarCapture(page: Page): { status: string; entry_count: number; har: any } {
  const capture = activeHarByPage.get(page);
  if (!capture) {
    return { status: 'not_active', entry_count: 0, har: null };
  }
  const entries = capture.entries;
  cleanupHarListeners(page);

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'tabby-execute-browser', version: '1.0' },
      entries,
    },
  };
  return { status: 'stopped', entry_count: entries.length, har };
}

/** Inspect capture status without stopping. */
export function getHarStatus(page: Page): { active: boolean; entry_count: number } {
  const capture = activeHarByPage.get(page);
  if (!capture) {
    return { active: false, entry_count: 0 };
  }
  return { active: true, entry_count: capture.entries.length };
}
