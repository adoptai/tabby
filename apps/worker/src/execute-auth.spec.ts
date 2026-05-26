import * as jwt from 'jsonwebtoken';

const TEST_KEY = 'test-jwt-signing-key-minimum-32-characters-long';

describe('execute-auth JWT validation', () => {
  it('accepts a valid HS256 token', () => {
    const token = jwt.sign({ sub: 'execute-proxy', tenant_id: 't1' }, TEST_KEY, {
      algorithm: 'HS256',
      expiresIn: '2m',
    });
    const payload = jwt.verify(token, TEST_KEY, { algorithms: ['HS256'] });
    expect((payload as any).sub).toBe('execute-proxy');
  });

  it('rejects an expired token', () => {
    const token = jwt.sign({ sub: 'execute-proxy' }, TEST_KEY, {
      algorithm: 'HS256',
      expiresIn: '-1s',
    });
    expect(() => jwt.verify(token, TEST_KEY, { algorithms: ['HS256'] })).toThrow();
  });

  it('rejects a token signed with the wrong key', () => {
    const token = jwt.sign({ sub: 'execute-proxy' }, 'wrong-key-that-is-also-32-chars-long', {
      algorithm: 'HS256',
    });
    expect(() => jwt.verify(token, TEST_KEY, { algorithms: ['HS256'] })).toThrow();
  });

  it('rejects a malformed token', () => {
    expect(() => jwt.verify('not.a.token', TEST_KEY, { algorithms: ['HS256'] })).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => jwt.verify('', TEST_KEY, { algorithms: ['HS256'] })).toThrow();
  });
});
