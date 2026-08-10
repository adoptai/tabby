import type {
  RecordedInteractionEvent,
  RecordedUrlEvent,
  RecordedDownloadEvent,
  RecordingHar,
} from '@browser-hitl/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * How long after an interaction we still attribute what happens to it.
 *
 * Long enough for a bank SPA to route, fetch and settle; short enough that idle
 * time between two human actions is not credited to the first one. The window
 * is additionally truncated at the NEXT interaction (see below), so this is a
 * ceiling rather than a fixed span.
 */
export const OUTCOME_WINDOW_MS = 2500;

/**
 * How long after an interaction a DOWNLOAD is still attributed to it.
 *
 * Downloads get their own, far longer budget because they are a different kind
 * of evidence. Request noise needs a tight window — half the clicks on a bank
 * portal fire XHRs, and crediting them all to one click says nothing. A file
 * arriving is rare and unambiguous: it happens a handful of times in a
 * recording, and the last thing the human clicked is the only plausible cause.
 *
 * At 2500ms the compiler emitted no download operation for ANY bank recording,
 * because a statement PDF is generated server-side and arrives five to thirty
 * seconds after the click. `_terminal_kind` saw no outcome.download, derived no
 * terminal operation, and the skill came out as read-only — which is how an
 * ICICI capture compiled to `read_overview` + `read_credit_card` for a session
 * whose whole point was downloading a statement.
 */
export const DOWNLOAD_WINDOW_MS = 120_000;

/**
 * Attach to each interaction what actually happened next.
 *
 * Without this the compiler has to INFER causality — which click caused which
 * navigation — from bare timestamps, which is why `browser_skill.py` grew
 * `_resolve_nav_chains` and a fallback for when it cannot tell. The recorder is
 * the only place that can answer it cheaply, and an outcome is also exactly what
 * a compiled step needs as its postcondition: "after this click, the URL becomes
 * X" is the assertion that lets a runtime agent know within one step that it is
 * off-route, instead of discovering it five clicks later on the wrong page.
 *
 * Derived at drain rather than tracked live: everything needed is already in the
 * bundle, and a pure function over the collected events is far easier to reason
 * about than another set of stateful listeners racing the human.
 *
 * Mutates `events` in place, attaching `outcome`. Interactions whose time cannot
 * be parsed are left without one — an absent outcome means "not known", which is
 * honest, where a zeroed one would read as "nothing happened".
 */
/** Words that name a control which STARTS a download, in its own label. */
const DOWNLOAD_WORDS =
  /\b(download|export|generate|e-?statement|statement|pdf|csv|xls|receipt|invoice)\b/i;

/**
 * Does this interaction's own label say it starts a download?
 *
 * Used only to break ties between several clicks preceding one file. Kept
 * narrow and label-only: it never CREATES an attribution, it only picks the
 * better of candidates already inside the window.
 */
function looksLikeDownloadControl(ev: { text_content?: string | null }): boolean {
  return DOWNLOAD_WORDS.test(String(ev.text_content || ''));
}

export function deriveOutcomes(
  events: RecordedInteractionEvent[],
  urlEvents: RecordedUrlEvent[],
  downloads: RecordedDownloadEvent[],
  har: RecordingHar,
): void {
  const at = (e: { event_time?: string; timestamp?: string }): number => {
    // event_time is the interaction; timestamp is when the payload was built,
    // which for the debounced input handler is up to 500ms later. Prefer the
    // former, fall back for bundles predating it.
    const raw = e.event_time || e.timestamp || '';
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? NaN : ms;
  };

  const timed = events
    .map((ev, index) => ({ ev, index, t: at(ev) }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);

  const urls = urlEvents
    .map((u) => ({ u, t: Date.parse(u.timestamp || '') }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);

  const dls = downloads
    .map((d) => Date.parse(d.timestamp || ''))
    .filter((t) => !Number.isNaN(t));

  const entries = ((har?.log?.entries || []) as any[])
    .map((e) => {
      const start = Date.parse(e?.startedDateTime || '');
      const dur = typeof e?.time === 'number' && e.time >= 0 ? e.time : 0;
      return { start, end: start + dur };
    })
    .filter((e) => !Number.isNaN(e.start));

  // Assign each download to the LAST interaction at or before it, rather than
  // asking of each click "did a file arrive in my window". Truncating at the
  // next interaction is right for traffic and wrong for files: a human waiting
  // on a slow export clicks other things while it generates, and that must not
  // orphan the download. One owner per file, so two clicks never both claim it.
  const downloadOwner = new Map<number, boolean>();
  for (const d of dls) {
    // Candidates: every interaction inside the budget before the file arrived.
    const before: number[] = [];
    for (let i = 0; i < timed.length; i++) {
      if (timed[i].t > d) break;
      if (d - timed[i].t <= DOWNLOAD_WINDOW_MS) before.push(i);
    }
    if (before.length === 0) continue;

    // The most recent click is usually the cause -- an "Export" that opens a
    // dialog is finished by the "Confirm" inside it. But a human waiting on a
    // slow export also dismisses banners and closes dialogs, and crediting one
    // of THOSE yields an operation named "close" that reproduces nothing. So
    // prefer the most recent candidate whose own label says it starts a
    // download, and fall back to the most recent when none does.
    const labelled = before.filter((i) => looksLikeDownloadControl(timed[i].ev));
    const owner = labelled.length > 0 ? labelled[labelled.length - 1] : before[before.length - 1];
    downloadOwner.set(owner, true);
  }

  for (let i = 0; i < timed.length; i++) {
    const { ev, t } = timed[i];

    // Truncate at the next interaction: whatever happens after the human's next
    // action belongs to THAT action, not this one. Without this a slow page
    // credits its traffic to every click that preceded it.
    const nextT = i + 1 < timed.length ? timed[i + 1].t : Infinity;
    const end = Math.min(t + OUTCOME_WINDOW_MS, nextT);

    const inWindow = (x: number): boolean => x >= t && x <= end;

    const nav = urls.find((x) => inWindow(x.t));
    const fired = entries.filter((e) => inWindow(e.start));



    let settled: number | null = null;
    if (fired.length > 0) {
      let last = 0;
      for (const f of fired) if (f.end > last) last = f.end;
      settled = Math.max(0, Math.round(last - t));
    }

    ev.outcome = {
      navigated: !!nav,
      to_url: nav ? nav.u.to_url : null,
      request_count: fired.length,
      settled_ms: settled,
      download: downloadOwner.get(i) === true,
    };
  }
}
