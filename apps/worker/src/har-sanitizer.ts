/**
 * Scrub credential material from HAR request bodies, IN THE WORKER, before the
 * bundle is drained across the pod boundary.
 *
 * The DOM recorder redacts password/OTP *values* in interaction events, but the
 * raw HAR still contains the login POST body (e.g. `password=...` or
 * `{"password":"..."}`). This sanitizer removes those, cross-referencing the
 * field names the DOM recorder flagged as password/otp plus a narrow built-in
 * pattern set. Narrow on purpose: workflow HAR feeds the API compiler, so we
 * must not nuke legitimate request params.
 */

const SENSITIVE_PATTERNS = [
  'password',
  'passwd',
  'pwd',
  'otp',
  'totp',
  'mfa',
  'one-time-code',
  'onetimecode',
  'otpcode',
  'passcode',
  'new-password',
  'current-password',
];

const REDACTED = '[REDACTED]';

function isSensitiveKey(key: string, extraNames: Set<string>): boolean {
  const k = key.toLowerCase();
  if (extraNames.has(k)) return true;
  return SENSITIVE_PATTERNS.some((p) => k.includes(p));
}

function redactJson(value: unknown, extraNames: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => redactJson(v, extraNames));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k, extraNames) ? REDACTED : redactJson(v, extraNames);
    }
    return out;
  }
  return value;
}

function redactFormUrlencoded(text: string, extraNames: Set<string>): string {
  return text
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const rawKey = pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        /* keep raw key */
      }
      return isSensitiveKey(key, extraNames) ? `${rawKey}=${REDACTED}` : pair;
    })
    .join('&');
}

function sanitizeBodyText(text: string, mimeType: string, extraNames: Set<string>): string {
  const mime = (mimeType || '').toLowerCase();
  if (mime.includes('json') || (text.trim().startsWith('{') && text.trim().endsWith('}'))) {
    try {
      return JSON.stringify(redactJson(JSON.parse(text), extraNames));
    } catch {
      /* fall through to regex */
    }
  }
  if (mime.includes('x-www-form-urlencoded') || /(^|&)[^=&]+=/.test(text)) {
    return redactFormUrlencoded(text, extraNames);
  }
  // Last-resort regex for password-like assignments in unknown body shapes.
  return text.replace(
    /("?(?:password|passwd|pwd|otp|passcode)"?\s*[:=]\s*"?)([^"&,}\s]+)/gi,
    (_m, prefix) => `${prefix}${REDACTED}`,
  );
}

/**
 * Return a sanitized copy of the HAR. `domSensitiveNames` are field names the
 * DOM recorder flagged as password/otp (lowercased).
 */
export function sanitizeHar(har: any, domSensitiveNames: Iterable<string> = []): any {
  const extraNames = new Set<string>();
  for (const n of domSensitiveNames) {
    if (n) extraNames.add(n.toLowerCase());
  }

  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) return har;

  for (const entry of entries) {
    const postData = entry?.request?.postData;
    if (postData && typeof postData.text === 'string' && postData.text.length > 0) {
      postData.text = sanitizeBodyText(postData.text, postData.mimeType || '', extraNames);
    }
  }
  return har;
}
