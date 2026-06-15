/**
 * DOM interaction recorder injected into the page via context.addInitScript().
 *
 * This is a faithful server-side port of the NoUI extension's
 * extension/content/login-recorder.js — it captures click/input/change/submit
 * events with rich selector metadata, detects username/password/otp field
 * roles, and REDACTS password/otp values IN-POD before they leave the browser.
 *
 * Instead of chrome.runtime.sendMessage it calls window[RECORD_BINDING], an
 * async binding exposed via context.exposeBinding() in RecordingRunner. The
 * binding name is referenced as a literal inside the injected function because
 * the function body is serialized and executed in the browser context.
 *
 * addInitScript runs on every navigation and in every frame, so listeners are
 * re-attached against each fresh document automatically — the SPA re-injection
 * the extension handled manually comes for free.
 */

export const RECORD_BINDING = '__tabbyRecordEvent';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The function executed in the browser. Self-contained — no outer closures. */
export function domRecorderScript(): void {
  const w = window as any;
  if (w.__tabbyDomRecorder) return;

  const emit = (data: any): void => {
    try {
      const fn = w.__tabbyRecordEvent;
      if (typeof fn === 'function') fn(data);
    } catch {
      cleanup();
    }
  };

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

  const handleClick = (e: any): void => {
    const target =
      e.target.closest('[id], [class], a, button, input, select, textarea, [role]') || e.target;
    if (!target || !target.tagName) return;
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
      timestamp: new Date().toISOString(),
    });
  };

  const inputTimers = new WeakMap<any, any>();

  const handleInput = (e: any): void => {
    const target = e.target;
    if (!target || !target.tagName) return;
    const tag = target.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return;

    const existing = inputTimers.get(target);
    if (existing) clearTimeout(existing);

    inputTimers.set(
      target,
      setTimeout(() => {
        inputTimers.delete(target);
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
          timestamp: new Date().toISOString(),
        });
      }, 500),
    );
  };

  const handleChange = (e: any): void => {
    const target = e.target;
    if (!target || !target.tagName) return;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' && !['checkbox', 'radio'].includes(target.type)) return;
    if (tag !== 'select' && tag !== 'input') return;

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
      timestamp: new Date().toISOString(),
    });
  };

  const handleSubmit = (e: any): void => {
    const form = e.target;
    if (!form || (form.tagName && form.tagName.toLowerCase() !== 'form')) return;
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
      timestamp: new Date().toISOString(),
    });
  };

  document.addEventListener('click', handleClick, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('change', handleChange, true);
  document.addEventListener('submit', handleSubmit, true);

  function cleanup(): void {
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleChange, true);
    document.removeEventListener('submit', handleSubmit, true);
    delete w.__tabbyDomRecorder;
  }

  w.__tabbyDomRecorder = cleanup;
}
