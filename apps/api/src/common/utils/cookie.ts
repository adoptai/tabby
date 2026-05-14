/**
 * Parse a named cookie from the Cookie header string.
 * Returns the decoded cookie value or null if not found.
 */
export function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.split('=');
    if (k && k.trim() === name) {
      try {
        return decodeURIComponent(v.join('=').trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}
