/**
 * DOM interaction recorder injected into the page via context.addInitScript().
 *
 * This is a faithful server-side port of the NoUI extension's
 * extension/content/login-recorder.js — it captures click/input/change/submit
 * events with rich selector metadata, detects username/password/otp field
 * roles, and REDACTS password/otp values IN-POD before they leave the browser.
 *
 * Event channel: each event is POSTed as a sentinel `fetch()` to a fake host
 * (REC_BEACON). RecordingRunner reads them via page.on('request') + postData —
 * the SAME network-capture path HAR uses, which is the only CDP channel proven
 * to survive CloakBrowser's stealth Chromium (exposeBinding bindings are
 * stripped and console forwarding is suppressed as automation fingerprints).
 * The request never leaves the box: the .local host fails to resolve, but the
 * request-initiation event still fires with the body. Host/paths are inlined as
 * literals because the function body is serialized into the page context.
 */

// Sentinel beacon (kept in sync with the literals inlined in domRecorderScript).
export const REC_BEACON = 'https://tabby-rec.local/';
export const REC_EVENT_PATH = 'https://tabby-rec.local/e';
export const REC_INSTALL_PATH = 'https://tabby-rec.local/i';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The function executed in the browser. Self-contained — no outer closures. */
export function domRecorderScript(opts?: { rich?: boolean }): void {
  const w = window as any;

  // Rich capture (locator candidates + element evidence) is workflow-only. A
  // login recording emits precisely the fields it always has — same shape, same
  // beacon volume, same in-page cost — so the login compiler cannot be affected
  // by any of it.
  const rich = !!(opts && opts.rich);

  // Idempotent, EXCEPT for an upgrade. A warm-pool spare boots as a login
  // recording and only learns it is a workflow recording at bind, so a plain
  // "already installed, do nothing" guard would pin it to the mode it happened
  // to boot with and silently discard every workflow-only field. Re-entering
  // with a different `rich` tears the old listeners down and reinstalls.
  if (w.__tabbyDomRecorder) {
    if (w.__tabbyDomRecorderRich === rich) return;
    try {
      w.__tabbyDomRecorder();
    } catch {
      /* a failed teardown must not block the upgrade */
    }
  }
  w.__tabbyDomRecorderRich = rich;

  // Capture the original fetch up front so a later page override can't sever the
  // channel. Network requests are the one CDP signal the stealth build forwards.
  const send: ((url: string, body: string) => void) | null = (() => {
    try {
      const f = w.fetch;
      if (typeof f !== 'function') return null;
      const fetchFn = f.bind(w);
      return (url: string, body: string) => {
        try {
          fetchFn(url, { method: 'POST', body, mode: 'no-cors', keepalive: true }).catch(() => undefined);
        } catch {
          /* ignore */
        }
      };
    } catch {
      return null;
    }
  })();

  const emit = (data: any): void => {
    // This number is accounted for now.
    if (data && typeof data === 'object' && typeof data.seq === 'number') {
      pendingSeq.delete(data.seq);
    }
    // Prefer the Playwright binding, which CSP cannot touch.
    //
    // The fetch beacon is a network request, so a frame served with
    // `connect-src 'self'` -- which is how banks serve their embedded apps --
    // blocks it, and every click inside that frame is lost. An ICICI recording
    // came back with four clicks for a whole session for exactly this reason:
    // the statement screens live in an embedded Finacle app, and none of what
    // the human did in there was ever recorded.
    //
    // The beacon stays as the fallback: the binding is installed per context and
    // an older/odd path may not have it, and a recorder that emits nothing is
    // far worse than one that emits over a channel a strict CSP may refuse.
    try {
      const bind = (w as any).__tabbyRecEmit;
      if (typeof bind === 'function') {
        bind(JSON.stringify(data));
        return;
      }
    } catch {
      /* fall through to the beacon */
    }
    if (!send) return;
    try {
      send('https://tabby-rec.local/e', JSON.stringify(data));
    } catch {
      /* serialization failure on one event must not tear down the recorder */
    }
  };

  /**
   * Ordinal + wall clock of an interaction, captured AT EVENT TIME. Every handler
   * stamps once, up front, and carries the stamp to the payload it emits.
   *
   * These feed two ADDITIVE fields, `seq` and `event_time`. `timestamp` is not
   * sourced from here at all: every handler keeps its own original
   * `new Date().toISOString()` call, in its original position, so the value is
   * byte-identical to what the recorder emitted before this change. It therefore
   * keeps its existing meaning — the moment the payload was built, which for the
   * debounced `input` handler is the FLUSH, not the keystroke. That is exactly
   * why it cannot order the stream: a human who types a field and clicks submit
   * inside the 500ms window flushes the input after the click, so a timestamp
   * sort reconstructs "click submit" before "fill password". Consumers that need
   * order read `seq`; consumers that need the interaction's wall clock read
   * `event_time`. Nothing reading `timestamp` changes behaviour.
   *
   * For every handler but `handleInput` the two clock reads are the same
   * statement apart, so `event_time` and `timestamp` are equal in practice —
   * but only `event_time` is guaranteed to be the interaction.
   *
   * `seq` restarts at 1 in every document (and in every subframe — the recorder
   * installs per document). RecordingRunner rebases each run onto a session-global
   * counter as the beacons arrive, so consumers get a total order that survives
   * navigation and does not depend on beacon delivery order.
   */
  let seq = 0;

  //: Numbers taken but not yet emitted, and when they were taken. A handler
  //: stamps on entry and can still decide not to record -- so without this a
  //: dropped event leaves a numbered hole and nothing says it existed.
  const pendingSeq = new Map<number, string>();

  //: Longer than the input debounce (500ms), which legitimately holds a stamp
  //: across a burst of keystrokes before flushing. Anything still unemitted
  //: after this was not waiting, it was dropped.
  const ABANDONED_MS = 5000;

  /**
   * WHEN an interaction happened, and the number that records it.
   *
   * Taken at handler entry so `seq` means the order things HAPPENED -- the
   * debounced input handler flushes late, and ordering by emission would number
   * a click before the typing that preceded it.
   *
   * The cost of stamping early is that a handler which then bails burns a
   * number. One ICICI capture came back missing 5, 17, 19, 20 and 21, and the
   * single gap between the page landing and the "Credit Cards" click was the
   * gesture that opened the menu -- its absence made the skill unreplayable, and
   * nothing in the bundle said anything was missing at all. It cost a sign-in
   * and twenty minutes of an agent guessing before the hole was even noticed.
   *
   * So an abandoned number is reported rather than left silent. See sweepAbandoned.
   */
  const stamp = (): { seq: number; eventTime: string } => {
    const at = { seq: ++seq, eventTime: new Date().toISOString() };
    pendingSeq.set(at.seq, at.eventTime);
    return at;
  };

  /**
   * Report numbers that were taken and never recorded.
   *
   * A tombstone says "an interaction was observed at seq N and not kept". It
   * does not say what it was -- the handler that dropped it is the only thing
   * that knew, and it is long gone. That is still the difference between a
   * consumer being able to see that something is missing and a bundle that
   * quietly lies about being complete.
   */
  const sweepAbandoned = (): void => {
    if (!pendingSeq.size) return;
    const cutoff = Date.now() - ABANDONED_MS;
    for (const [n, when] of Array.from(pendingSeq.entries())) {
      if (Date.parse(when) > cutoff) continue;
      pendingSeq.delete(n);
      emit({
        event_type: 'dropped',
        seq: n,
        event_time: when,
        url: window.location.href,
        reason: 'observed but not recorded',
        timestamp: new Date().toISOString(),
      });
    }
  };

  const getDataAttrs = (el: any): string | null => {
    const attrs: Record<string, string> = {};
    for (const attr of el.attributes || []) {
      if (attr.name.startsWith('data-')) attrs[attr.name] = maskSensitive(attr.value);
    }
    return Object.keys(attrs).length > 0 ? JSON.stringify(attrs) : null;
  };

  const buildRichSelector = (el: any): string => {
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (testId) return `[data-testid="${testId}"]`;
    if (el.id && !/[0-9a-f]{8,}/i.test(el.id)) return `#${el.id}`;
    const tag = el.tagName.toLowerCase();
    if (el.name) return `${tag}[name="${el.name}"]`;
    const ac = el.getAttribute('autocomplete');
    if (ac && ac !== 'off') return `${tag}[autocomplete="${ac}"]`;
    const parts = [tag];
    if (el.type && tag === 'input') parts.push(`[type="${el.type}"]`);
    // A selector has to match the live DOM, so the attribute value cannot be
    // masked here — it would simply stop matching. When the value carries an
    // account/card number we therefore SKIP that strategy rather than emit a
    // selector with the number embedded in it, and fall through to the
    // structural path below. A slightly weaker selector beats a PAN in the
    // artifact.
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && maskSensitive(ariaLabel) === ariaLabel) parts.push(`[aria-label="${ariaLabel}"]`);
    else if (el.placeholder && maskSensitive(el.placeholder) === el.placeholder) {
      parts.push(`[placeholder="${el.placeholder}"]`);
    }
    if (parts.length > 1) return parts.join('');
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (classes) return `${tag}.${classes}`;
    }
    return tag;
  };

  const detectFieldRole = (el: any): string | null => {
    const type = (el.type || '').toLowerCase();
    const name = (el.name || el.id || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    const placeholder = (el.placeholder || '').toLowerCase();

    if (type === 'password') return 'password';

    const otpPatterns = ['otp', 'mfa', 'totp', '2fa', 'verification', 'one-time', 'onetime'];
    if (
      ac === 'one-time-code' ||
      otpPatterns.some((p) => name.includes(p) || ariaLabel.includes(p) || placeholder.includes(p)) ||
      (el.maxLength >= 4 && el.maxLength <= 8 && (type === 'number' || type === 'tel'))
    ) {
      return 'otp';
    }

    const usernamePatterns = ['email', 'username', 'user_name', 'userid', 'login', 'user-name'];
    if (
      type === 'email' ||
      ['email', 'username'].includes(ac) ||
      usernamePatterns.some((p) => name.includes(p) || ariaLabel.includes(p) || placeholder.includes(p))
    ) {
      return 'username';
    }
    return null;
  };

  const shouldRedact = (fieldRole: string | null): boolean =>
    fieldRole === 'password' || fieldRole === 'otp';

  // ---------------------------------------------------------------------------
  // Element evidence (workflow recordings only)
  //
  // buildRichSelector above makes a DECISION — one selector, chosen by a fixed
  // ladder, with no idea how many nodes it matches. That verdict is final: the
  // page is gone when the recording ends, so no later compiler improvement can
  // revisit it, and ambiguity only ever surfaces in production.
  //
  // Everything below records EVIDENCE instead: several ways to address the
  // element, each with the number of nodes it actually matched, plus what was
  // true about the element at that instant. The compiler picks; the choice stays
  // revisable against recordings already captured.
  //
  // `selector` and every other legacy field are untouched, so the login compiler
  // sees exactly what it always did.
  // ---------------------------------------------------------------------------

  /** Elements a human can actually act on. */
  const ACTIONABLE =
    'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],' +
    '[role="menuitem"],[role="tab"],[role="option"],[role="checkbox"],[role="radio"],' +
    '[onclick],[tabindex]:not([tabindex="-1"])';

  /**
   * Mask account/card numbers out of any text we are about to record.
   *
   * Value redaction (`shouldRedact`) only covers what the user TYPES, keyed on
   * the field's role. It cannot see numbers the page already displays, and an
   * ICICI capture leaked a full PAN into a locator that way: the card-select
   * radio's own label is "Credit Card Number Select 4315810557625005(INR) -
   * NAVJOT SINGH", so the number travelled into `text_content` and then into a
   * compiled `click_by_text` fallback in the skill artifact.
   *
   * 12-19 digits is the ISO/IEC 7812 PAN range and covers bank account numbers
   * too. Separators are allowed between digits because portals print cards
   * grouped ("4315 8105 5762 5005"). Shorter runs are left alone: dates,
   * amounts, OTP boxes and row indices are what make labels selectable, and
   * masking those would blind the locators for no privacy gain.
   *
   * Masking deliberately happens BEFORE match counting, so two cards whose
   * labels differ only by number both collapse to the same masked string and
   * the candidate is scored ambiguous rather than unique. That is the honest
   * result — the masked locator genuinely cannot tell them apart — and it stops
   * the compiler from trusting a text fallback that could pick the wrong card.
   */
  const maskSensitive = (s: string): string =>
    s.replace(/\d(?:[ .\-]?\d){11,18}/g, (m) => (m.replace(/\D/g, '').length <= 19 ? '[REDACTED]' : m));

  const normText = (s: any): string =>
    maskSensitive(String(s || '').replace(/\s+/g, ' ').trim());

  const cssEsc = (v: string): string => {
    try {
      const c = (window as any).CSS;
      if (c && typeof c.escape === 'function') return c.escape(v);
    } catch {
      /* fall through */
    }
    return String(v).replace(/["\\]/g, '\\$&');
  };

  /**
   * The element's OWN visible label — never its subtree's aggregated text.
   *
   * `textContent` concatenates every descendant, so when a click resolves to a
   * container the "label" became the whole menu: an ICICI recording compiled
   * `click_by_text "CardsCards Credit CardsForex CardPrepaid Card"`, which can
   * never match, and every replay attempt burned a 30-second timeout.
   *
   * Direct text nodes are the element's own words. A wrapper with exactly one
   * element child is still a label (`<button><span>Download</span></button>`);
   * anything with several text-bearing children is a container, and a container
   * has no label to click by.
   */
  const ownLabel = (el: any): string | null => {
    try {
      const kids = el.childNodes || [];
      // A node with no children owns whatever text it has — it is a leaf.
      if (!kids.length) {
        const leaf = normText(el.textContent);
        return leaf ? leaf.slice(0, 120) : null;
      }
      let own = '';
      for (let i = 0; i < kids.length; i++) {
        if (kids[i] && kids[i].nodeType === 3) own += kids[i].textContent || '';
      }
      own = normText(own);
      if (own) return own.slice(0, 120);
      // Children that BEAR TEXT, which is what the rule above is actually
      // about. Counting every element child instead made an icon disqualify a
      // label: ICICI's nav item is `<a><i class="icon"/><span>Credit Cards
      // </span></a>`, two children of which only one says anything, so this
      // returned null and the item was captured with NO text at all.
      //
      // The consequences ran the length of the pipeline. No text meant no text
      // candidate; a falsy ownLabel also stopped `actionableAncestor` returning
      // the element, so evidence was gathered from the nav container instead and
      // the click came out with the same positional path as the hover plus a
      // class every submenu item shares. Replay then resolved whichever match
      // came first in the document and failed "not visible" about half the time
      // -- while clicking that item BY TEXT works every time.
      const labelled = [];
      const els = el.children || [];
      for (let i = 0; i < els.length; i++) {
        if (normText(els[i].textContent)) labelled.push(els[i]);
      }
      if (labelled.length === 1) {
        const inner = normText(labelled[0].textContent);
        return inner ? inner.slice(0, 120) : null;
      }
      return null;
    } catch {
      return null;
    }
  };

  const countCss = (sel: string): number => {
    try {
      return document.querySelectorAll(sel).length;
    } catch {
      return -1; // unevaluable — distinct from 0, which means "matched nothing"
    }
  };

  const actionableList = (): any[] => {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(ACTIONABLE));
    } catch {
      return [];
    }
  };

  /**
   * The element the human actually touched. `e.target` is retargeted to the
   * shadow HOST for anything inside a web component, so a document-level
   * listener silently reports the wrong node; composedPath()[0] is the real one.
   */
  const realTarget = (e: any): any => {
    try {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
      if (path && path.length && path[0] && path[0].nodeType === 1) return path[0];
    } catch {
      /* fall through */
    }
    return e.target;
  };

  const inShadowDom = (el: any): boolean => {
    try {
      const root = el.getRootNode ? el.getRootNode() : null;
      return !!(root && root !== document && root.host);
    } catch {
      return false;
    }
  };

  /**
   * The actionable ancestor. The legacy resolution stops at the nearest element
   * with an id OR ANY CLASS, which on a modern page is usually the innermost
   * wrapper — a span inside the button rather than the button. Actionability is
   * the property that matters; "has a class" is not a proxy for it.
   */
  const actionableAncestor = (el: any): any => {
    try {
      if (el.matches && el.matches(ACTIONABLE)) return el;
      const up = el.closest ? el.closest(ACTIONABLE) : null;
      if (!up) return el;
      // Do not climb past the label.
      //
      // A menu built from bare divs has nothing for ACTIONABLE to stop on, so
      // the walk ran from the clicked `div.submenu-text` up to the whole nav
      // container. Evidence was then gathered from the container -- which holds
      // several items and therefore has no label of its own -- so "Credit Cards"
      // produced no text candidate, while `text_content`, computed from the
      // clicked element, said "Credit Cards" all along. The two disagreed about
      // which element had been clicked, and the compiled step got a positional
      // path with no text to fall back on: the hop that failed every run.
      //
      // If the ancestor cannot name itself, the control is whichever element
      // BETWEEN here and there can.
      //
      // Checking only the starting element misses the common case, because the
      // start is composedPath()[0] -- the innermost node under the pointer,
      // which for ICICI's nav is the icon `<i>` inside the link and has no text
      // at all. ACTIONABLE requires `a[href]` while an Angular routerLink
      // carries no href, so the walk sailed past the anchor to the enclosing
      // nav box and gathered evidence there: candidates held the box's ordinal
      // css_path while the event's own text_content said "Credit Cards". The
      // compiler cannot reconcile a disagreement like that -- it emitted a
      // click on the box, which opens the menu and navigates nowhere.
      //
      // Walking the chain finds the anchor, which is what a human would say
      // they clicked.
      if (!ownLabel(up)) {
        let node = el;
        while (node && node !== up) {
          if (ownLabel(node)) return node;
          node = node.parentElement;
        }
      }
      return up;
    } catch {
      return el;
    }
  };

  const implicitRole = (el: any): string | null => {
    try {
      const explicit = el.getAttribute ? el.getAttribute('role') : null;
      if (explicit) return explicit;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const t = String(el.type || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
        if (t === 'search') return 'searchbox';
        return 'textbox';
      }
      return null;
    } catch {
      return null;
    }
  };

  /** Close enough to the accessible name to be useful for getByRole/getByLabel. */
  const accessibleName = (el: any): string | null => {
    try {
      const aria = el.getAttribute ? el.getAttribute('aria-label') : null;
      if (aria && aria.trim()) return maskSensitive(aria.trim()).slice(0, 120);

      const labelledBy = el.getAttribute ? el.getAttribute('aria-labelledby') : null;
      if (labelledBy) {
        const parts: string[] = [];
        const ids = labelledBy.split(/\s+/);
        for (let i = 0; i < ids.length; i++) {
          const node = document.getElementById(ids[i]);
          if (node) parts.push(normText(node.textContent));
        }
        const joined = normText(parts.join(' '));
        if (joined) return joined.slice(0, 120);
      }

      if (el.labels && el.labels.length) {
        const t = normText(el.labels[0].textContent);
        if (t) return t.slice(0, 120);
      }

      const alt = el.getAttribute ? el.getAttribute('alt') : null;
      if (alt && alt.trim()) return maskSensitive(alt.trim()).slice(0, 120);

      const title = el.getAttribute ? el.getAttribute('title') : null;
      if (title && title.trim()) return maskSensitive(title.trim()).slice(0, 120);

    
  const tag = (el.tagName || '').toLowerCase();
      const type = String(el.type || '').toLowerCase();
      if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
        const v = normText(el.value);
        if (v) return v.slice(0, 120);
      }

      return ownLabel(el);
    } catch {
      return null;
    }
  };

  /**
   * Structural fallback. Only meaningful when nothing better exists, and its
   * match_count still tells the compiler whether it is unique.
   */
  const cssPath = (el: any): string => {
    try {
      const parts: string[] = [];
      let cur = el;
      let depth = 0;
      while (cur && cur.nodeType === 1 && depth < 8) {
        if (cur.id) {
          parts.unshift('#' + cssEsc(cur.id));
          break;
        }
        const tag = String(cur.tagName || '').toLowerCase();
        if (!tag || tag === 'html' || tag === 'body') {
          parts.unshift(tag || 'div');
          break;
        }
        const parent = cur.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const sameTag = Array.prototype.filter.call(
          parent.children,
          (c: any) => c.tagName === cur.tagName,
        );
        parts.unshift(
          sameTag.length > 1 ? tag + ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')' : tag,
        );
        cur = parent;
        depth++;
      }
      return parts.join(' > ');
    } catch {
      return '';
    }
  };

  const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

  //: Containers whose identity is their CONTENT, not their position.
  const ROW_CONTAINERS = 'tr,li,[role="row"],[role="listitem"],[role="option"]';

  /**
   * The row a control belongs to, named by what the row SAYS.
   *
   * A statement table gives every row an identical "Download" button --
   * measured on HSBCnet: 25 of them, same testid, same aria-label, same
   * accessible name. The only thing that separates them is a positional path
   * (`tbody > tr:nth-of-type(3)`), and a position is not an identity: replay it
   * next month and the same path is a different statement. Nothing captured the
   * date, which is the only thing that says WHICH statement was downloaded.
   *
   * `ownLabel` cannot help and should not: a row has several text-bearing cells,
   * so it is a container with no label of its own. That rule is right for menus
   * and wrong here, because a row's identity IS its cells.
   *
   * So: name the row by its text and the control within it, which is how a
   * person reads the table. Playwright resolves `:has-text()`, and the compiler
   * gets a locator that means "the download button in the row for 31 Jan 2025"
   * rather than "the third row".
   *
   * match_count is -1 (unevaluable): `:has-text()` is Playwright's engine, not
   * CSS, so it cannot be counted with querySelectorAll here. The contract
   * already defines -1 for exactly this.
   */
  /**
   * A selector that names a label-less container by the text it leads with.
   *
   * Classes are kept only if they look authored: Angular stamps `ng-tns-c123`,
   * `_ngcontent-x` and similar per-build noise that changes between deploys, so
   * a selector built on those is no more durable than the index it replaces.
   * If nothing authored survives, the tag alone still scopes the :has-text().
   */
  const containerLabelCandidate = (el: any): string | null => {
    try {
      const kids = el.querySelectorAll ? el.querySelectorAll('*') : [];
      let lead = '';
      // The container's own name precedes the items it reveals, so the FIRST
      // labelled descendant is the one to take. Bounded because a flyout can
      // hold a lot of nodes and this runs on every interaction.
      for (let i = 0; i < kids.length && i < 40; i++) {
        const t = ownLabel(kids[i]);
        if (t && t.length <= 40) { lead = t; break; }
      }
      if (!lead) return null;
      const raw = el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className;
      const classes = String(raw || '')
        .split(/\s+/)
        .filter((c: string) => c && !/^ng-/.test(c) && !/^_ngcontent/.test(c) && !/\d{4,}/.test(c));
      const tag = String(el.tagName || 'div').toLowerCase();
      const base = classes.length ? tag + '.' + classes.slice(0, 2).join('.') : tag;
      return base + ':has-text("' + lead.replace(/"/g, '\\"') + '")';
    } catch {
      return null;
    }
  };

  const rowScopedCandidate = (el: any, controlSel: string): string | null => {
    try {
      if (!controlSel || !el.closest) return null;
      const row = el.closest(ROW_CONTAINERS);
      if (!row || row === el) return null;
      const text = normText(row.textContent);
      // Long enough to identify a row, short enough not to be the whole table.
      if (!text || text.length < 3 || text.length > 120) return null;
      const rowTag = String(row.tagName || '').toLowerCase();
      return rowTag + ':has-text("' + text.replace(/"/g, '\\"') + '") ' + controlSel;
    } catch {
      return null;
    }
  };

  const buildCandidates = (el: any): any[] => {
    const out: any[] = [];
    const add = (kind: string, value: string, matchCount: number): void => {
      // A masked locator is a dead locator: `click_by_text "[REDACTED]"` matches
      // nothing, and `:has-text("[REDACTED]")` scopes to nothing. Emitting one
      // would spend a replay's 30-second timeout to discover that. Text-derived
      // candidates are already masked by normText/accessibleName upstream, so
      // the marker's presence is the signal that this candidate was built out of
      // an account/card number — drop it and let the structural candidates
      // (css_path, id, name) carry the element.
      if (value && value.indexOf('[REDACTED]') !== -1) return;
      if (value) out.push({ kind: kind, value: value, match_count: matchCount });
    };
    try {
      const tag = String(el.tagName || '').toLowerCase();

      for (let i = 0; i < TESTID_ATTRS.length; i++) {
        const attr = TESTID_ATTRS[i];
        const v = el.getAttribute ? el.getAttribute(attr) : null;
        if (v) {
          const sel = '[' + attr + '="' + cssEsc(v) + '"]';
          add('testid', sel, countCss(sel));
          break;
        }
      }

      // Emitted even when it looks generated. Whether "#ext-gen1234" is durable
      // is a judgement, and judgements belong in the compiler where they can be
      // improved — the recorder's job is to report that the id existed.
      if (el.id) {
        const sel = '#' + cssEsc(el.id);
        add('id', sel, countCss(sel));
      }

      if (el.name) {
        const sel = tag + '[name="' + cssEsc(el.name) + '"]';
        add('name', sel, countCss(sel));
      }

      const ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
      if (ariaLabel) {
        const sel = tag + '[aria-label="' + cssEsc(ariaLabel) + '"]';
        add('aria_label', sel, countCss(sel));
      }

      const role = implicitRole(el);
      const name = accessibleName(el);

      // role+name and text are resolved semantically at runtime (getByRole /
      // getByText), not as CSS, so count them over the actionable set — which is
      // the domain the runtime resolves against anyway.
      if (role && name) {
        let n = 0;
        const all = actionableList();
        for (let i = 0; i < all.length; i++) {
          if (implicitRole(all[i]) === role && accessibleName(all[i]) === name) n++;
        }
        add('role_name', role + '|' + name, n);
      }

      if (el.labels && el.labels.length) {
        const labelText = normText(el.labels[0].textContent);
        if (labelText) {
          let n = 0;
          const all = actionableList();
          for (let i = 0; i < all.length; i++) {
            const l = all[i].labels;
            if (l && l.length && normText(l[0].textContent) === labelText) n++;
          }
          add('label', labelText.slice(0, 120), n);
        }
      }

      // Own label only — a container's concatenated subtree is not something a
      // replay can click by text.
      const text = ownLabel(el);
      if (text) {
        let n = 0;
        const all = actionableList();
        for (let i = 0; i < all.length; i++) {
          if (ownLabel(all[i]) === text) n++;
        }
        // The element carries this label by construction, so a count of zero is
        // incoherent -- and it is what an ICICI recording produced for "Past"
        // and "download previous statement": actionableList() holds buttons,
        // links and inputs, and a bank's SPA nav is divs. The compiler reads 0
        // as "resolves to nothing" and drops the candidate, which left those
        // steps with a positional css path and no text to fall back on -- the
        // very text a hand-written skill used successfully.
        if (n === 0) n = 1;
        add('text', text, n);
      }

      // No label of its own, but it SAYS something: name it by what it says.
      //
      // A nav box holds an icon, its own name, and its whole flyout, so several
      // text-bearing children make it a container and ownLabel correctly
      // declines to name it. Its class is shared by every sibling box. With no
      // text and no distinguishing class, the only candidate left was cssPath's
      // positional `#scroll-container > div > div:nth-of-type(4)` -- which
      // encodes "the 4th box", not "the Cards box".
      //
      // That is a locator with a clock on it. An ICICI recording compiled a
      // hover on nth-of-type(4) when Cards sat 4th; the nav later shifted by one
      // and the same step hovered Deposits, so the "Credit Cards" click that
      // followed matched nothing and the whole 6-operation replay died on step
      // one.
      //
      // The container's FIRST text-bearing descendant is its own name ("Cards")
      // -- the submenu entries come after it -- and a name survives reordering
      // where an index cannot. match_count is -1 (unevaluable) because
      // :has-text() is Playwright's engine, not querySelectorAll's, exactly as
      // for row_scoped.
      if (!text) {
        const named = containerLabelCandidate(el);
        if (named) add('container_label', named, -1);
      }

      const path = cssPath(el);
      if (path) add('css_path', path, countCss(path));

      // Last, and only when the control is one of MANY identical ones: the row
      // it belongs to, named by what that row says. Built from the best
      // CSS-expressible candidate already found, so it inherits whatever the
      // page offered (testid, aria-label, name) rather than inventing anything.
      //
      // Skipped when some earlier candidate already resolves to exactly one
      // node -- that control does not need its row to be identified.
      let unique = false;
      let controlSel = '';
      for (let i = 0; i < out.length; i++) {
        const c = out[i];
        if (c.match_count === 1 && c.kind !== 'css_path') unique = true;
        if (!controlSel && c.value && c.kind !== 'css_path' && c.kind !== 'text'
            && c.kind !== 'role_name' && c.kind !== 'label') {
          controlSel = c.value;
        }
      }
      if (!unique && controlSel) {
        const scoped = rowScopedCandidate(el, controlSel);
        if (scoped) add('row_scoped', scoped, -1);
      }
    } catch {
      /* a partial candidate list beats failing the interaction */
    }
    return out;
  };

  const isVisibleEl = (el: any): boolean => {
    try {
      if (typeof el.checkVisibility === 'function') {
        if (
          !el.checkVisibility({
            checkVisibilityCSS: true,
            checkOpacity: true,
            contentVisibilityAuto: true,
          })
        ) {
          return false;
        }
      } else {
        const s = window.getComputedStyle(el);
        if (
          s.display === 'none' ||
          s.visibility === 'hidden' ||
          s.visibility === 'collapse' ||
          parseFloat(s.opacity || '1') === 0
        ) {
          return false;
        }
      }
      if (el.closest && el.closest('[aria-hidden="true"]')) return false;
      return true;
    } catch {
      return true;
    }
  };

  /**
   * Was something painted over the element's centre?
   *
   * This is the overlay-intercepted-click problem answered at the only moment it
   * is knowable. Without it the runtime can only discover an overlay by having a
   * click fail against it.
   */
  const isOccluded = (el: any, rect: any): boolean => {
    try {
      if (!rect || !rect.width || !rect.height) return false;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Outside the viewport there is nothing to be occluded BY — scrolled-away
      // is not the same as covered, and reporting it as covered would be a lie.
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
      const top = document.elementFromPoint(cx, cy);
      if (!top) return false;
      return !(top === el || (el.contains && el.contains(top)) || (top.contains && top.contains(el)));
    } catch {
      return false;
    }
  };

  const elementEvidence = (el: any): any => {
    let rect: any = null;
    try {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (r) {
        rect = {
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      }
      return {
        tag: String(el.tagName || '').toLowerCase(),
        role: implicitRole(el),
        accessible_name: accessibleName(el),
        visible: isVisibleEl(el),
        occluded: isOccluded(el, el.getBoundingClientRect ? el.getBoundingClientRect() : null),
        rect: rect,
        in_shadow_dom: inShadowDom(el),
        in_iframe: window !== window.top,
        // WHICH frame, not just whether. `addInitScript` runs the recorder in
        // every frame, so a click inside an embedded app (ICICI's statements
        // live in a Finacle iframe) was already captured — and then compiled
        // into a step no runtime could execute, because nothing said where to
        // execute it. A boolean records that the problem exists; the URL is
        // what lets a replay reach the control the human actually clicked.
        // Same-origin frames can also report their name, which survives the
        // query-string churn a URL suffers.
        frame_url: window !== window.top ? String(location.href || '') : '',
        frame_name: window !== window.top ? String(window.name || '') : '',
      };
    } catch {
      return null;
    }
  };

  /**
   * Attach evidence to an outgoing payload. No-op unless this is a workflow
   * recording, so login bundles carry exactly the fields they always did.
   */
  const enrich = (payload: any, getEl: () => any): void => {
    // Bails BEFORE calling getEl, so a login recording runs not one line of the
    // evidence path — not the resolver, not composedPath, not a DOM query. The
    // whole feature is inert there rather than merely quiet.
    if (!rich) return;
    try {
      const el = getEl();
      if (!el || !el.tagName) return;
      const act = actionableAncestor(el);
      payload.candidates = buildCandidates(act);
      const ev = elementEvidence(act);
      if (ev) payload.element = ev;
    } catch {
      /* evidence is a bonus; never let it cost us the event itself */
    }
  };

  const handleClick = (e: any): void => {
    const target =
      e.target.closest('[id], [class], a, button, input, select, textarea, [role]') || e.target;
    if (!target || !target.tagName) return;
    const at = stamp();
    const payload: any = {
      event_type: 'click',
      tag_name: target.tagName || '',
      element_id: target.id || null,
      class_name: (typeof target.className === 'string' ? target.className : '') || null,
      text_content: ownLabel(target) || null,
      href: target.href || null,
      selector: buildRichSelector(target),
      url: window.location.href,
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      input_type: target.type || null,
      autocomplete: target.getAttribute ? target.getAttribute('autocomplete') : null,
      placeholder: normText(target.placeholder) || null,
      aria_label: target.getAttribute ? normText(target.getAttribute('aria-label')) || null : null,
      role_attr: target.getAttribute ? target.getAttribute('role') : null,
      data_attrs_json: getDataAttrs(target),
      seq: at.seq,
      event_time: at.eventTime,
      // Left as the ORIGINAL clock read, in its original position, so the value
      // is byte-identical to what this handler produced before seq/event_time.
      timestamp: new Date().toISOString(),
    };
    // Evidence is gathered from the element the human really touched — through
    // any shadow root, then up to the actionable ancestor — which is often not
    // the node `selector` above describes.
    // Did the PREVIOUS click open what this one lands on? A dropdown shows its
    // current value, you click that to open it, then click the option you want.
    // The opener's label is the widget's VALUE -- "FY2024-25" -- which will read
    // differently at replay, so the compiler needs to know not to address it by
    // text. Recorded on the second click, because that is when it becomes true.
    try {
      // The previous click's PARENT, not the element itself. A dropdown's
      // option list is a SIBLING of its trigger, not a child of it: ICICI's
      // year widget put the trigger at div:nth-of-type(1) and the options at
      // div:nth-of-type(2) under one shared container, so a `contains` test on
      // the trigger never fired and the rule was inert. The shared parent is
      // what actually relates them.
      const opener = lastClickEl && lastClickEl.parentElement;
      if (opener && lastClickEl !== target && opener.contains && opener.contains(target)) {
        payload.opened_by_previous = true;
      }
    } catch {
      /* an unresolvable relation is simply not asserted */
    }
    lastClickEl = target;

    // If a hover opened what was just clicked, record the hover FIRST so a
    // replay performs them in the order that works.
    if (hoverRevealedTarget(target)) {
      emitHoverStep();
    }
    // Consumed. A reveal belongs to the click that used it, not to the next one.
    hoverTrail.length = 0;

    enrich(payload, () => realTarget(e));
    emit(payload);
  };

  /**
   * The hover that REVEALED the thing the human then clicked.
   *
   * A bank's top nav opens on hover: the human hovers "Cards", the menu appears,
   * they click "Credit Cards". Only the click was recorded, so the compiled path
   * had no step that opens the menu -- at replay the item is absent or hidden
   * and the run dead-ends on exactly the hop that has failed every time. The
   * recording could not contain what it never observed.
   *
   * Recording every mouseover would bury the bundle in mouse noise, so this
   * keeps the last hovered actionable element and emits it ONLY when the next
   * click lands on a descendant that the hover plausibly revealed -- the shape
   * of a menu, not of a mouse crossing the page. Emitted just before the click,
   * so the two arrive in the order a replay must perform them.
   */
  let lastClickEl: any = null;
  const HOVER_REVEAL_WINDOW_MS = 5000;

  // mouseover fires on EVERY pixel of mouse movement. Doing anything real here
  // -- an actionableAncestor walk, as the first version did -- runs a DOM
  // traversal thousands of times a second in the capture phase and freezes the
  // page: an ICICI recording locked up right after the nav was used. Store the
  // raw target and nothing else; the walk happens once, at click time, when we
  // actually need to know whether the hover revealed anything.
  const handleMouseOver = (e: any): void => {
    // A TRAIL, not just the last one.
    //
    // mouseover fires on every element the pointer enters, so by the time the
    // human clicks "Credit Cards" the most recent entry IS "Credit Cards" --
    // `el === clicked`, the reveal test bails, and nothing records what opened
    // the menu. It only ever passed when the pointer happened to go from the
    // opener straight to the click without touching another actionable node in
    // between, which is why the same journey recorded six times captured the
    // nav reveal twice.
    //
    // Keeping the recent path lets the reveal be found where it actually is:
    // a few elements back. Bounded hard -- this runs on raw mouse movement.
    hoverTrail.push({ el: e.target, at: Date.now() });
    if (hoverTrail.length > HOVER_TRAIL_MAX) hoverTrail.shift();
  };

  //: How much of the pointer's recent path to keep. Enough to step back over
  //: the handful of elements crossed between an opener and the item it reveals.
  const HOVER_TRAIL_MAX = 12;
  const hoverTrail: Array<{ el: any; at: number }> = [];

  /** Did a hover open something the click then used? Resolved at click time. */
  let hoverEl: any = null;
  const hoverRevealedTarget = (clicked: any): boolean => {
    hoverEl = null;
    if (!clicked) return false;
    // Newest first: the nearest thing that could have revealed the target is the
    // best answer, and walking back stops at the first one that fits.
    for (let i = hoverTrail.length - 1; i >= 0; i--) {
      if (revealedBy(hoverTrail[i], clicked)) return true;
    }
    return false;
  };

  const revealedBy = (entry: { el: any; at: number } | null, clicked: any): boolean => {
    if (!entry || !clicked) return false;
    if (Date.now() - entry.at > HOVER_REVEAL_WINDOW_MS) return false;
    try {
      const el = actionableAncestor(entry.el);
      if (!el || el === clicked) return false;
      if (el.contains && el.contains(clicked)) return false;
      // Scope is the hovered element's PARENT, not the element itself.
      //
      // A revealed menu is almost never a descendant of the thing you hovered:
      // hovering ICICI's "CARDS" opens a panel that is a SIBLING, so an
      // el.contains(clicked) test answered false and the hover was never
      // recorded -- the compiled skill then clicked "Credit Cards" on a page
      // where that text only exists once the menu is open, and every operation
      // died on its first step. The dropdown-opener rule hit this same wall and
      // was fixed the same way; this one was missed.
      const scope = el.parentElement;
      if (!scope || scope === document.body || scope === document.documentElement) {
        // A body-level scope would make every click after any hover a "reveal".
        // A menu portalled to the body is not detectable this way, and saying
        // nothing is better than flagging everything.
        return false;
      }
      if (!(scope.contains && scope.contains(clicked))) return false;
      hoverEl = el;
      return true;
    } catch {
      return false;
    }
  };

  const emitHoverStep = (): void => {
    const el = hoverEl;
    if (!el) return;
    const at = stamp();
    const payload: any = {
      event_type: 'hover',
      tag_name: el.tagName || '',
      element_id: el.id || null,
      class_name: (typeof el.className === 'string' ? el.className : '') || null,
      text_content: ownLabel(el) || null,
      selector: buildRichSelector(el),
      url: window.location.href,
      seq: at.seq,
      event_time: at.eventTime,
      timestamp: new Date().toISOString(),
    };
    enrich(payload, () => el);
    emit(payload);
  };

  const inputTimers = new WeakMap<any, any>();
  // Stamp of the FIRST keystroke in the field's current debounce burst, carried
  // across the debounce so the flushed payload can report when the human
  // actually started typing (`seq`/`event_time`) alongside its existing
  // flush-time `timestamp` — see stamp().
  const inputMarks = new WeakMap<any, { seq: number; eventTime: string }>();

  const handleInput = (e: any): void => {
    const target = e.target;
    if (!target || !target.tagName) return;
    const tag = target.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return;

    let mark = inputMarks.get(target);
    if (!mark) {
      mark = stamp();
      inputMarks.set(target, mark);
    }
    const at = mark;

    const existing = inputTimers.get(target);
    if (existing) clearTimeout(existing);

    inputTimers.set(
      target,
      setTimeout(() => {
        inputTimers.delete(target);
        inputMarks.delete(target); // next burst on this field starts a new stamp
        const fieldRole = detectFieldRole(target);
        const redact = shouldRedact(fieldRole);
        const rawValue = (target.value || '').slice(0, 500);
        const payload: any = {
          event_type: 'input',
          tag_name: target.tagName || '',
          element_id: target.id || null,
          class_name: (typeof target.className === 'string' ? target.className : '') || null,
          selector: buildRichSelector(target),
          url: window.location.href,
          input_type: target.type || 'text',
          value: redact ? '[REDACTED]' : rawValue,
          field_name: target.name || target.id || null,
          field_role: fieldRole,
          is_redacted: redact,
          autocomplete: target.getAttribute('autocomplete') || null,
          placeholder: normText(target.placeholder) || null,
          aria_label: normText(target.getAttribute('aria-label')) || null,
          role_attr: target.getAttribute('role') || null,
          data_attrs_json: getDataAttrs(target),
          seq: at.seq,
          event_time: at.eventTime,
          // Flush time, NOT the keystroke — preserved verbatim so every existing
          // consumer of this field is untouched. Order by `seq` instead.
          timestamp: new Date().toISOString(),
        };
        // A field IS the actionable element, so no ancestor walk is needed —
        // but evidence is still gathered at FLUSH time, i.e. after the human
        // finished typing, which is when the field's state is worth recording.
        enrich(payload, () => target);
        emit(payload);
      }, 500),
    );
  };

  const handleChange = (e: any): void => {
    const target = e.target;
    if (!target || !target.tagName) return;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' && !['checkbox', 'radio'].includes(target.type)) return;
    if (tag !== 'select' && tag !== 'input') return;

    const at = stamp();
    const fieldRole = detectFieldRole(target);
    const redact = shouldRedact(fieldRole);
    let val: string;
    if (target.type === 'checkbox' || target.type === 'radio') {
      val = target.checked ? 'checked' : 'unchecked';
    } else {
      val = redact ? '[REDACTED]' : (target.value || '').slice(0, 500);
    }
    const payload: any = {
      event_type: 'change',
      tag_name: target.tagName || '',
      element_id: target.id || null,
      class_name: (typeof target.className === 'string' ? target.className : '') || null,
      selector: buildRichSelector(target),
      url: window.location.href,
      input_type: target.type || tag,
      value: val,
      field_name: target.name || target.id || null,
      field_role: fieldRole,
      is_redacted: redact,
      autocomplete: target.getAttribute('autocomplete') || null,
      placeholder: normText(target.placeholder) || null,
      aria_label: normText(target.getAttribute('aria-label')) || null,
      role_attr: target.getAttribute('role') || null,
      data_attrs_json: getDataAttrs(target),
      seq: at.seq,
      event_time: at.eventTime,
      timestamp: new Date().toISOString(), // original clock read, original position
    };
    enrich(payload, () => target);
    emit(payload);
  };

  const handleSubmit = (e: any): void => {
    const form = e.target;
    if (!form || (form.tagName && form.tagName.toLowerCase() !== 'form')) return;
    const at = stamp();
    const payload: any = {
      event_type: 'submit',
      tag_name: 'FORM',
      element_id: form.id || null,
      class_name: (typeof form.className === 'string' ? form.className : '') || null,
      selector: buildRichSelector(form),
      url: window.location.href,
      input_type: 'form',
      value: form.action || null,
      field_name: form.name || form.id || null,
      field_role: null,
      is_redacted: false,
      data_attrs_json: null,
      seq: at.seq,
      event_time: at.eventTime,
      timestamp: new Date().toISOString(), // original clock read, original position
    };
    // The form's submit BUTTON is what a skill has to click, so evidence is
    // gathered from it rather than from the form element. Resolved lazily inside
    // enrich() and defensively: a form that answers neither `submitter` nor
    // querySelector must still produce the event.
    enrich(payload, () => {
      if (e.submitter) return e.submitter;
      if (typeof form.querySelector === 'function') {
        return form.querySelector('[type="submit"]') || form;
      }
      return form;
    });
    emit(payload);
  };

  document.addEventListener('mouseover', handleMouseOver, true);
  // Report abandoned numbers on a timer rather than at teardown: a recording
  // ends by navigation or by the pod going away, and neither is a moment this
  // script reliably gets. A sweep every few seconds means a gap is visible in
  // the bundle even if the page never unloads cleanly.
  setInterval(sweepAbandoned, ABANDONED_MS);

  document.addEventListener('click', handleClick, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('change', handleChange, true);
  document.addEventListener('submit', handleSubmit, true);

  // Breadcrumb: proves the recorder actually ran in this document. RecordingRunner
  // logs it; if it never appears, injection itself is blocked and we must launch
  // a non-stealth browser for recording.
  if (send) send('https://tabby-rec.local/i', w.location ? String(w.location.href) : '');

  function cleanup(): void {
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleChange, true);
    document.removeEventListener('submit', handleSubmit, true);
    delete w.__tabbyDomRecorder;
    delete w.__tabbyDomRecorderRich;
  }

  w.__tabbyDomRecorder = cleanup;
}
