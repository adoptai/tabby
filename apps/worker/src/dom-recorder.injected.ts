/**
 * DOM interaction recorder injected into the page via context.addInitScript().
 *
 * This is a faithful server-side port of the NoUI extension's
 * extension/content/login-recorder.js — it captures click/input/change/submit
 * events with rich selector metadata, detects username/password/otp field
 * roles, and REDACTS password/otp values IN-POD before they leave the browser.
 *
 * Event channel: each event is POSTed as a sentinel `fetch()` to a reserved
 * path. RecordingRunner reads them via page.on('request') + postData — the SAME
 * network-capture path HAR uses, which is the only CDP channel proven to
 * survive CloakBrowser's stealth Chromium (exposeBinding bindings are stripped
 * and console forwarding is suppressed as automation fingerprints).
 *
 * The beacon is sent **same-origin** (`location.origin + REC_PATH`), NOT to an
 * off-origin sentinel host. A page's Content-Security-Policy governs where its
 * scripts may fetch, and `mode: 'no-cors'` does not exempt it: under a policy
 * like app.adopt.ai's
 *
 *     connect-src 'self' https://*.adopt.ai https://*.frontegg.com …
 *
 * every beacon to an off-origin host is refused by the browser *before* a
 * request is ever initiated, so page.on('request') never fires and the whole
 * capture comes back with zero interaction events — silently, because the
 * recorder's own fetch rejection is caught and discarded. Downstream that looks
 * identical to "the human never typed anything": NoUI's
 * split.find_login_boundary() finds no credential field, so every *combined*
 * capture of a CSP-enforcing site degrades to workflow-only and no App Template
 * is ever registered. Reproduced against the real policy: 3 events without CSP,
 * 0 with it.
 *
 * `'self'` is allowed by essentially every real connect-src (a SPA must reach
 * its own API), so a same-origin beacon survives. RecordingRunner aborts the
 * route so nothing reaches the origin server, and filters the path out of the
 * HAR. Opaque origins (about:blank, sandboxed frames) have no usable
 * location.origin and fall back to the legacy off-origin host.
 *
 * Paths are inlined as literals because the function body is serialized into
 * the page context.
 */

// Reserved beacon path. Matched by suffix, so it works under any origin.
export const REC_PATH = '/__tabby_rec__/';
export const REC_EVENT_PATH = '/__tabby_rec__/e';
export const REC_INSTALL_PATH = '/__tabby_rec__/i';
/** Playwright route glob used to abort beacons before they leave the box. */
export const REC_ROUTE_GLOB = '**/__tabby_rec__/**';
/** Fallback origin for documents with no usable origin (about:blank, sandboxed frames). */
export const REC_FALLBACK_ORIGIN = 'https://tabby-rec.local';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The function executed in the browser. Self-contained — no outer closures. */
export function domRecorderScript(): void {
  const w = window as any;
  if (w.__tabbyDomRecorder) return;

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

  // Same-origin beacon base — see the module docstring: an off-origin host is
  // refused outright by any page whose CSP declares connect-src.
  const recBase: string = (() => {
    try {
      const o = w.location && w.location.origin;
      return typeof o === 'string' && /^https?:\/\//.test(o) ? o : 'https://tabby-rec.local';
    } catch {
      return 'https://tabby-rec.local';
    }
  })();

  const emit = (data: any): void => {
    if (!send) return;
    try {
      send(recBase + '/__tabby_rec__/e', JSON.stringify(data));
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

  /**
   * The element the human actually touched.
   *
   * Events that cross a shadow boundary are RETARGETED: a listener on
   * `document` sees `e.target` as the shadow HOST, not the inner control. Any
   * login box mounted as a web component (Frontegg's
   * `#frontegg-login-box-container-default`, and most hosted-login widgets) is
   * therefore invisible to a naive `e.target` — the input handler's
   * "is this an <input>?" guard drops every keystroke, so no credential field
   * is ever recorded and NoUI concludes no login happened.
   *
   * `composedPath()[0]` is the true origin of the event and pierces OPEN
   * shadow roots. Closed roots still report only the host; nothing at this
   * layer can see inside one.
   */
  const realTarget = (e: any): any => {
    try {
      if (typeof e.composedPath === 'function') {
        const path = e.composedPath();
        if (path && path.length && path[0] && path[0].tagName) return path[0];
      }
    } catch {
      /* fall through to e.target */
    }
    return e.target;
  };

  const handleClick = (e: any): void => {
    const origin = realTarget(e);
    if (!origin) return;
    const target =
      (typeof origin.closest === 'function'
        ? origin.closest('[id], [class], a, button, input, select, textarea, [role]')
        : null) || origin;
    if (!target || !target.tagName) return;
    const at = stamp();
    emit({
      event_type: 'click',
      tag_name: target.tagName || '',
      element_id: target.id || null,
      class_name: (typeof target.className === 'string' ? target.className : '') || null,
      text_content: (target.textContent || '').trim().slice(0, 100) || null,
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
    });
  };

  const inputTimers = new WeakMap<any, any>();
  // Stamp of the FIRST keystroke in the field's current debounce burst, carried
  // across the debounce so the flushed payload can report when the human
  // actually started typing (`seq`/`event_time`) alongside its existing
  // flush-time `timestamp` — see stamp().
  const inputMarks = new WeakMap<any, { seq: number; eventTime: string }>();

  const handleInput = (e: any): void => {
    const target = realTarget(e);
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
        emit({
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
        });
      }, 500),
    );
  };

  const handleChange = (e: any): void => {
    const target = realTarget(e);
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
    emit({
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
    });
  };

  const handleSubmit = (e: any): void => {
    const form = realTarget(e);
    if (!form || (form.tagName && form.tagName.toLowerCase() !== 'form')) return;
    const at = stamp();
    emit({
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
    });
  };

  document.addEventListener('click', handleClick, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('change', handleChange, true);
  document.addEventListener('submit', handleSubmit, true);

  // Breadcrumb: proves the recorder actually ran in this document. RecordingRunner
  // logs it; if it never appears, injection itself is blocked and we must launch
  // a non-stealth browser for recording.
  if (send) send(recBase + '/__tabby_rec__/i', w.location ? String(w.location.href) : '');

  function cleanup(): void {
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleChange, true);
    document.removeEventListener('submit', handleSubmit, true);
    delete w.__tabbyDomRecorder;
  }

  w.__tabbyDomRecorder = cleanup;
}
