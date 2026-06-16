import { sanitizeHar } from './har-sanitizer';

function harWith(postData: { text: string; mimeType: string }) {
  return {
    log: {
      version: '1.2',
      entries: [
        { request: { method: 'POST', url: 'https://x.com/login', postData } },
      ],
    },
  };
}

function bodyText(har: any): string {
  return har.log.entries[0].request.postData.text;
}

describe('sanitizeHar', () => {
  it('redacts password in form-urlencoded bodies', () => {
    const har = harWith({
      mimeType: 'application/x-www-form-urlencoded',
      text: 'email=alice%40x.com&password=hunter2&remember=1',
    });
    const out = bodyText(sanitizeHar(har));
    expect(out).toContain('email=alice%40x.com');
    expect(out).toContain('password=[REDACTED]');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('remember=1');
  });

  it('redacts password + otp in JSON bodies (nested)', () => {
    const har = harWith({
      mimeType: 'application/json',
      text: JSON.stringify({ user: 'a', creds: { password: 'hunter2', otp: '123456' }, keep: 1 }),
    });
    const out = JSON.parse(bodyText(sanitizeHar(har)));
    expect(out.creds.password).toBe('[REDACTED]');
    expect(out.creds.otp).toBe('[REDACTED]');
    expect(out.user).toBe('a');
    expect(out.keep).toBe(1);
  });

  it('redacts DOM-flagged field names even without a built-in pattern', () => {
    const har = harWith({
      mimeType: 'application/x-www-form-urlencoded',
      text: 'login_secret=abc&other=keep',
    });
    const out = bodyText(sanitizeHar(har, ['login_secret']));
    expect(out).toContain('login_secret=[REDACTED]');
    expect(out).toContain('other=keep');
  });

  it('leaves non-credential workflow bodies intact', () => {
    const har = harWith({
      mimeType: 'application/json',
      text: JSON.stringify({ destination: 'Lisbon', checkIn: '2026-07-01', guests: 2 }),
    });
    const out = JSON.parse(bodyText(sanitizeHar(har)));
    expect(out).toEqual({ destination: 'Lisbon', checkIn: '2026-07-01', guests: 2 });
  });

  it('handles entries with no postData and bad JSON gracefully', () => {
    const har = {
      log: {
        entries: [
          { request: { method: 'GET', url: 'https://x.com' } },
          { request: { method: 'POST', url: 'https://x.com', postData: { mimeType: 'application/json', text: '{bad json password=x' } } },
        ],
      },
    };
    const out = sanitizeHar(har);
    // regex fallback still scrubs the password-like assignment
    expect(out.log.entries[1].request.postData.text).toContain('[REDACTED]');
  });
});
