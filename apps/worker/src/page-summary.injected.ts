/**
 * Page summary reported to the model by `get_page_summary`.
 *
 * Lives in its own module, like dom-recorder.injected.ts, because what the model
 * can SEE decides what it can do — this deserves to be readable and testable
 * rather than buried inside a switch arm. The function is serialized into the
 * page by page.evaluate(), so it must stay self-contained: no outer closures, no
 * imports, no references to anything but the DOM.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export function pageSummaryScript(): any {

// What the model can SEE determines what it can do. Two failures shaped
// this, both observed on ICICI:
//
//  1. Elements used to be reported as bare {text} — no id, no test-id, no
//     selector. An agent had nothing to click with but a text string, so
//     on a page showing "download", "convert to emi" and "view more
//     transactions" it clicked the wrong one and landed in the EMI flow.
//     Every element now carries the most durable selector that resolves
//     to exactly ONE node, plus the count, so `click_element` can be used
//     instead of guessing at text.
//
//  2. Hidden elements were dropped entirely, to stop the model chasing
//     phantom modals left in the DOM by an earlier navigation. That
//     over-corrected: a bank's "past statements" accordion is display:none
//     until expanded, so the section the agent needed was invisible to it
//     and it concluded the feature did not exist. They are now REPORTED,
//     in a separate `hidden` bucket — present in the DOM, not on screen,
//     expand something to reach them. The main lists keep exactly their
//     old meaning, so nothing starts chasing phantoms by default.
const isVisible = (el: Element): boolean => {
  const e = el as HTMLElement;
  try {
    // checkVisibility() covers display:none, visibility:hidden/collapse,
    // content-visibility, and (with the flag) opacity:0. It is TRUE for
    // elements merely scrolled out of view, which is what we want —
    // "rendered", not "in the current viewport".
    const cv = (e as unknown as {
      checkVisibility?: (opts?: Record<string, boolean>) => boolean;
    }).checkVisibility;
    if (typeof cv === 'function') {
      if (!cv.call(e, { checkVisibilityCSS: true, checkOpacity: true, contentVisibilityAuto: true })) {
        return false;
      }
    } else {
      const s = window.getComputedStyle(e);
      if (
        s.display === 'none' ||
        s.visibility === 'hidden' ||
        s.visibility === 'collapse' ||
        parseFloat(s.opacity || '1') === 0
      ) {
        return false;
      }
      if (!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)) return false;
    }
    if (e.closest('[aria-hidden="true"]')) return false;
    return true;
  } catch {
    return true; // never let a visibility probe drop a real element
  }
};

const cssEsc = (v: string): string => {
  try {
    const c = (window as unknown as { CSS?: { escape?: (s: string) => string } }).CSS;
    if (c && typeof c.escape === 'function') return c.escape(v);
  } catch { /* fall through */ }
  return String(v).replace(/["\\]/g, '\\$&');
};
const countOf = (sel: string): number => {
  try { return document.querySelectorAll(sel).length; } catch { return -1; }
};

/**
 * The most durable selector that identifies this element ALONE.
 *
 * Candidates are tried most-durable first and the first one matching
 * exactly one node wins. A selector that matches several nodes is worse
 * than useless here — it is precisely how the wrong button gets clicked —
 * so it is reported with its count rather than presented as an address.
 */
const addressOf = (el: Element): { selector: string; kind: string; match_count: number } | null => {
  const e = el as HTMLElement;
  const tag = e.tagName.toLowerCase();
  const cands: Array<{ kind: string; sel: string }> = [];
  const testAttrs = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
  for (const a of testAttrs) {
    const v = e.getAttribute(a);
    if (v) { cands.push({ kind: 'testid', sel: `[${a}="${cssEsc(v)}"]` }); break; }
  }
  if (e.id) cands.push({ kind: 'id', sel: `#${cssEsc(e.id)}` });
  const name = e.getAttribute('name');
  if (name) cands.push({ kind: 'name', sel: `${tag}[name="${cssEsc(name)}"]` });
  const aria = e.getAttribute('aria-label');
  if (aria) cands.push({ kind: 'aria_label', sel: `${tag}[aria-label="${cssEsc(aria)}"]` });
  const href = e.getAttribute('href');
  if (href && tag === 'a') cands.push({ kind: 'href', sel: `a[href="${cssEsc(href)}"]` });

  let ambiguous: { selector: string; kind: string; match_count: number } | null = null;
  for (const c of cands) {
    const n = countOf(c.sel);
    if (n === 1) return { selector: c.sel, kind: c.kind, match_count: 1 };
    if (n > 1 && !ambiguous) ambiguous = { selector: c.sel, kind: c.kind, match_count: n };
  }
  return ambiguous;
};

const VISIBLE_CAP = 50;
const HIDDEN_CAP = 30;

const describe = (el: Element) => {
  const e = el as HTMLElement;
  const out: Record<string, unknown> = {
    text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    tag: e.tagName.toLowerCase(),
  };
  const addr = addressOf(e);
  if (addr) {
    out.selector = addr.selector;
    out.selector_kind = addr.kind;
    // Surfaced rather than hidden: a selector matching several nodes
    // tells the model to disambiguate, not to click blindly.
    if (addr.match_count !== 1) out.match_count = addr.match_count;
  }
  return out;
};

const describeInput = (el: Element) => {
  const i = el as HTMLInputElement;
  const out = describe(el) as Record<string, unknown>;
  out.type = i.type || '';
  out.name = i.name || '';
  out.id = i.id || '';
  out.placeholder = i.placeholder || '';
  delete out.text; // an input's textContent is meaningless
  return out;
};

const collect = (
  selector: string,
  map: (el: Element) => Record<string, unknown>,
): { shown: Record<string, unknown>[]; hidden: Record<string, unknown>[]; dropped: number } => {
  let all: Element[] = [];
  try { all = Array.prototype.slice.call(document.querySelectorAll(selector)); } catch { all = []; }
  const vis: Element[] = [];
  const hid: Element[] = [];
  for (const el of all) (isVisible(el) ? vis : hid).push(el);
  const shownEls = vis.slice(0, VISIBLE_CAP);
  const hiddenEls = hid.slice(0, HIDDEN_CAP);
  return {
    shown: shownEls.map(map),
    hidden: hiddenEls.map(map),
    // Reported, not silent. A cap that quietly truncates reads to the
    // model as "that is everything on the page".
    dropped: (vis.length - shownEls.length) + (hid.length - hiddenEls.length),
  };
};

const linkSel = 'a[href]';
const buttonSel = 'button, [role="button"], input[type="submit"]';
const inputSel = 'input, textarea, select';
const headingSel = 'h1, h2, h3';

const links = collect(linkSel, describe);
const buttons = collect(buttonSel, describe);
const inputs = collect(inputSel, describeInput);
const headings = collect(headingSel, (el) => ({
  level: el.tagName,
  text: (el as HTMLElement).textContent?.trim().slice(0, 200) || '',
}));

const droppedTotal = links.dropped + buttons.dropped + inputs.dropped + headings.dropped;

return {
  title: document.title,
  url: window.location.href,
  links: links.shown,
  buttons: buttons.shown,
  inputs: inputs.shown,
  headings: headings.shown,
  // In the DOM but not on screen — typically a collapsed accordion or a
  // closed menu. Expand or open the relevant control first; do not treat
  // these as clickable where they stand.
  hidden: {
    links: links.hidden,
    buttons: buttons.hidden,
    inputs: inputs.hidden,
    headings: headings.hidden,
  },
  truncated: droppedTotal > 0,
  truncated_count: droppedTotal,
};
}
