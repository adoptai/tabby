import { redactSensitiveRequestData } from './sentry';

describe('redactSensitiveRequestData', () => {
  it('redacts login_credentials from an object body', () => {
    const event = {
      request: { data: { profile_id: 'esc@loc1', login_credentials: { username: 'u', password: 'p' } } },
    };
    const out = redactSensitiveRequestData(event);
    expect(out.request.data).toEqual({ profile_id: 'esc@loc1', login_credentials: '[redacted]' });
  });

  it('redacts inside a JSON string body', () => {
    const event = { request: { data: JSON.stringify({ password: 'p', keep: 1 }) } };
    const out = redactSensitiveRequestData(event);
    expect(JSON.parse(out.request.data as string)).toEqual({ password: '[redacted]', keep: 1 });
  });

  it('leaves bodies without sensitive keys and non-JSON bodies untouched', () => {
    const obj = { profile_id: 'x' };
    expect(redactSensitiveRequestData({ request: { data: obj } }).request.data).toBe(obj);
    expect(redactSensitiveRequestData({ request: { data: 'not json' } }).request.data).toBe('not json');
    expect(redactSensitiveRequestData({ request: undefined }).request).toBeUndefined();
  });
});
