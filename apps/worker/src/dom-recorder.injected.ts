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
  const stamp = (): { seq: number; eventTime: string } => ({
    seq: ++seq,
    eventTime: new Date().toISOString(),
  });

  const getDataAttrs = (el: any): string | null => {
    const attrs: Record<string, string> = {};
    for (const attr of el.attributes || []) {
      if (attr.name.startsWith('data-')) attrs[attr.name] = attr.value;
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
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) parts.push(`[aria-label="${ariaLabel}"]`);
    else if (el.placeholder) parts.push(`[placeholder="${el.placeholder}"]`);
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

  const normText = (s: any): string => String(s || '').replace(/\s+/g, ' ').trim();

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
      const els = el.children || [];
      if (els.length === 1) {
        const inner = normText(els[0].textContent);
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
      return up || el;
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
      if (aria && aria.trim()) return aria.trim().slice(0, 120);

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
      if (alt && alt.trim()) return alt.trim().slice(0, 120);

      const title = el.getAttribute ? el.getAttribute('title') : null;
      if (title && title.trim()) return title.trim().slice(0, 120);

    
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

  const buildCandidates = (el: any): any[] => {
    const out: any[] = [];
    const add = (kind: string, value: string, matchCount: number): void => {
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

      const path = cssPath(el);
      if (path) add('css_path', path, countCss(path));
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
      placeholder: target.placeholder || null,
      aria_label: target.getAttribute ? target.getAttribute('aria-label') : null,
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
    enrich(payload, () => realTarget(e));
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
          placeholder: target.placeholder || null,
          aria_label: target.getAttribute('aria-label') || null,
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
      placeholder: target.placeholder || null,
      aria_label: target.getAttribute('aria-label') || null,
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
